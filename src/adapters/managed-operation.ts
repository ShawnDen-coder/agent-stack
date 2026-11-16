import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
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

export async function safeDir(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o022) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Managed directory has unsafe ownership or permissions");
  if ((await realpath(path)) !== resolve(path))
    throw new Error("Managed directory must not traverse symlinks");
}
export async function optionalBytes(path: string) {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > 65536n)
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
    if (
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
    if (
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
