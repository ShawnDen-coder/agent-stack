import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import semver from "semver";
import { z } from "zod";
import { downloadNpm, inspectNpmArchive } from "./npm-archive.js";
import { stagedTreeDigest } from "./staged-tree.js";

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  engines: z.object({ node: z.string().optional() }).optional(),
});
const lockSchema = z.object({
  lockfileVersion: z.literal(3),
  packages: z.record(
    z.string(),
    z
      .object({
        version: z.string().optional(),
        resolved: z.string().optional(),
        integrity: z.string().optional(),
        link: z.boolean().optional(),
      })
      .passthrough(),
  ),
});

async function bounded(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Invalid staged metadata");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function command(
  path: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeout: number,
) {
  if (signal.aborted) throw new Error("Cancelled");
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(path, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let size = 0,
      output = "",
      failure: Error | undefined;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const abort = () => {
      failure = new Error("Cancelled");
      kill();
    };
    const timer = setTimeout(() => {
      failure = new Error("npm staging timed out");
      kill();
    }, timeout);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          failure = new Error("npm staging output limit exceeded");
          kill();
        } else if (stream === child.stdout) output += chunk.toString("utf8");
      });
    child.once("error", () => {
      failure = new Error("Cannot execute npm");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure || code !== 0)
        reject(failure ?? new Error("npm staging failed"));
      else resolve(output);
    });
  });
}

// Caller owns and journals the empty staging directory. This function does not publish it.
export async function stagePi(input: {
  stage: string;
  npm: string;
  node: { path: string; version: string };
  version: string;
  url: string;
  integrity: string;
  signal: AbortSignal;
}) {
  if (
    process.platform !== "darwin" ||
    !isAbsolute(input.stage) ||
    !isAbsolute(input.npm) ||
    !isAbsolute(input.node.path) ||
    basename(input.node.path) !== "node" ||
    !semver.valid(input.node.version) ||
    !semver.satisfies(input.node.version, ">=24.0.0")
  )
    throw new Error("Pi staging requires native macOS and absolute paths");
  if ((await readdir(input.stage)).length)
    throw new Error("Pi staging directory is not empty");
  const data = await downloadNpm(input.url, input.integrity, input.signal);
  const archiveInfo = await inspectNpmArchive(
    data,
    {
      name: "@earendil-works/pi-coding-agent",
      version: input.version,
      node: input.node.version,
    },
    input.signal,
  );
  if (
    typeof archiveInfo.metadata.bin !== "object" ||
    archiveInfo.metadata.bin.pi !== "dist/bundle/cli.js"
  )
    throw new Error("Unsupported Pi entrypoint");
  const archive = join(input.stage, "pi.tgz");
  const write = async (name: string, bytes: string | Buffer) => {
    const file = await open(join(input.stage, name), "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  };
  await write("pi.tgz", data);
  await write("package.json", JSON.stringify({ private: true }));
  await write("user.npmrc", "");
  await write("global.npmrc", "");
  await mkdir(join(input.stage, "cache"), { mode: 0o700 });
  const env = {
    PATH: `${dirname(input.node.path)}:/usr/bin:/bin`,
    HOME: input.stage,
    TMPDIR: input.stage,
    npm_config_userconfig: join(input.stage, "user.npmrc"),
    npm_config_globalconfig: join(input.stage, "global.npmrc"),
    npm_config_cache: join(input.stage, "cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_update_notifier: "false",
  };
  const nodeVersion = (
    await command(
      input.node.path,
      ["--version"],
      input.stage,
      env,
      input.signal,
      10000,
    )
  ).trim();
  if (nodeVersion !== `v${input.node.version}`)
    throw new Error("External Node version changed after planning");
  const npmVersion = (
    await command(
      input.npm,
      ["--version"],
      input.stage,
      env,
      input.signal,
      10000,
    )
  ).trim();
  if (npmVersion !== "11.12.1")
    throw new Error("Unsupported npm staging version");
  await command(
    input.npm,
    [
      "install",
      "--ignore-scripts",
      "--engine-strict",
      "--no-audit",
      "--no-fund",
      "--global=false",
      "--prefix",
      input.stage,
      archive,
    ],
    input.stage,
    env,
    input.signal,
    180000,
  );
  const lockBytes = await bounded(
    join(input.stage, "package-lock.json"),
    16 * 1024 * 1024,
  );
  const lock = lockSchema.parse(JSON.parse(lockBytes.toString("utf8")));
  const root = await realpath(input.stage);
  const piKey = "node_modules/@earendil-works/pi-coding-agent";
  if (lock.packages[piKey]?.version !== input.version)
    throw new Error("Installed Pi lock identity mismatch");
  for (const [key, record] of Object.entries(lock.packages)) {
    if (!key) continue;
    if (
      record.link ||
      !key.startsWith("node_modules/") ||
      key.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Unsupported installed npm package path");
    const dir = join(input.stage, ...key.split("/"));
    const info = await lstat(dir);
    const actual = await realpath(dir);
    if (
      !info.isDirectory() ||
      (actual !== root &&
        (relative(root, actual).startsWith(`..${sep}`) ||
          relative(root, actual) === ".."))
    )
      throw new Error("Installed npm package escapes staging");
    const manifest = manifestSchema.parse(
      JSON.parse(
        (await bounded(join(dir, "package.json"), 1024 * 1024)).toString(
          "utf8",
        ),
      ),
    );
    if (
      manifest.version !== record.version ||
      (manifest.engines?.node &&
        (!semver.validRange(manifest.engines.node) ||
          !semver.satisfies(input.node.version, manifest.engines.node)))
    )
      throw new Error("Installed npm package version or engines mismatch");
    if (key === piKey && manifest.name !== "@earendil-works/pi-coding-agent")
      throw new Error("Installed Pi identity mismatch");
  }
  // Check the filesystem as well as the lock: unlisted packages are not evidence
  // of the installed tree and must not be published as part of this stage.
  let count = 0;
  const scanModules = async (
    modules: string,
    prefix: string,
  ): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(modules);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of entries) {
      if (name === ".bin" || name === ".package-lock.json") continue;
      const names = name.startsWith("@")
        ? (await readdir(join(modules, name))).map(
            (child) => `${name}/${child}`,
          )
        : [name];
      for (const item of names) {
        if (
          ++count > 50000 ||
          item.split("/").some((part) => !part || part === "." || part === "..")
        )
          throw new Error("Invalid installed npm tree");
        const key = `${prefix}node_modules/${item}`;
        if (!lock.packages[key])
          throw new Error("Installed npm package absent from lock");
        await scanModules(join(modules, item, "node_modules"), `${key}/`);
      }
    }
  };
  await scanModules(join(input.stage, "node_modules"), "");
  const entry = join(input.stage, piKey, "dist", "bundle", "cli.js");
  const entryReal = await realpath(entry);
  if (
    !entryReal.startsWith(`${root}${sep}`) ||
    !(await lstat(entryReal)).isFile()
  )
    throw new Error("Invalid installed Pi entry");
  const version = (
    await command(
      input.node.path,
      [entryReal, "--version"],
      input.stage,
      { ...env, PI_CODING_AGENT_DIR: join(input.stage, "pi-agent") },
      input.signal,
      10000,
    )
  ).trim();
  if (version !== input.version)
    throw new Error("Installed Pi version mismatch");
  return {
    npmVersion,
    treeDigest: await stagedTreeDigest(input.stage),
    lockBytes,
    projectBytes: await bounded(join(input.stage, "package.json"), 1024 * 1024),
    entry,
  };
}
