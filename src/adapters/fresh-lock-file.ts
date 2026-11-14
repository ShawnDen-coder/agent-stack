import { randomUUID } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  throw new Error(`File already exists: ${path}`);
}
export async function publishNewLock(
  path: string,
  inputPath: string,
  contents: string,
  signal: AbortSignal,
): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temp, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await requireAbsent(inputPath);
    await requireAbsent(path);
    if (signal.aborted) throw new Error("Cancelled");
    await link(temp, path);
  } finally {
    if (created) {
      try {
        await unlink(temp);
      } catch {
        // Do not report a failed publication after the hard link succeeded.
      }
    }
  }
}
