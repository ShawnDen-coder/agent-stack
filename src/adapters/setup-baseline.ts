import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Repository } from "../core/schema.js";
import { validateRepository } from "../core/validate.js";
import { validateLock } from "../core/validate-lock.js";
import { readLock } from "./lock-reader.js";
import { readRepository } from "./repository.js";
import { setupStateFingerprint } from "./setup-state.js";

async function digest(path: string, maxBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes))
      throw new Error(
        "Setup input exceeds size limit or is not a regular file",
      );
    const buffer = Buffer.alloc(65536),
      hash = createHash("sha256");
    let total = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("Setup input exceeds size limit");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== BigInt(total) ||
      after.mtimeNs !== before.mtimeNs
    )
      throw new Error("Setup input changed during inspection");
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

export async function setupBaseline(
  repo: string,
  lock: string,
  repository: Repository,
  profile: string,
  components: string[],
  integrations: string[],
) {
  const paths = [
    `profiles/${profile}`,
    ...components.map((id) => `components/${id}`),
    ...integrations.map((id) => `integrations/${id}`),
  ]
    .sort()
    .map((id) => {
      const location = repository.locations[id];
      if (!location) throw new Error(`Missing declaration location: ${id}`);
      return location;
    });
  const values = await Promise.all([
    digest(lock, 1024 * 1024),
    ...paths.map((path) => digest(join(repo, path), 4 * 1024 * 1024)),
  ]);
  return JSON.stringify({
    paths,
    values,
    binding: await setupStateFingerprint(process.env.HOME),
    home: process.env.HOME ?? null,
    path: process.env.PATH ?? null,
    platform: process.platform,
    arch: process.arch,
  });
}
export async function recheckSetupBaseline(
  expected: string,
  repo: string,
  lockPath: string,
  profile: string,
  components: string[],
  integrations: string[],
) {
  const repository = await readRepository(repo);
  if (!validateRepository(repository).valid)
    throw new Error("Repository changed after planning");
  validateLock(await readLock(lockPath), repository);
  const actual = await setupBaseline(
    repo,
    lockPath,
    repository,
    profile,
    components,
    integrations,
  );
  if (actual !== expected)
    throw new Error("Setup inputs changed after planning");
}
