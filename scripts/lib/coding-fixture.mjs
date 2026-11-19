import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Pin all bytes of the reviewed production-generated lock, including digests.
export const codingLockSha256 =
  "3af2abd9f989beb6b544fa69f0dff85a952a0f0758d96b02f15e09133ab52736";

export async function verifyCodingLock(repo) {
  const lock = await readFile(join(repo, "stack", "stack.lock.json"));
  if (createHash("sha256").update(lock).digest("hex") !== codingLockSha256)
    throw Error("Coding lock SHA-256 mismatch");
}
