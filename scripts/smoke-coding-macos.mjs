import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { machine } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--cli" || args[2] !== "--target")
  throw Error(
    "Usage: node scripts/smoke-coding-macos.mjs --cli <installed CLI.js> --target darwin-arm64|darwin-x64",
  );
const cli = await realpath(args[1]),
  target = args[3];
assert.equal(process.platform, "darwin");
assert.equal(target, `darwin-${process.arch}`);
assert.equal(machine(), process.arch === "arm64" ? "arm64" : "x86_64");
async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const path = join(directory, name);
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch {}
  }
  throw Error(`Missing prerequisite: ${name}`);
}
const root = await mkdtemp("/private/tmp/asc-"),
  home = join(root, "h"),
  repo = join(root, "r"),
  tools = join(root, "tools");
const bin = join(home, ".agent-stack", "bin");
for (const path of [home, repo, tools, bin, join(root, "tmp")])
  await mkdir(path, { recursive: true, mode: 0o700 });
await cp(join(project, "stack"), join(repo, "stack"), { recursive: true });
await rm(join(repo, "stack", "profiles", "coding.yaml"), { force: true });
await writeFile(
  join(repo, "stack", "profiles", "coding.json"),
  JSON.stringify({
    schemaVersion: 1,
    id: "coding",
    description: "Fixed official release acceptance",
    platforms: ["darwin"],
    components: [
      { component: "pi", version: "1.5.2" },
      { component: "pnpm", version: "12.15.0" },
      { component: "uv", version: "0.13.8" },
      { component: "herdr", channel: "stable" },
    ],
    integrations: ["pi-herdr"],
    requires: [
      "agent-runtime",
      "workspace",
      "node-packages",
      "python-tools",
      "agent-status",
    ],
  }),
);
for (const name of ["node", "npm", "git"])
  await symlink(
    await realpath(
      name === "node" ? process.execPath : await findExecutable(name),
    ),
    join(tools, name),
  );
const manifest = JSON.parse(
  await readFile(
    join(project, "test/fixtures/herdr-release/v0.9.5.json"),
    "utf8",
  ),
);
const preload = join(root, "metadata.mjs"),
  offline = join(root, "offline.mjs");
await writeFile(
  preload,
  `const original=globalThis.fetch;globalThis.fetch=async(u,o)=>String(u)===${JSON.stringify(manifest.source)}?new Response(${JSON.stringify(JSON.stringify(manifest))}):original(u,o);`,
);
await writeFile(
  offline,
  "globalThis.fetch=async()=>{throw Error('Unexpected root asset fetch in repeat setup');};",
);
const env = {
  HOME: home,
  USERPROFILE: home,
  PATH: `${bin}:${tools}:/usr/bin:/bin`,
  TMPDIR: join(root, "tmp"),
  PI_CODING_AGENT_DIR: join(home, "pi-agent"),
  HERDR_CONFIG_PATH: join(home, "herdr", "config.toml"),
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_STATE_HOME: join(home, "state"),
  TERM: "dumb",
  NO_COLOR: "1",
};
for (const name of ["user", "global"])
  await writeFile(join(root, `${name}.npmrc`), "");
env.npm_config_userconfig = join(root, "user.npmrc");
env.npm_config_globalconfig = join(root, "global.npmrc");
env.npm_config_cache = join(root, "cache");

async function call(name, args, mode = "normal") {
  const source =
    mode === "offline" ? offline : mode === "metadata" ? preload : null;
  return await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [...(source ? ["--import", source] : []), cli, ...args],
      {
        cwd: repo,
        env,
        encoding: "utf8",
        timeout: 600000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGINT",
      },
      async (error, stdout, stderr) => {
        await writeFile(join(root, `${name}.stdout`), stdout);
        await writeFile(join(root, `${name}.stderr`), stderr);
        if (error)
          reject(Error(`${name}: ${error.message}\n${stdout}\n${stderr}`));
        else resolve(JSON.parse(stdout));
      },
    ),
  );
}
const common = ["--repo", repo, "--profile", "coding", "--json"];
try {
  assert.equal(
    (
      await call(
        "lock",
        ["lock", ...common, "--target", `darwin-${process.arch}`],
        "metadata",
      )
    ).kind,
    "shared-lock-created",
  );
  const preview = await call(
    "preview",
    ["setup", ...common, "--dry-run"],
    "offline",
  );
  assert.deepEqual(preview.blockers, []);
  const installed = await call("setup", ["setup", ...common, "--yes"]);
  assert.equal(installed.kind, "setup-complete");
  assert.deepEqual(Object.keys(installed.binding.installations).sort(), [
    "herdr",
    "pi",
    "pnpm",
    "uv",
  ]);
  assert.equal(installed.binding.defaultBinding.profile, "coding");
  assert.equal(installed.verification.scope, "isolated-pi-tui-herdr-socket-v1");
  const before = await readFile(
    join(home, ".agent-stack", "binding.json"),
    "utf8",
  );
  const again = await call("rerun", ["setup", ...common, "--yes"], "offline");
  assert.equal(again.kind, "setup-complete");
  assert.equal(
    await readFile(join(home, ".agent-stack", "binding.json"), "utf8"),
    before,
  );
  console.log(
    JSON.stringify({
      target: `darwin-${process.arch}`,
      components: Object.keys(installed.binding.installations),
      resources: installed.plan.codingResources.files.length,
      verification: installed.verification,
      rerun: "root fetch forbidden; binding unchanged",
    }),
  );
  await rm(root, { recursive: true, force: true });
} catch (error) {
  console.error(JSON.stringify({ fixture: root, error: error.message }));
  process.exitCode = 1;
}
