import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { z } from "zod";

export const hash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
export function decodeState<T>(schema: z.ZodType<T>, raw: string): T {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Invalid local setup state");
  }
}

// Windows mode bits do not distinguish owner/group/other. Inspect the
// directory DACL directly and fail closed on untrusted write-capable ACEs.
async function windowsDirectorySecure(path: string): Promise<boolean> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) return false;
  const program = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = `$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$user=$identity.User.Value
$acl=([IO.DirectoryInfo]::new($env:AGENT_STACK_DIR)).GetAccessControl([Security.AccessControl.AccessControlSections]'Owner, Access')
$descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
if ($null -eq $descriptor.DiscretionaryAcl) { exit 5 }
foreach($ace in $descriptor.DiscretionaryAcl) {
 if (-not ($ace -is [Security.AccessControl.CommonAce]) -or $ace.IsCallback -or
     ($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -and $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessDenied)) { exit 5 }
}
$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$trusted=@($user,'S-1-5-18','S-1-5-32-544','S-1-3-0','S-1-3-4')
if ($owner -ne $user -and $owner -ne 'S-1-5-32-544') { exit 3 }
foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
 if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
     (([long]$rule.FileSystemRights -band 0x500D0156) -ne 0) -and
     $rule.IdentityReference.Value -notin $trusted) { exit 4 }
}
[Console]::Out.WriteLine('safe')`;
  const temporaryRoot = tmpdir();
  if (!isAbsolute(temporaryRoot)) return false;
  const temporary = await mkdtemp(join(temporaryRoot, "agent-stack-acl-"));
  try {
    return await new Promise<boolean>((done) => {
      let closed = false;
      let result: boolean | undefined;
      const finish = () => {
        if (closed && result !== undefined) done(result);
      };
      const child = execFile(
        program,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          cwd: temporary,
          env: {
            SystemRoot: systemRoot,
            AGENT_STACK_DIR: path,
            HOME: temporary,
            USERPROFILE: temporary,
            APPDATA: temporary,
            LOCALAPPDATA: temporary,
            TEMP: temporary,
            TMP: temporary,
          },
          timeout: 5000,
          maxBuffer: 4096,
          killSignal: "SIGKILL",
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout) => {
          result = !error && stdout.trim() === "safe";
          finish();
        },
      );
      child.stdin?.end();
      child.once("close", () => {
        closed = true;
        finish();
      });
    });
  } finally {
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}
export async function safeDir(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Managed directory has unsafe ownership or permissions");
  if (process.platform === "win32") {
    if (!(await windowsDirectorySecure(path)))
      throw new Error("Managed directory has unsafe ownership or permissions");
  } else if (
    (info.mode & 0o022n) !== 0n ||
    (process.getuid && info.uid !== BigInt(process.getuid()))
  )
    throw new Error("Managed directory has unsafe ownership or permissions");
  const canonical = await realpath(path);
  const resolved = resolve(path);
  if (canonical !== resolved)
    throw new Error("Managed directory must not traverse symlinks");
  const after = await lstat(path, { bigint: true });
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== info.dev ||
    after.ino !== info.ino ||
    after.ino === 0n
  )
    throw new Error("Managed directory changed during inspection");
}
export async function optionalBytes(path: string) {
  let entry: BigIntStats;
  try {
    entry = await lstat(path, { bigint: true });
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.ino === 0n)
    throw new Error("Invalid local setup state");
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (missing(error)) throw new Error("Invalid local setup state");
    throw error;
  }
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size > 65536n ||
      before.dev !== entry.dev ||
      before.ino !== entry.ino
    )
      throw new Error("Invalid local setup state");
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      length > 65536 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== BigInt(length) ||
      after.mtimeNs !== before.mtimeNs
    )
      throw new Error("Invalid local setup state");
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function optional(path: string) {
  const value = await optionalBytes(path);
  return value === null ? null : value.toString("utf8");
}

export async function inode(path: string) {
  const value = await lstat(path, { bigint: true });
  if (!value.isFile() || value.isSymbolicLink() || value.ino === 0n)
    throw new Error("Cannot verify managed file ownership");
  return { dev: String(value.dev), ino: String(value.ino) };
}
export async function assertFileUnchanged(
  path: string,
  expected: { dev: string; ino: string },
  bytes: Buffer,
) {
  const current = await inode(path);
  const contents = await optionalBytes(path);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    contents === null ||
    !contents.equals(bytes)
  )
    throw new Error("Binding changed after planning");
}
export async function boundedFileHash(
  path: string,
  expected: { dev: string; ino: string },
) {
  const pathBefore = await inode(path);
  if (pathBefore.dev !== expected.dev || pathBefore.ino !== expected.ino)
    throw new Error("Managed file changed or exceeds size limit");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      String(before.dev) !== expected.dev ||
      String(before.ino) !== expected.ino ||
      before.size > BigInt(128 * 1024 * 1024)
    )
      throw new Error("Managed file changed or exceeds size limit");
    const buffer = Buffer.alloc(65536),
      digest = createHash("sha256");
    let total = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 128 * 1024 * 1024)
        throw new Error("Managed file exceeds size limit");
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    const pathAfter = await inode(path);
    if (
      pathAfter.dev !== expected.dev ||
      pathAfter.ino !== expected.ino ||
      after.size !== BigInt(total) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeNs !== before.mtimeNs
    )
      throw new Error("Managed file changed during inspection");
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}
export async function removeOwned(path: string, dev: string, ino: string) {
  try {
    const item = await inode(path);
    if (item.dev !== dev || item.ino !== ino)
      throw new Error("Managed entry changed; manual recovery required");
    await unlink(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
export async function removeIfOwned(
  path: string,
  dev: string,
  ino: string,
): Promise<boolean> {
  try {
    const item = await inode(path);
    if (item.dev !== dev || item.ino !== ino) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (missing(error)) return true;
    throw error;
  }
}
export async function directoryInode(path: string) {
  const value = await lstat(path, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink() || value.ino === 0n)
    throw new Error("Cannot verify managed directory ownership");
  return { dev: String(value.dev), ino: String(value.ino) };
}
export async function withOperationGuard<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const guard = join(root, "operation.guard");
  try {
    await mkdir(guard, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(
        "Another setup operation is acquiring the lock; if interrupted, inspect operation.guard for manual recovery",
      );
    throw error;
  }
  try {
    return await action();
  } finally {
    await rmdir(guard);
  }
}
