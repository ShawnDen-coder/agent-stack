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
import { verifyCodingLock } from "./lib/coding-fixture.mjs";
import { smokeCodingRun } from "./lib/smoke-coding-run.mjs";

const project = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const standalone = args[4] === "--binary";
if (
  (args.length !== 4 && !(args.length === 5 && standalone)) ||
  args[0] !== "--cli" ||
  args[2] !== "--target"
)
  throw Error(
    "Usage: node scripts/smoke-coding-macos.mjs --cli <installed CLI.js> --target darwin-arm64|darwin-x64 [--binary]",
  );
let cli = await realpath(args[1]);
const target = args[3];
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
if (standalone) {
  const moved = join(root, "agent-stack");
  await cp(cli, moved);
  cli = moved;
}
const bin = join(home, ".agent-stack", "bin");
for (const path of [home, repo, tools, bin, join(root, "tmp")])
  await mkdir(path, { recursive: true, mode: 0o700 });
await cp(join(project, "stack"), join(repo, "stack"), { recursive: true });
await verifyCodingLock(repo);
for (const name of ["node", "npm", "git"])
  await symlink(
    await realpath(
      name === "node" ? process.execPath : await findExecutable(name),
    ),
    join(tools, name),
  );
const offline = join(root, "offline.mjs");
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
  // SEA setup/run execute the moved binary; Node preloads are unavailable there.
  const program = standalone ? cli : process.execPath;
  const programArgs = standalone
    ? args
    : [...(mode === "offline" ? ["--import", offline] : []), cli, ...args];
  return await new Promise((resolve, reject) =>
    execFile(
      program,
      programArgs,
      {
        cwd: repo,
        env,
        encoding: "utf8",
        timeout: 600000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGINT",
      },
      async (error, stdout, stderr) => {
        try {
          await writeFile(join(root, `${name}.stdout`), stdout);
          await writeFile(join(root, `${name}.stderr`), stderr);
          if (error) {
            reject(Error(`${name}: ${error.message}\n${stdout}\n${stderr}`));
          } else resolve(JSON.parse(stdout));
        } catch (writeOrParseError) {
          reject(writeOrParseError);
        }
      },
    ),
  );
}
const common = ["--repo", repo, "--profile", "coding", "--json"];
try {
  const validation = await call("validate-lock", [
    "validate",
    "--repo",
    repo,
    "--lock",
    "--json",
  ]);
  assert.equal(validation.valid, true);
  assert.equal(validation.checked.lock.targets, 2);
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
  const settings = JSON.parse(
    await readFile(join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"),
  );
  assert.equal(settings.packages, undefined);
  assert.equal(settings.subagents, undefined);
  await assert.rejects(access(join(env.PI_CODING_AGENT_DIR, "mcp.json")), {
    code: "ENOENT",
  });
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
  const run = await smokeCodingRun({
    root,
    home,
    repo,
    env,
    cliCommand: standalone ? [cli] : [process.execPath, cli],
  });
  console.log(
    JSON.stringify({
      run,
      target: `darwin-${process.arch}`,
      components: Object.keys(installed.binding.installations),
      resources: installed.plan.codingResources.files.length,
      verification: installed.verification,
      rerun: standalone
        ? "receipt reuse; binding unchanged"
        : "root fetch forbidden; binding unchanged",
      distribution: standalone
        ? "moved standalone binary"
        : "installed npm tarball",
    }),
  );
  await rm(root, { recursive: true, force: true });
} catch (error) {
  console.error(JSON.stringify({ fixture: root, error: error.message }));
  process.exitCode = 1;
}
