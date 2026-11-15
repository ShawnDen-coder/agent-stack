// Native-only regression using real NTFS inheritance and the production safeDir consumer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32")
  throw Error("Requires native Windows; no platform spoofing");
const modulePath = resolve(
  process.argv[2] ?? "dist/adapters/managed-operation.js",
);
const { safeDir } = await import(pathToFileURL(modulePath).href);
assert.equal(typeof safeDir, "function");
const systemRoot = process.env.SystemRoot;
assert.ok(
  systemRoot && isAbsolute(systemRoot),
  "Absolute SystemRoot is required",
);
const powershell = join(
  systemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const base = await realpath(await mkdtemp(join(tmpdir(), "as-generic-acl-")));
const previous = Object.fromEntries(
  ["HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"].map((k) => [
    k,
    process.env[k],
  ]),
);
const env = {
  SystemRoot: systemRoot,
  HOME: base,
  USERPROFILE: base,
  TEMP: base,
  TMP: base,
  APPDATA: base,
  LOCALAPPDATA: base,
};
const run = (script, extra = {}) => {
  const result = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      cwd: base,
      env: { ...env, ...extra },
      encoding: "utf8",
      input: "",
      timeout: 30000,
      maxBuffer: 65536,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
};
const setup = `$ErrorActionPreference='Stop'
$u=[Security.Principal.WindowsIdentity]::GetCurrent().User
$di=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:TEST_BASE))
if ($di.DriveFormat -ne 'NTFS') { throw 'This diagnostic requires real NTFS' }
$a=[Security.AccessControl.DirectorySecurity]::new()
$a.SetOwner($u)
$a.SetAccessRuleProtection($true,$false)
$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($u,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
[IO.Directory]::SetAccessControl($env:TEST_BASE,$a)
@{fileSystem=$di.DriveFormat;psVersion=$PSVersionTable.PSVersion.ToString();osVersion=[Environment]::OSVersion.Version.ToString()} | ConvertTo-Json -Compress`;
const configure = `$ErrorActionPreference='Stop'
$u=[Security.Principal.WindowsIdentity]::GetCurrent().User
$everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
function AceRows($raw) {
 $rows=@()
 foreach($a in $raw.DiscretionaryAcl) {
  if ($a -is [Security.AccessControl.CommonAce] -and $a.SecurityIdentifier.Value -eq 'S-1-1-0') {
   $rows+=@{mask=('0x{0:X8}' -f $a.AccessMask);writeBits=([long]$a.AccessMask -band 0xD0156);genericBits=([long]$a.AccessMask -band 0x50000000);flags=[int]$a.AceFlags;allow=($a.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed)}
  }
 }
 return $rows
}
function ReadAcl($p,$directory) {
 if ($directory) {$acl=([IO.DirectoryInfo]::new($p)).GetAccessControl([Security.AccessControl.AccessControlSections]'Owner, Access')}
 else {$acl=([IO.FileInfo]::new($p)).GetAccessControl([Security.AccessControl.AccessControlSections]'Owner, Access')}
 $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
 $rules=@()
 foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($r.IdentityReference.Value -eq 'S-1-1-0') {$rules+=@{mask=('0x{0:X8}' -f [int]$r.FileSystemRights);writeBits=([long]$r.FileSystemRights -band 0xD0156);genericBits=([long]$r.FileSystemRights -band 0x50000000);inheritance=[int]$r.InheritanceFlags;propagation=[int]$r.PropagationFlags;inherited=$r.IsInherited;allow=($r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow)}}
 }
 return @{ownerIsCurrentUser=($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $u.Value);raw=@(AceRows $raw);rules=$rules}
}
$p=$env:TEST_DIR
[IO.Directory]::CreateDirectory($p) | Out-Null
$dacl=[Security.AccessControl.RawAcl]::new(2,2)
$dacl.InsertAce(0,[Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]3,[Security.AccessControl.AceQualifier]::AccessAllowed,0x1F01FF,$u,$false,$null))
$mask=[int]::Parse($env:TEST_MASK)
if ($mask -ne 0) {$dacl.InsertAce(1,[Security.AccessControl.CommonAce]::new(([Security.AccessControl.AceFlags]([int]::Parse($env:TEST_FLAGS))),[Security.AccessControl.AceQualifier]::AccessAllowed,$mask,$everyone,$false,$null))}
$raw=[Security.AccessControl.RawSecurityDescriptor]::new([Security.AccessControl.ControlFlags]0x9004,$u,$u,$null,$dacl)
$bytes=New-Object byte[] ($raw.BinaryLength)
$raw.GetBinaryForm($bytes,0)
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetSecurityDescriptorBinaryForm($bytes,[Security.AccessControl.AccessControlSections]'Owner, Access')
$prePersist=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
[IO.Directory]::SetAccessControl($p,$acl)
$child=[IO.Path]::Combine($p,'child')
[IO.Directory]::CreateDirectory($child) | Out-Null
$directFile=[IO.Path]::Combine($p,'direct.txt')
$nestedFile=[IO.Path]::Combine($child,'nested.txt')
[IO.File]::WriteAllText($directFile,'fixture')
[IO.File]::WriteAllText($nestedFile,'fixture')
@{input=@(AceRows $raw);prePersist=@(AceRows $prePersist);parent=(ReadAcl $p $true);child=(ReadAcl $child $true);directFile=(ReadAcl $directFile $false);nestedFile=(ReadAcl $nestedFile $false)} | ConvertTo-Json -Depth 12 -Compress`;
const cases = [{ name: "owner-only-control", mask: 0, flags: 0 }];
for (const [label, mask] of [
  ["write", 0x40000000],
  ["all", 0x10000000],
])
  for (const [scope, flags] of [
    ["self", 0],
    ["oi", 1],
    ["oici", 3],
    ["oici-io", 11],
  ])
    cases.push({ name: `generic-${label}-${scope}`, mask, flags });
const reports = [];
let suspicious = false;
try {
  const platform = run(setup, { TEST_BASE: base });
  for (const k of Object.keys(previous)) process.env[k] = base;
  await safeDir(base); // Proves the real helper works before measuring suspicious ACLs.
  for (const c of cases) {
    const path = join(base, c.name);
    const evidence = run(configure, {
      TEST_DIR: path,
      TEST_MASK: String(c.mask),
      TEST_FLAGS: String(c.flags),
    });
    assert.equal(evidence.parent.ownerIsCurrentUser, true);
    if (c.mask !== 0)
      assert.ok(
        evidence.input.some(
          (a) => a.allow && a.genericBits === c.mask && a.writeBits === 0,
        ),
        "Probe must submit an actual generic-only CommonAce",
      );
    const decisions = {};
    for (const [label, at] of [
      ["parent", path],
      ["child", join(path, "child")],
    ]) {
      try {
        await safeDir(at);
        decisions[label] = { accepted: true };
      } catch (error) {
        decisions[label] = {
          accepted: false,
          message: String(error.message).slice(0, 2048),
        };
      }
    }
    if (c.mask === 0)
      assert.equal(
        decisions.parent.accepted,
        true,
        "Owner-only control must be accepted",
      );
    const childWrite = ["child", "directFile", "nestedFile"].some((k) =>
      evidence[k].raw.some((a) => a.allow && a.writeBits !== 0),
    );
    const retained = evidence.parent.raw.some(
      (a) => a.allow && a.genericBits !== 0,
    );
    const acceptedGeneric = retained && decisions.parent.accepted;
    if (acceptedGeneric && childWrite) suspicious = true;
    const report = { ...c, evidence, decisions, acceptedGeneric, childWrite };
    reports.push(report);
    console.log(JSON.stringify({ kind: "case", ...report }));
  }
  console.log(
    JSON.stringify({
      kind: "summary",
      platform,
      moduleSha256: createHash("sha256")
        .update(await readFile(modulePath))
        .digest("hex"),
      cases: reports.length,
      suspicious,
      note: "ACL masks and actual safeDir decisions; does not impersonate an unrelated user or claim a privilege exploit",
    }),
  );
  assert.equal(reports.length, 9, "All NTFS ACL cases must run");
  const owner = reports.find((report) => report.name === "owner-only-control");
  assert.equal(
    owner.decisions.parent.accepted,
    true,
    "Owner-only parent must be accepted",
  );
  assert.equal(
    owner.decisions.child.accepted,
    true,
    "Owner-only child must be accepted",
  );
  for (const report of reports.filter((item) => item.mask !== 0)) {
    assert.equal(
      report.decisions.parent.accepted,
      false,
      `${report.name}: untrusted generic write must be rejected`,
    );
  }
  for (const name of ["generic-write-oici-io", "generic-all-oici-io"]) {
    const report = reports.find((item) => item.name === name);
    assert.ok(
      report.evidence.parent.raw.some(
        (ace) =>
          ace.allow &&
          ace.genericBits === report.mask &&
          (ace.flags & 11) === 11,
      ),
      `${name}: parent must retain its inherit-only generic ACE`,
    );
    for (const child of ["child", "directFile"]) {
      assert.ok(
        report.evidence[child].raw.some(
          (ace) => ace.allow && ace.writeBits !== 0,
        ),
        `${name}: ${child} must inherit write access`,
      );
    }
    assert.equal(
      report.decisions.child.accepted,
      false,
      `${name}: inherited child write must be rejected`,
    );
  }
  assert.equal(
    suspicious,
    false,
    "Inheritable untrusted write must never be accepted",
  );
} finally {
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(base, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
