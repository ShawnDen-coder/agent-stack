import { constants } from "node:fs";
import { open } from "node:fs/promises";

const maxBytes = 1024 * 1024;
export class LockReadError extends Error {
  repo?: string;
  constructor(
    message: string,
    readonly reason: string,
    readonly path: string,
  ) {
    super(message);
  }
}
export async function readLock(path: string): Promise<unknown> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    throw new LockReadError(
      "Cannot read lock file",
      error.code === "ENOENT" ? "lock_missing" : "lock_inaccessible",
      path,
    );
  });
  try {
    if (!(await file.stat()).isFile())
      throw new LockReadError(
        "Lock must be a regular file",
        "lock_inaccessible",
        path,
      );
    const buffer = Buffer.alloc(maxBytes + 1);
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
    if (length > maxBytes)
      throw new LockReadError("Lock exceeds size limit", "lock_invalid", path);
    try {
      return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
    } catch {
      throw new LockReadError("Lock is not valid JSON", "lock_invalid", path);
    }
  } finally {
    await file.close();
  }
}
