import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { readHerdrWindowsArchive } from "../dist/adapters/herdr-windows-archive.js";

async function secureTestWindows(base) {
  if (process.platform !== "win32") return;
  const { spawnSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot);
  const script = `$ErrorActionPreference='Stop'
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true,$false)
$rule=[Security.AccessControl.FileSystemAccessRule]::new($user,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($env:TEST_DIR,$acl)`;
  const result = spawnSync(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
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
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function pe(machine, dll = false) {
  const value = Buffer.alloc(256);
  value.writeUInt16LE(0x5a4d, 0);
  value.writeUInt32LE(64, 0x3c);
  value.writeUInt32LE(0x4550, 64);
  value.writeUInt16LE(machine, 68);
  value.writeUInt16LE(dll ? 0x2000 : 0, 86);
  value.writeUInt16LE(0x20b, 88);
  return value;
}
function fixture() {
  const files = new Map([
    ["conpty/arm64/OpenConsole.exe", pe(0xaa64)],
    ["conpty/conpty.dll", pe(0x8664, true)],
    ["conpty/x64/OpenConsole.exe", pe(0x8664)],
    ["herdr.exe", pe(0x8664)],
    [
      "THIRD-PARTY-NOTICES/Microsoft.Windows.Console.ConPTY-LICENSE.txt",
      Buffer.from("license"),
    ],
    [
      "THIRD-PARTY-NOTICES/Microsoft.Windows.Console.ConPTY-NOTICE.md",
      Buffer.from("notices"),
    ],
  ]);
  const markerFiles = {};
  for (const name of [
    "conpty/arm64/OpenConsole.exe",
    "conpty/conpty.dll",
    "conpty/x64/OpenConsole.exe",
  ])
    markerFiles[name] = createHash("sha256")
      .update(files.get(name))
      .digest("hex");
  files.set(
    "conpty/herdr-conpty.json",
    Buffer.from(
      JSON.stringify({
        architecture: "x86_64",
        files: markerFiles,
        package: "Microsoft.Windows.Console.ConPTY",
        schema_version: 1,
        version: "1.24.260710001",
      }),
    ),
  );
  return files;
}
function zip(files) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const [name, value] of files) {
    const n = Buffer.from(name),
      data = deflateRawSync(value),
      crc = crc32(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(value.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(0x81a40000, 38);
    c.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    central.push(c, n);
    offset += local.length + n.length + data.length;
  }
  const entries = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(entries.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, entries, end]);
}
test("Herdr Windows ZIP accepts the seven verified-layout files", () => {
  const files = fixture(),
    result = readHerdrWindowsArchive(zip(files));
  assert.equal(result.size, files.size);
  for (const [name, bytes] of files) assert.deepEqual(result.get(name), bytes);
});
test("Herdr Windows ZIP rejects traversal, mixed-case names, incomplete layout and incorrect PE/marker", () => {
  for (const name of ["../herdr.exe", "HERDR.exe"]) {
    const files = fixture();
    files.set(name, files.get("herdr.exe"));
    files.delete("herdr.exe");
    assert.throws(() => readHerdrWindowsArchive(zip(files)), /archive/);
  }
  const missing = fixture();
  missing.delete("conpty/conpty.dll");
  assert.throws(() => readHerdrWindowsArchive(zip(missing)), /archive/);
  const oversizeMarker = fixture();
  oversizeMarker.set("conpty/herdr-conpty.json", Buffer.alloc(1024 * 1024 + 1));
  assert.throws(
    () => readHerdrWindowsArchive(zip(oversizeMarker)),
    /entry size/,
  );
  const badPe = fixture();
  badPe.set("herdr.exe", pe(0xaa64));
  assert.throws(() => readHerdrWindowsArchive(zip(badPe)), /architecture/);
  const badMarker = fixture();
  badMarker.set(
    "conpty/conpty.dll",
    Buffer.from(badMarker.get("conpty/conpty.dll")),
  );
  badMarker.get("conpty/conpty.dll")[200] = 1;
  assert.throws(() => readHerdrWindowsArchive(zip(badMarker)), /marker/);
});
test("Herdr Windows ZIP rejects links, checksums, overlap, extra data and encryption", () => {
  const original = zip(fixture());
  const central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const link = Buffer.from(original);
  link.writeUInt32LE(0xa1ff0000, central + 38);
  assert.throws(() => readHerdrWindowsArchive(link), /non-regular/);
  const reparse = Buffer.from(original);
  reparse.writeUInt32LE(
    (reparse.readUInt32LE(central + 38) | 0x400) >>> 0,
    central + 38,
  );
  assert.throws(() => readHerdrWindowsArchive(reparse), /entry size or type/);
  const encrypted = Buffer.from(original);
  encrypted.writeUInt16LE(1, central + 8);
  assert.throws(() => readHerdrWindowsArchive(encrypted), /unsupported/);
  const wrongCrc = Buffer.from(original);
  wrongCrc.writeUInt32LE(0, central + 16);
  assert.throws(() => readHerdrWindowsArchive(wrongCrc), /mismatch/);
  const duplicateOffset = Buffer.from(original);
  const second = central + 46 + duplicateOffset.readUInt16LE(central + 28);
  duplicateOffset.writeUInt32LE(0, second + 42);
  assert.throws(
    () => readHerdrWindowsArchive(duplicateOffset),
    /mismatch|overlap/,
  );
  assert.throws(
    () =>
      readHerdrWindowsArchive(Buffer.concat([original, Buffer.from("junk")])),
    /end record/,
  );
});

for (const killPoint of [
  "before-entry",
  "entry",
  "binding",
  "third-state",
  "directory-intent",
  "invalid-journal",
  "tmp-created",
  "tmp-identified",
  "target-drift",
  "stage-drift",
  "concurrent",
])
  test(`Windows bundle adapter recovers interruption at ${killPoint}`, async (t) => {
    const { mkdtemp, mkdir, readFile, realpath, rm, writeFile } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { join, delimiter } = await import("node:path");
    const { spawn, spawnSync } = await import("node:child_process");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const base = await realpath(
      await mkdtemp(join(tmpdir(), "herdr-win-state-")),
    );
    t.after(() => rm(base, { recursive: true, force: true }));
    await secureTestWindows(base);
    const home = join(base, "home"),
      root = join(home, ".agent-stack"),
      bin = join(root, "bin"),
      temporary = join(base, "tmp");
    await mkdir(bin, { recursive: true });
    await mkdir(temporary);
    const archive = zip(fixture()),
      archivePath = join(base, "bundle.zip");
    await writeFile(archivePath, archive);
    const digest = createHash("sha256").update(archive).digest("hex");
    const preload = join(base, "fixture.mjs");
    await writeFile(
      preload,
      `import cp from 'node:child_process';import fs from 'node:fs';import {readFile,writeFile} from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import 'node:path';
const native=process.platform==='win32';const exec=cp.execFile;cp.execFile=(file,args,opts,cb)=>{if(process.env.STAGE_DRIFT&&String(file).endsWith('f4.exe'))fs.writeFileSync(${JSON.stringify(join(base, "version-called"))},'called');return native&&opts.env?.AGENT_STACK_DIR?exec(file,args,opts,cb):exec(process.execPath,['-e',file.endsWith('powershell.exe')?"console.log('safe')":"console.log('herdr 0.9.5')"],opts,cb)};
const open=fs.promises.open;fs.promises.open=async(p,...args)=>{const h=await open(p,...args);if(process.env.STAGE_DRIFT&&typeof p==='string'&&p.endsWith('f4.exe')&&args[0]==='wx'){const write=h.writeFile.bind(h);h.writeFile=async(...a)=>{await write(...a);await h.write(Buffer.from([0]),0,1,0)}}if(typeof p==='string'&&p.includes('binding-')&&p.endsWith('.tmp')&&args[0]==='wx'){if(process.env.TEST_KILL==='tmp-created')process.kill(process.pid,'SIGKILL');if(process.env.TEST_KILL==='tmp-identified'){h.writeFile=async()=>{process.kill(process.pid,'SIGKILL')}}}return h};const mkdir=fs.promises.mkdir;fs.promises.mkdir=async(p,...args)=>{const r=await mkdir(p,...args);if(process.env.TEST_KILL==='directory-intent'&&p===${JSON.stringify(join(bin, "conpty"))})process.kill(process.pid,'SIGKILL');return r};const link=fs.promises.link;fs.promises.link=async(a,b)=>{if(['before-entry','third-state','invalid-journal'].includes(process.env.TEST_KILL)&&b===${JSON.stringify(join(bin, "conpty/arm64/OpenConsole.exe"))})process.kill(process.pid,'SIGKILL');await link(a,b);if(process.env.TEST_KILL==='entry'&&b===${JSON.stringify(join(bin, "herdr.exe"))})process.kill(process.pid,'SIGKILL');if(process.env.TEST_KILL==='binding'&&b===${JSON.stringify(join(root, "binding.json"))})process.kill(process.pid,'SIGKILL')};
if(!native){Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'x64'});}syncBuiltinESMExports();globalThis.fetch=async()=>{if(process.env.TEST_DELAY){await writeFile(${JSON.stringify(join(base, "ready"))},'ready');await new Promise(r=>setTimeout(r,10000))}if(process.env.TEST_DRIFT)await writeFile(${JSON.stringify(join(bin, "herdr.exe"))},'foreign');return new Response(await readFile(${JSON.stringify(archivePath)}))};`,
    );
    const moduleUrl = pathToFileURL(
      fileURLToPath(new URL("../dist/adapters/uv-state.js", import.meta.url)),
    ).href;
    const source = `import {applyWindowsHerdr,recoverPendingUv,matchesManagedHerdr} from ${JSON.stringify(moduleUrl)};import {readFile} from 'node:fs/promises';
const args={home:${JSON.stringify(home)},path:${JSON.stringify(`${bin}${delimiter}`)},repo:${JSON.stringify(base)},profile:'herdr-only',lock:${JSON.stringify(join(base, "lock.json"))},version:'0.9.5',target:'win32-x64',asset:{assetKey:'windows-x86_64',name:'herdr-windows-x86_64.zip',url:'https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-windows-x86_64.zip',sha256:${JSON.stringify(digest)},digestSource:'https://herdr.dev/latest.json'},signal:new AbortController().signal,recheck:async()=>{},checkReachable:async()=>{}};
if(process.env.TEST_ACTION==='recover'){await recoverPendingUv(args.home,args.path,args.signal,args.recheck);const state=JSON.parse(await readFile(${JSON.stringify(join(root, "binding.json"))}));console.log(JSON.stringify({state,match:await matchesManagedHerdr(args.home,state.installations.herdr,args.version,args.target,args.asset)}));}else console.log(JSON.stringify(await applyWindowsHerdr(args)));`;
    const run = (extra = {}) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(preload).href,
          "--input-type=module",
          "-e",
          source,
        ],
        {
          cwd: base,
          encoding: "utf8",
          timeout: 120000,
          env: {
            HOME: home,
            USERPROFILE: home,
            SystemRoot: process.env.SystemRoot ?? base,
            TMP: temporary,
            TEMP: temporary,
            TMPDIR: temporary,
            PATH: bin,
            ...extra,
          },
        },
      );
    if (killPoint === "concurrent") {
      const child = spawn(
        process.execPath,
        [
          "--import",
          pathToFileURL(preload).href,
          "--input-type=module",
          "-e",
          source,
        ],
        {
          cwd: base,
          env: {
            HOME: home,
            USERPROFILE: home,
            SystemRoot: process.env.SystemRoot ?? base,
            TMP: temporary,
            TEMP: temporary,
            TMPDIR: temporary,
            PATH: bin,
            TEST_DELAY: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const finished = new Promise((resolve) =>
        child.once("close", (status, signal) => resolve({ status, signal })),
      );
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          await readFile(join(base, "ready"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      try {
        assert.equal(await readFile(join(base, "ready"), "utf8"), "ready");
        const other = run();
        assert.notEqual(other.status, 0, other.stderr + other.stdout);
        assert.match(other.stderr, /Another setup operation/);
        const done = await finished;
        assert.equal(done.status, 0, stderr);
        assert.equal(JSON.parse(stdout).installations.herdr.mode, "managed");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await finished;
        }
      }
      return;
    }
    if (killPoint === "stage-drift") {
      const failure = run({ STAGE_DRIFT: "1" });
      assert.notEqual(failure.status, 0, failure.stderr + failure.stdout);
      assert.match(failure.stderr, /Staging file changed/);
      const owner = JSON.parse(
        await readFile(join(root, "operation.lock"), "utf8"),
      );
      for (let index = 0; index < 7; index++)
        assert.ok(
          (await readFile(join(root, owner.stage.name, `f${index}.exe`)))
            .length > 0,
        );
      await assert.rejects(readFile(join(base, "version-called")));
      return;
    }
    if (killPoint === "target-drift") {
      const conflict = run({ TEST_DRIFT: "1" });
      assert.notEqual(conflict.status, 0, conflict.stderr + conflict.stdout);
      assert.match(conflict.stderr, /Managed file changed/);
      assert.equal(await readFile(join(bin, "herdr.exe"), "utf8"), "foreign");
      const pending = JSON.parse(
        await readFile(join(root, "pending.json"), "utf8"),
      );
      assert.ok(
        (await readFile(join(root, pending.stage, "f0.exe"))).length > 0,
      );
      return;
    }
    const interrupted = run({ TEST_KILL: killPoint });
    if (process.platform === "win32")
      assert.notEqual(interrupted.status, 0, interrupted.stderr);
    else assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
    if (
      killPoint === "third-state" ||
      killPoint === "directory-intent" ||
      killPoint === "invalid-journal" ||
      killPoint === "tmp-created"
    ) {
      const journalPath = join(root, "pending.json");
      const pendingBytes = await readFile(journalPath);
      const pending = JSON.parse(pendingBytes);
      if (killPoint === "invalid-journal") await writeFile(journalPath, "");
      if (killPoint === "third-state")
        await writeFile(
          join(root, "binding.json"),
          JSON.stringify({
            schemaVersion: 2,
            defaultBinding: null,
            installations: {},
          }),
        );
      const rejected = run();
      assert.notEqual(rejected.status, 0, rejected.stderr + rejected.stdout);
      assert.match(
        rejected.stderr,
        killPoint === "third-state"
          ? /Setup state changed/
          : killPoint === "invalid-journal"
            ? /Invalid local setup state/
            : killPoint === "tmp-created"
              ? /Temporary binding ownership is incomplete/
              : /Unowned Herdr directory/,
      );
      assert.deepEqual(
        await readFile(journalPath),
        killPoint === "invalid-journal" ? Buffer.alloc(0) : pendingBytes,
      );
      assert.ok(
        (await readFile(join(root, pending.stage, "f0.exe"))).length > 0,
      );
      return;
    }
    let state;
    if (killPoint === "binding") {
      const before = await readFile(join(root, "binding.json"));
      const recovered = run({ TEST_ACTION: "recover" });
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(JSON.parse(recovered.stdout).match, true);
      assert.deepEqual(await readFile(join(root, "binding.json")), before);
      state = JSON.parse(before);
    } else {
      const installed = run();
      assert.equal(installed.status, 0, installed.stderr);
      state = JSON.parse(installed.stdout);
    }
    assert.equal(state.installations.herdr.target, "win32-x64");
    assert.equal(state.installations.herdr.files.length, 7);
    assert.equal(
      (await readFile(join(bin, "conpty/herdr-conpty.json"))).length > 0,
      true,
    );
    const before = await readFile(join(root, "binding.json"));
    const recovered = run({ TEST_ACTION: "recover" });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).match, true);
    assert.deepEqual(await readFile(join(root, "binding.json")), before);
    await writeFile(join(bin, "conpty/conpty.dll"), "local modification");
    const drift = run({ TEST_ACTION: "recover" });
    assert.equal(drift.status, 0, drift.stderr);
    assert.equal(JSON.parse(drift.stdout).match, false);
    assert.deepEqual(await readFile(join(root, "binding.json")), before);
    assert.equal(
      await readFile(join(bin, "conpty/conpty.dll"), "utf8"),
      "local modification",
    );
  });

test("compiled setup CLI selects the Windows locked bundle and avoids a second download", async (t) => {
  const { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, delimiter } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const base = await realpath(await mkdtemp(join(tmpdir(), "herdr-win-cli-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  await secureTestWindows(base);
  const repo = join(base, "repo"),
    home = join(base, "home"),
    bin = join(home, ".agent-stack", "bin"),
    tools = join(base, "tools"),
    marker = join(base, "fetch-count"),
    temporary = join(base, "tmp");
  await mkdir(bin, { recursive: true });
  await mkdir(tools);
  await mkdir(temporary);
  await cp(
    fileURLToPath(new URL("../stack", import.meta.url)),
    join(repo, "stack"),
    { recursive: true },
  );
  await rm(join(repo, "stack/stack.lock.json"));
  await cp(
    new URL("./fixtures/windows-profile/herdr-only.json", import.meta.url),
    join(repo, "stack/profiles/herdr-only.json"),
  );
  for (const name of ["npm.exe", "git.exe"])
    await writeFile(join(tools, name), "tool", { mode: 0o755 });
  const archive = zip(fixture()),
    archivePath = join(base, "bundle.zip");
  await writeFile(archivePath, archive);
  const digest = createHash("sha256").update(archive).digest("hex"),
    assetUrl =
      "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-windows-x86_64.zip";
  const metadata = join(base, "metadata.mjs");
  const manifest = {
    version: "0.9.5",
    assets: { "windows-x86_64": assetUrl },
    sha256: { "windows-x86_64": digest },
  };
  await writeFile(
    metadata,
    `globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify(manifest))})`,
  );
  const cli =
    process.env.AGENT_STACK_TEST_CLI ??
    fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const env = {
    HOME: home,
    USERPROFILE: home,
    SystemRoot: process.env.SystemRoot ?? base,
    TMP: temporary,
    TEMP: temporary,
    TMPDIR: temporary,
    PATH: `${bin}${delimiter}${tools}`,
    PATHEXT: ".exe",
    NO_COLOR: "1",
  };
  const badFiles = fixture();
  badFiles.set("../herdr.exe", badFiles.get("herdr.exe"));
  badFiles.delete("herdr.exe");
  const badArchive = zip(badFiles),
    badArchivePath = join(base, "bad-bundle.zip"),
    badLock = join(base, "bad.lock.json");
  await writeFile(badArchivePath, badArchive);
  const badMetadata = join(base, "bad-metadata.mjs");
  const badManifest = {
    ...manifest,
    sha256: {
      "windows-x86_64": createHash("sha256").update(badArchive).digest("hex"),
    },
  };
  await writeFile(
    badMetadata,
    `globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify(badManifest))})`,
  );
  const badLocked = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(badMetadata).href,
      cli,
      "lock",
      "--repo",
      repo,
      "--profile",
      "herdr-only",
      "--target",
      "win32-x64",
      "--out",
      badLock,
      "--json",
    ],
    { cwd: base, encoding: "utf8", timeout: 30000, env },
  );
  assert.equal(badLocked.status, 0, badLocked.stderr + badLocked.stdout);
  const locked = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(metadata).href,
      cli,
      "lock",
      "--repo",
      repo,
      "--profile",
      "herdr-only",
      "--target",
      "win32-x64",
      "--json",
    ],
    { cwd: base, encoding: "utf8", timeout: 30000, env },
  );
  assert.equal(locked.status, 0, locked.stderr + locked.stdout);
  const preload = join(base, "setup.mjs");
  await writeFile(
    preload,
    `import cp from 'node:child_process';import os from 'node:os';import {readFile,appendFile} from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import 'node:path';
const native=process.platform==='win32';const exec=cp.execFile;cp.execFile=(file,args,opts,cb)=>native&&(opts.env?.AGENT_STACK_DIR||opts.env?.AGENT_STACK_PROBE_PID)?exec(file,args,opts,cb):exec(process.execPath,['-e',opts.env?.AGENT_STACK_DIR?"console.log('safe')":opts.env?.AGENT_STACK_PROBE_PID?"console.log('0,34404')":"console.log('herdr 0.9.5')"],opts,cb);
const spawn=cp.spawn;cp.spawn=(file,args,opts)=>spawn(process.execPath,['-e',String(file).toLowerCase().endsWith('herdr.exe')?(process.env.BAD_HERDR_VERSION?"console.log('herdr 9.9.9')":"console.log('herdr 0.9.5')"):String(file).toLowerCase().endsWith('git.exe')?"console.log('git version 2.40.0')":"console.log('11.0.0')"],opts);
if(!native){Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'x64'});os.machine=()=> 'x86_64';}syncBuiltinESMExports();globalThis.fetch=async()=>{await appendFile(${JSON.stringify(marker)},'x');if(process.env.NO_FETCH)throw Error('unexpected download');if(process.env.BAD_ASSET)return new Response('bad');if(process.env.MALICIOUS_ARCHIVE)return new Response(await readFile(${JSON.stringify(badArchivePath)}));if(process.env.LOCK_DRIFT)await appendFile(${JSON.stringify(join(repo, "stack/stack.lock.json"))},' ');if(process.env.SOURCE_DRIFT)await appendFile(${JSON.stringify(join(repo, "stack/components/herdr.yaml"))},'\\n');if(process.env.PATHEXT_DRIFT)process.env.PATHEXT='.exe;.cmd';if(process.env.TEMP_DRIFT)process.env.TEMP=${JSON.stringify(base)};return new Response(await readFile(${JSON.stringify(archivePath)}))};`,
  );
  const run = (extra = {}, options = []) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        cli,
        "setup",
        "--repo",
        repo,
        "--profile",
        "herdr-only",
        ...options,
        "--yes",
        "--json",
      ],
      {
        cwd: base,
        encoding: "utf8",
        timeout: 60000,
        env: { ...env, ...extra },
      },
    );
  await mkdir(join(bin, "conpty"));
  const conflict = run({ NO_FETCH: "1" });
  assert.equal(conflict.status, 1, conflict.stderr + conflict.stdout);
  await assert.rejects(access(marker));
  await rm(join(bin, "conpty"), { recursive: true });
  const bad = run({ BAD_ASSET: "1" });
  assert.equal(bad.status, 1, bad.stderr + bad.stdout);
  assert.match(bad.stderr + bad.stdout, /SHA-256 mismatch/);
  await assert.rejects(access(join(home, ".agent-stack/binding.json")));
  await assert.rejects(access(join(home, ".agent-stack/pending.json")));
  const malicious = run({ MALICIOUS_ARCHIVE: "1" }, ["--lock", badLock]);
  assert.equal(malicious.status, 1, malicious.stderr + malicious.stdout);
  assert.match(
    malicious.stderr + malicious.stdout,
    /Invalid Herdr Windows archive/,
  );
  await assert.rejects(access(join(home, ".agent-stack/binding.json")));
  await assert.rejects(access(join(home, ".agent-stack/pending.json")));
  const lockFile = join(repo, "stack/stack.lock.json"),
    sourceFile = join(repo, "stack/components/herdr.yaml");
  const lockBytes = await readFile(lockFile),
    sourceBytes = await readFile(sourceFile);
  for (const mode of [
    "LOCK_DRIFT",
    "SOURCE_DRIFT",
    "PATHEXT_DRIFT",
    "TEMP_DRIFT",
  ]) {
    const failed = run({ [mode]: "1" });
    assert.equal(failed.status, 1, failed.stderr + failed.stdout);
    assert.match(failed.stderr + failed.stdout, /changed after planning/);
    await assert.rejects(access(join(home, ".agent-stack/binding.json")));
    await assert.rejects(access(join(home, ".agent-stack/pending.json")));
    await writeFile(lockFile, lockBytes);
    await writeFile(sourceFile, sourceBytes);
  }
  const uvReceipt = {
    version: "0.13.8",
    target: "darwin-x64",
    mode: "external",
    directory: null,
    uvHash: null,
    uvxHash: null,
  };
  await writeFile(
    join(home, ".agent-stack/binding.json"),
    JSON.stringify({
      schemaVersion: 2,
      defaultBinding: { repo, profile: "uv-only", lock: join(base, "uv.lock") },
      installations: { uv: uvReceipt },
    }),
  );
  const first = run();
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.mode, "install");
  assert.equal(report.binding.installations.herdr.target, "win32-x64");
  assert.deepEqual(report.binding.installations.uv, uvReceipt);
  const state = await readFile(join(home, ".agent-stack/binding.json"));
  assert.equal(await readFile(marker, "utf8"), "xxxxxxx");
  const repeat = run({ NO_FETCH: "1" });
  assert.equal(repeat.status, 0, repeat.stderr + repeat.stdout);
  assert.equal(JSON.parse(repeat.stdout).mode, "managed");
  assert.deepEqual(
    await readFile(join(home, ".agent-stack/binding.json")),
    state,
  );
  assert.equal(await readFile(marker, "utf8"), "xxxxxxx");
  await writeFile(join(bin, "conpty/conpty.dll"), "local drift");
  const drift = run({ NO_FETCH: "1" });
  assert.equal(drift.status, 1, drift.stderr + drift.stdout);
  assert.match(drift.stderr + drift.stdout, /Managed Herdr entry changed/);
  assert.deepEqual(
    await readFile(join(home, ".agent-stack/binding.json")),
    state,
  );
  assert.equal(
    await readFile(join(bin, "conpty/conpty.dll"), "utf8"),
    "local drift",
  );
  assert.equal(await readFile(marker, "utf8"), "xxxxxxx");
  await rm(join(home, ".agent-stack"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(home, ".agent-stack/binding.json"),
    JSON.stringify({
      schemaVersion: 2,
      defaultBinding: { repo, profile: "uv-only", lock: join(base, "uv.lock") },
      installations: { uv: uvReceipt },
    }),
  );
  const beforeExternal = await readFile(
    join(home, ".agent-stack/binding.json"),
  );
  await writeFile(join(tools, "herdr.exe"), pe(0xaa64), { mode: 0o755 });
  const wrongArch = run({ NO_FETCH: "1" });
  assert.equal(wrongArch.status, 1, wrongArch.stderr + wrongArch.stdout);
  assert.match(
    wrongArch.stderr + wrongArch.stdout,
    /Cannot verify existing Herdr entry identity/,
  );
  assert.deepEqual(
    await readFile(join(home, ".agent-stack/binding.json")),
    beforeExternal,
  );
  await writeFile(join(tools, "herdr.exe"), fixture().get("herdr.exe"), {
    mode: 0o755,
  });
  const mismatch = run({ NO_FETCH: "1", BAD_HERDR_VERSION: "1" });
  assert.equal(mismatch.status, 1, mismatch.stderr + mismatch.stdout);
  assert.match(mismatch.stderr + mismatch.stdout, /conflicts with the lock/);
  assert.deepEqual(
    await readFile(join(home, ".agent-stack/binding.json")),
    beforeExternal,
  );
  const external = run({ NO_FETCH: "1" });
  assert.equal(external.status, 0, external.stderr + external.stdout);
  const externalReport = JSON.parse(external.stdout);
  assert.equal(externalReport.mode, "reuse");
  assert.equal(externalReport.binding.installations.herdr.source, "unknown");
  assert.equal(externalReport.binding.installations.herdr.target, "win32-x64");
  assert.deepEqual(externalReport.binding.installations.uv, uvReceipt);
  assert.equal(await readFile(marker, "utf8"), "xxxxxxx");
});

test("Windows bundle adapter rejects a non-x64 process before I/O", async () => {
  const { spawnSync } = await import("node:child_process");
  const moduleUrl = new URL("../dist/adapters/uv-state.js", import.meta.url)
    .href;
  const source = `import 'node:path';Object.defineProperty(process,'platform',{value:'win32'});Object.defineProperty(process,'arch',{value:'arm64'});const {applyWindowsHerdr}=await import(${JSON.stringify(moduleUrl)});try{await applyWindowsHerdr({target:'win32-x64'});process.exitCode=1}catch(error){if(!/requires native Windows x64/.test(error.message))throw error}`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
});
