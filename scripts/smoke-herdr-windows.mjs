import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { machine, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  outputLinePresent,
  stopServerCleanly,
} from "./lib/herdr-smoke-checks.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--cli")
  throw new Error(
    "Usage: node scripts/smoke-herdr-windows.mjs --cli <unpacked/dist/cli.js>",
  );
assert.equal(process.platform, "win32", "native Windows required");
assert.equal(process.arch, "x64", "native x64 Node required");
assert.match(machine(), /^(?:x86_64|AMD64)$/i);
if (!process.env.SystemRoot) throw new Error("SystemRoot is required");
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = await realpath(resolve(args[1]));
const fixture = JSON.parse(
  await readFile(join(root, "test/fixtures/herdr-release/v0.9.5.json"), "utf8"),
);
const base = await realpath(await mkdtemp(join(tmpdir(), "ahs-")));
const home = join(base, "h"),
  config = join(base, "c"),
  state = join(base, "s"),
  tools = join(base, "tools"),
  repo = join(base, "r"),
  temporary = join(base, "t");
const bin = join(home, ".agent-stack", "bin"),
  herdr = join(bin, "herdr.exe");
const systemRoot = process.env.SystemRoot,
  system32 = join(systemRoot, "System32"),
  session = `smoke-${process.pid}`;
let server;
const env = {
  SystemRoot: systemRoot,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: config,
  XDG_STATE_HOME: state,
  HERDR_CONFIG_PATH: join(config, "config.toml"),
  TMP: temporary,
  TEMP: temporary,
  ComSpec: join(system32, "cmd.exe"),
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  PATH: "",
};
function execute(command, argv, options) {
  return new Promise((done, fail) => {
    const child = execFile(command, argv, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        fail(error);
      } else done({ stdout, stderr });
    });
    child.stdin?.end();
  });
}
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
  for (const part of (process.env.PATH ?? "").split(delimiter)) {
    if (!part) continue;
    const candidate = join(part, `${name}.exe`);
    try {
      await access(candidate);
      return await realpath(candidate);
    } catch {}
  }
  throw new Error(`Required executable not found: ${name}.exe`);
}
async function waitFor(fn, label) {
  const deadline = Date.now() + 30000;
  let error;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (caught) {
      error = caught;
    }
    await delay(200);
  }
  throw new Error(
    `Timed out waiting for ${label}: ${error ?? "condition not met"}`,
  );
}
const call = (...argv) => run(herdr, ["--session", session, ...argv]);
async function startServer() {
  server = spawn(herdr, ["--session", session, "server"], {
    cwd: base,
    env,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  server.on("error", () => {});
  const status = await waitFor(async () => {
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error("server exited");
    const { stdout } = await call("status", "server");
    return stdout.includes("status: running") && stdout;
  }, "server readiness");
  for (const text of [
    "version: 0.9.5",
    "endpoint_compatible: yes",
    "private_protocol: 22",
    "private_protocol_compatible: yes",
  ])
    assert.ok(status.includes(text), status);
}
async function stopServer() {
  await stopServerCleanly(server, () => call("server", "stop"), waitFor);
  server = undefined;
}
async function cleanupServer() {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null)
    return;
  try {
    await stopServer();
  } catch (error) {
    server.kill("SIGKILL");
    await waitFor(
      () => server.exitCode !== null || server.signalCode !== null,
      "forced server exit",
    );
    throw error;
  }
}
try {
  // Isolate the ACL itself; Windows mkdir mode bits cannot prove privacy.
  const acl = `$ErrorActionPreference='Stop'
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true,$false)
$rule=[Security.AccessControl.FileSystemAccessRule]::new($user,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($env:TEST_DIR,$acl)`;
  await execute(
    join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(acl, "utf16le").toString("base64"),
    ],
    {
      cwd: base,
      env: {
        SystemRoot: systemRoot,
        TEST_DIR: base,
        HOME: base,
        USERPROFILE: base,
        TMP: base,
        TEMP: base,
        APPDATA: base,
        LOCALAPPDATA: base,
      },
      timeout: 10000,
      windowsHide: true,
    },
  );
  await Promise.all(
    [
      home,
      config,
      state,
      tools,
      bin,
      temporary,
      env.APPDATA,
      env.LOCALAPPDATA,
    ].map((path) => mkdir(path, { recursive: true })),
  );
  const node = await realpath(process.execPath),
    nodeDir = dirname(node),
    git = await findTool("git"),
    bash = await findTool("bash");
  const npmSource = join(nodeDir, "node_modules", "npm");
  await cp(npmSource, join(tools, "node_modules", "npm"), {
    recursive: true,
    dereference: true,
  });
  const npmCli = join(tools, "node_modules", "npm", "bin", "npm-cli.js");
  const shim =
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n';
  await writeFile(join(tools, "npm.cmd"), shim);
  env.PATH = [bin, tools, nodeDir, dirname(git), dirname(bash), system32].join(
    delimiter,
  );
  for (const dir of [tools, nodeDir, dirname(git), dirname(bash), system32]) {
    for (const ext of [".com", ".exe", ".bat", ".cmd"]) {
      try {
        await access(join(dir, `herdr${ext}`));
        throw new Error(`Unowned Herdr entry on smoke PATH: ${dir}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  const npmVersion = (await run(node, [npmCli, "--version"])).stdout.trim();
  assert.match(npmVersion, /^\d+\.\d+\.\d+/);
  const { cmdShimVersion } = await import(
    pathToFileURL(join(dirname(cli), "adapters/package-metadata.js")).href
  );
  assert.equal(await cmdShimVersion(join(tools, "npm.cmd"), "npm"), npmVersion);
  assert.equal(
    (await run(bash, ["-c", "printf '%s' bash-ok"])).stdout,
    "bash-ok",
  );
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
      description: "Native Windows smoke",
      platforms: ["win32"],
      components: [{ component: "herdr", channel: "stable" }],
      integrations: [],
      requires: ["workspace"],
    }),
  );
  await writeFile(
    env.HERDR_CONFIG_PATH,
    `onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n[session]\nresume_agents_on_restore = false\n[terminal]\ndefault_shell = ${JSON.stringify(bash)}\n`,
  );
  const metadata = join(base, "metadata.mjs"),
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
      "win32-x64",
    ],
    60000,
  );
  const first = JSON.parse(
    (await run(node, [cli, "setup", ...common, "--yes"], 180000)).stdout,
  );
  assert.equal(first.kind, "setup-complete");
  assert.equal(first.mode, "install");
  const receipt = first.binding.installations.herdr;
  assert.equal(receipt.mode, "managed");
  assert.equal(receipt.target, "win32-x64");
  assert.equal(receipt.version, fixture.version);
  assert.equal(receipt.asset.url, fixture.assets["windows-x86_64"]);
  assert.equal(receipt.asset.sha256, fixture.sha256["windows-x86_64"]);
  const names = [
    "conpty/arm64/OpenConsole.exe",
    "conpty/conpty.dll",
    "conpty/herdr-conpty.json",
    "conpty/x64/OpenConsole.exe",
    "herdr.exe",
    "THIRD-PARTY-NOTICES/Microsoft.Windows.Console.ConPTY-LICENSE.txt",
    "THIRD-PARTY-NOTICES/Microsoft.Windows.Console.ConPTY-NOTICE.md",
  ];
  for (const [index, name] of names.entries())
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(bin, ...name.split("/"))))
        .digest("hex"),
      receipt.files[index].sha256,
    );
  assert.equal(
    (await run(herdr, ["--version"])).stdout.trim(),
    `herdr ${fixture.version}`,
  );
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
        180000,
      )
    ).stdout,
  );
  assert.equal(again.mode, "managed");
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
  await call(
    "pane",
    "run",
    pane,
    "printf '%s%s\\n' 'agent_stack_smoke_' 'before'",
  );
  await waitFor(
    async () =>
      outputLinePresent(
        (await call("pane", "read", pane, "--raw")).stdout,
        "agent_stack_smoke_before",
      ),
    "pane output",
  );
  assert.equal(
    JSON.parse((await call("pane", "get", pane)).stdout).result.pane
      .terminal_id,
    terminal,
  );
  assert.ok(
    outputLinePresent(
      (await call("pane", "read", pane, "--raw")).stdout,
      "agent_stack_smoke_before",
    ),
  );
  await stopServer();
  await startServer();
  const restarted = JSON.parse((await call("pane", "get", pane)).stdout).result
    .pane;
  assert.equal(restarted.pane_id, pane);
  assert.equal(restarted.workspace_id, created.workspace.workspace_id);
  assert.notEqual(restarted.terminal_id, terminal);
  assert.equal(
    outputLinePresent(
      (await call("pane", "read", pane, "--raw")).stdout,
      "agent_stack_smoke_before",
    ),
    false,
  );
  await call(
    "pane",
    "run",
    pane,
    "printf '%s%s\\n' 'agent_stack_smoke_' 'after'",
  );
  await waitFor(
    async () =>
      outputLinePresent(
        (await call("pane", "read", pane, "--raw")).stdout,
        "agent_stack_smoke_after",
      ),
    "restarted pane output",
  );
  await stopServer();
  console.log(
    JSON.stringify(
      {
        target: "win32-x64",
        source: "live locked HTTPS asset",
        version: fixture.version,
        archiveSha256: receipt.asset.sha256,
        files: names.length,
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
  try {
    await cleanupServer();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
