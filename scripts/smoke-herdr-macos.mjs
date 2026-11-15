import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--cli" || args[2] !== "--target") {
  throw new Error(
    "Usage: node scripts/smoke-herdr-macos.mjs --cli <unpacked/dist/cli.js> --target darwin-x64|darwin-arm64",
  );
}
const cli = await realpath(resolve(args[1]));
const target = args[3];
if (!["darwin-x64", "darwin-arm64"].includes(target))
  throw new Error(`Unsupported target: ${target}`);
const expectedMachine = target === "darwin-x64" ? "x86_64" : "arm64";
assert.equal(process.platform, "darwin", "native macOS required");
assert.equal(
  process.arch,
  target.slice(7),
  "Node architecture must match target",
);
assert.equal(machine(), expectedMachine, "native machine must match target");
if (process.arch === "x64") {
  const translated = await execute(
    "/usr/sbin/sysctl",
    ["-n", "sysctl.proc_translated"],
    { timeout: 5000 },
  ).catch((error) => {
    if (String(error.stderr).includes("unknown oid")) return { stdout: "0" };
    throw error;
  });
  assert.notEqual(translated.stdout.trim(), "1", "Rosetta is not native x64");
}
const fixture = JSON.parse(
  await readFile(join(root, "test/fixtures/herdr-release/v0.9.5.json"), "utf8"),
);
const key = target === "darwin-x64" ? "macos-x86_64" : "macos-aarch64";
const base = await realpath(await mkdtemp("/private/tmp/ahs-"));
const home = join(base, "h"),
  config = join(base, "c"),
  state = join(base, "s"),
  tools = join(base, "tools"),
  repo = join(base, "r");
const bin = join(home, ".agent-stack/bin"),
  herdr = join(bin, "herdr");
let server;
const env = {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: config,
  XDG_STATE_HOME: state,
  HERDR_CONFIG_PATH: join(config, "config.toml"),
  TMPDIR: join(base, "tmp"),
  PATH: `${bin}:${tools}`,
  LANG: "C.UTF-8",
  SHELL: "/bin/sh",
};
async function run(command, argv, timeout = 30000) {
  try {
    return await execute(command, argv, {
      cwd: base,
      env,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `${command} ${argv.join(" ")} failed: ${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
      { cause: error },
    );
  }
}
async function findTool(name) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch {}
  }
  throw new Error(`Required real tool not found: ${name}`);
}
const call = (...argv) => run(herdr, ["--session", "smoke", ...argv]);
async function waitFor(fn, label) {
  const deadline = Date.now() + 20000;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await delay(200);
  }
  throw new Error(
    `Timed out waiting for ${label}: ${last ?? "condition not met"}`,
  );
}
async function startServer() {
  server = spawn(herdr, ["--session", "smoke", "server"], {
    cwd: base,
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  server.on("error", () => {});
  await waitFor(async () => {
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error("server exited");
    const { stdout } = await call("status", "server");
    return stdout.includes("status: running") && stdout;
  }, "server readiness");
  const { stdout } = await call("status", "server");
  for (const line of [
    "version: 0.9.5",
    "endpoint_compatible: yes",
    "private_protocol: 22",
    "private_protocol_compatible: yes",
  ])
    assert.ok(stdout.includes(line), stdout);
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  await call("server", "stop");
  await waitFor(
    () => server.exitCode !== null || server.signalCode !== null,
    "server exit",
  );
  server = undefined;
}
try {
  await Promise.all(
    [home, config, state, tools, bin, join(base, "tmp")].map((p) =>
      mkdir(p, { recursive: true }),
    ),
  );
  await symlink(await realpath(process.execPath), join(tools, "node"));
  for (const name of ["npm", "git"])
    await symlink(await findTool(name), join(tools, name));
  await cp(join(root, "stack"), join(repo, "stack"), {
    recursive: true,
    dereference: true,
  });
  await rm(join(repo, "stack/stack.lock.json"), { force: true });
  await writeFile(
    join(repo, "stack/profiles/herdr-only.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "herdr-only",
      description: "Native smoke",
      platforms: ["darwin"],
      components: [{ component: "herdr", channel: "stable" }],
      integrations: [],
      requires: ["workspace"],
    }),
  );
  await writeFile(
    env.HERDR_CONFIG_PATH,
    "onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n[session]\nresume_agents_on_restore = false\n",
  );
  const metadata = join(base, "manifest.mjs"),
    noFetch = join(base, "no-fetch.mjs"),
    marker = join(base, "fetch-attempt");
  await writeFile(
    metadata,
    `globalThis.fetch=async u=>{if(String(u)!==${JSON.stringify(fixture.source)})throw Error('Unexpected metadata URL '+u);return new Response(${JSON.stringify(JSON.stringify(fixture))})};`,
  );
  await writeFile(
    noFetch,
    `import {writeFileSync} from 'node:fs';globalThis.fetch=async()=>{writeFileSync(${JSON.stringify(marker)},'attempt');throw Error('Unexpected fetch during repeat setup')};`,
  );
  const node = await realpath(process.execPath);
  const common = ["--repo", repo, "--profile", "herdr-only", "--json"];
  await run(
    node,
    [
      "--import",
      pathToFileURL(metadata).href,
      cli,
      "lock",
      ...common,
      "--target",
      target,
    ],
    60000,
  );
  const installed = JSON.parse(
    (await run(node, [cli, "setup", ...common, "--yes"], 120000)).stdout,
  );
  assert.equal(installed.kind, "setup-complete");
  assert.equal(installed.plan.herdrInstallation.mode, "install");
  const receipt = installed.binding.installations.herdr;
  assert.equal(receipt.mode, "managed");
  assert.equal(receipt.version, fixture.version);
  assert.equal(receipt.target, target);
  assert.equal(receipt.asset.url, fixture.assets[key]);
  assert.equal(receipt.asset.sha256, fixture.sha256[key]);
  assert.equal(
    createHash("sha256")
      .update(await readFile(herdr))
      .digest("hex"),
    fixture.sha256[key],
  );
  assert.match((await run(herdr, ["--version"])).stdout, /0\.9\.5/);
  const again = JSON.parse(
    (
      await run(
        node,
        [
          "--import",
          pathToFileURL(noFetch).href,
          cli,
          "setup",
          ...common,
          "--yes",
        ],
        60000,
      )
    ).stdout,
  );
  assert.equal(again.kind, "setup-complete");
  assert.equal(again.binding.installations.herdr.mode, "managed");
  assert.deepEqual(again.binding.installations.herdr, receipt);
  await assert.rejects(access(marker));
  await startServer();
  const created = JSON.parse(
    (
      await call(
        "workspace",
        "create",
        "--cwd",
        base,
        "--label",
        "agent-stack-smoke",
      )
    ).stdout,
  ).result;
  const pane = created.root_pane.pane_id,
    terminal = created.root_pane.terminal_id;
  await call("pane", "run", pane, "printf 'agent_stack_smoke_before\\n'");
  await waitFor(
    async () =>
      (await call("pane", "read", pane)).stdout.includes(
        "agent_stack_smoke_before",
      ),
    "initial pane output",
  );
  const reconnect = JSON.parse((await call("pane", "get", pane)).stdout).result
    .pane;
  assert.equal(reconnect.terminal_id, terminal);
  assert.match(
    (await call("pane", "read", pane)).stdout,
    /agent_stack_smoke_before/,
  );
  await stopServer();
  await startServer();
  const restarted = JSON.parse((await call("pane", "get", pane)).stdout).result
    .pane;
  assert.equal(restarted.pane_id, pane);
  assert.equal(restarted.workspace_id, created.workspace.workspace_id);
  assert.notEqual(restarted.terminal_id, terminal);
  assert.doesNotMatch(
    (await call("pane", "read", pane)).stdout,
    /agent_stack_smoke_before/,
  );
  await call("pane", "run", pane, "printf 'agent_stack_smoke_after\\n'");
  await waitFor(
    async () =>
      (await call("pane", "read", pane)).stdout.includes(
        "agent_stack_smoke_after",
      ),
    "restarted pane output",
  );
  await stopServer();
  console.log(
    JSON.stringify(
      {
        target,
        source: "live locked HTTPS asset",
        version: fixture.version,
        sha256: fixture.sha256[key],
        install: "managed",
        repeat: "no fetch",
        protocol: 22,
        clientReconnect: "same pane and terminal",
        serverRestart:
          "same pane, rebuilt terminal, old output absent, new command passed",
      },
      null,
      2,
    ),
  );
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    try {
      await stopServer();
    } catch {
      server.kill("SIGKILL");
      await waitFor(
        () => server.exitCode !== null || server.signalCode !== null,
        "forced server exit",
      ).catch(() => {});
    }
  }
  await rm(base, { recursive: true, force: true });
}
