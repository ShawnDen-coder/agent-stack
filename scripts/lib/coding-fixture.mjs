import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Pin all bytes of the reviewed production-generated lock, including digests.
export const codingLockSha256 =
  "3af2abd9f989beb6b544fa69f0dff85a952a0f0758d96b02f15e09133ab52736";

export async function copyCodingFixture(fixture, repo) {
  const [profile, lock] = await Promise.all([
    readFile(join(fixture, "profile.json")),
    readFile(join(fixture, "stack.lock.json")),
  ]);
  if (createHash("sha256").update(lock).digest("hex") !== codingLockSha256)
    throw Error("Coding lock fixture SHA-256 mismatch");
  await rm(join(repo, "stack/profiles/coding.yaml"));
  await writeFile(join(repo, "stack/profiles/coding.json"), profile, {
    flag: "wx",
  });
  await writeFile(join(repo, "stack/stack.lock.json"), lock, { flag: "wx" });
}
