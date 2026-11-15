import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { safeDir } from "../dist/adapters/managed-operation.js";

test("native Windows refuses write access for Everyone on managed directories", {
  skip: process.platform !== "win32" || !process.env.SystemRoot,
  timeout: 45000,
}, async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "herdr-acl-")));
  const previousTemp = process.env.TEMP,
    previousTmp = process.env.TMP;
  process.env.TEMP = home;
  process.env.TMP = home;
  t.after(async () => {
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
    await rm(home, { recursive: true, force: true });
  });
  const dir = join(home, "managed");
  await mkdir(dir);
  const powershell = join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = `$ErrorActionPreference='Stop'
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true,$false)
$rule=[Security.AccessControl.FileSystemAccessRule]::new($user,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($env:TEST_DIR,$acl)`;
  const configured = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      cwd: home,
      env: {
        SystemRoot: process.env.SystemRoot,
        TEST_DIR: dir,
        HOME: home,
        USERPROFILE: home,
        TMP: home,
        TEMP: home,
        APPDATA: home,
        LOCALAPPDATA: home,
      },
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    },
  );
  assert.equal(configured.status, 0, configured.stderr);
  await safeDir(dir);
  const icacls = join(process.env.SystemRoot, "System32", "icacls.exe");
  const unsafe = spawnSync(icacls, [dir, "/grant", "*S-1-1-0:(OI)(CI)M"], {
    cwd: home,
    env: {
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      TMP: home,
      TEMP: home,
      APPDATA: home,
      LOCALAPPDATA: home,
    },
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(unsafe.status, 0, unsafe.stderr);
  await assert.rejects(safeDir(dir), /unsafe ownership or permissions/);
});
