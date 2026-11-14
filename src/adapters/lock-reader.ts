import { constants } from "node:fs";
import { open } from "node:fs/promises";

const maxBytes = 1024 * 1024;
export async function readLock(path: string): Promise<unknown> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK,
  ).catch(() => {
    throw new Error("Cannot read lock file");
  });
  try {
    if (!(await file.stat()).isFile())
      throw new Error("Lock must be a regular file");
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
    if (length > maxBytes) throw new Error("Lock exceeds size limit");
    try {
      return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
    } catch {
      throw new Error("Lock is not valid JSON");
    }
  } finally {
    await file.close();
  }
}
