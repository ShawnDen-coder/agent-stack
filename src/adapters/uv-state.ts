import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import semver from "semver";
import { z } from "zod";
import { readUvArchive } from "./uv-archive.js";
import { downloadUv } from "./uv-download.js";
import { verifyUvVersion } from "./uv-version.js";

export class UvCommittedError extends Error {}

const bindingSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    repo: z.string().refine(isAbsolute),
    profile: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    lock: z.string().refine(isAbsolute),
    uv: z.strictObject({
      version: z.string().refine((value) => semver.valid(value) === value),
      target: z.enum(["darwin-arm64", "darwin-x64"]),
      mode: z.enum(["managed", "external"]),
      directory: z.string().nullable(),
      uvHash: z.string().nullable(),
      uvxHash: z.string().nullable(),
      asset: z
        .strictObject({
          name: z.string(),
          url: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          releaseId: z.number().int().positive(),
          assetId: z.number().int().positive(),
        })
        .optional(),
    }),
  })
  .refine((binding) =>
    binding.uv.mode === "managed"
      ? Boolean(
          binding.uv.directory &&
            /^uv-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/.test(
              binding.uv.directory,
            ) &&
            binding.uv.uvHash &&
            /^[a-f0-9]{64}$/.test(binding.uv.uvHash) &&
            binding.uv.uvxHash &&
            /^[a-f0-9]{64}$/.test(binding.uv.uvxHash),
        )
      : binding.uv.directory === null &&
        binding.uv.uvHash === null &&
        binding.uv.uvxHash === null,
  );
export type UvBinding = z.infer<typeof bindingSchema>;
const pendingSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    stage: z
      .string()
      .regex(/^uv-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/),
    uvDev: z.string(),
    uvIno: z.string(),
    uvxDev: z.string(),
    uvxIno: z.string(),
    stageDev: z.string(),
    stageIno: z.string(),
    uvHash: z.string().regex(/^[a-f0-9]{64}$/),
    uvxHash: z.string().regex(/^[a-f0-9]{64}$/),
    bindingTmp: z
      .string()
      .regex(
        /^binding-uv-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}\.tmp$/,
      )
      .nullable(),
    bindingDev: z.string().nullable(),
    bindingIno: z.string().nullable(),
  })
  .refine(
    (pending) =>
      (pending.bindingTmp === null &&
        pending.bindingDev === null &&
        pending.bindingIno === null) ||
      (pending.bindingTmp !== null &&
        pending.bindingDev !== null &&
        pending.bindingIno !== null),
  );
type Pending = z.infer<typeof pendingSchema>;
const identitySchema = z.strictObject({ dev: z.string(), ino: z.string() });
const stagedFileSchema = identitySchema.extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
type StagedFile = z.infer<typeof stagedFileSchema>;
const ownerSchema = z.strictObject({
  pid: z.number().int().positive(),
  temporary: z
    .strictObject({
      name: z.string().regex(/^binding-[a-f0-9]{32}\.tmp$/),
      identity: identitySchema.nullable(),
    })
    .nullable(),
  stage: z
    .strictObject({
      name: z
        .string()
        .regex(/^uv-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/),
      identity: identitySchema.nullable(),
      files: z.partialRecord(
        z.enum(["archive.tar.gz", "uv", "uvx"]),
        stagedFileSchema,
      ),
    })
    .nullable(),
});
type Owner = z.infer<typeof ownerSchema>;

const hash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
function decodeState<T>(schema: z.ZodType<T>, raw: string): T {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Invalid local setup state");
  }
}

export function uvPaths(home: string, path: string) {
  if (!isAbsolute(home)) throw new Error("HOME must be an absolute directory");
  const root = join(resolve(home), ".agent-stack");
  const bin = join(root, "bin");
  if (!path.split(delimiter).some((part) => part && resolve(part) === bin))
    throw new Error(`Add ${bin} to PATH in your shell before setup`);
  return { root, bin };
}
async function safeDir(path: string) {
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
async function optional(path: string) {
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
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function readUvBinding(
  home: string | undefined,
): Promise<UvBinding | null> {
  if (!home || !isAbsolute(home)) return null;
  const data = await optional(join(home, ".agent-stack", "binding.json"));
  return data === null ? null : decodeState(bindingSchema, data);
}
export async function uvBindingFingerprint(
  home: string | undefined,
): Promise<string | null> {
  if (!home || !isAbsolute(home)) return null;
  const value = await optional(join(home, ".agent-stack", "binding.json"));
  return value === null ? null : hash(Buffer.from(value));
}
async function inode(path: string) {
  const value = await lstat(path, { bigint: true });
  if (!value.isFile() || value.isSymbolicLink() || value.ino === 0n)
    throw new Error("Cannot verify managed file ownership");
  return { dev: String(value.dev), ino: String(value.ino) };
}
async function boundedFileHash(
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
async function removeOwned(path: string, dev: string, ino: string) {
  try {
    const item = await inode(path);
    if (item.dev !== dev || item.ino !== ino)
      throw new Error("Managed entry changed; manual recovery required");
    await unlink(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
async function removeIfOwned(
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
async function directoryInode(path: string) {
  const value = await lstat(path, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink() || value.ino === 0n)
    throw new Error("Cannot verify managed directory ownership");
  return { dev: String(value.dev), ino: String(value.ino) };
}
async function cleanupStage(
  stage: string,
  expected: { dev: string; ino: string },
  created: Map<string, StagedFile>,
) {
  const actual = await directoryInode(stage);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino)
    throw new Error("Staging directory changed; manual recovery required");
  for (const name of await readdir(stage)) {
    const identity = created.get(name);
    if (!identity)
      throw new Error("Unexpected staging file; manual recovery required");
    if (
      (await boundedFileHash(join(stage, name), identity)) !== identity.sha256
    )
      throw new Error("Staging file changed; manual recovery required");
    await removeOwned(join(stage, name), identity.dev, identity.ino);
  }
  await rmdir(stage);
}
async function createOwned(
  path: string,
  contents: Buffer,
  mode: number,
  created: Map<string, StagedFile>,
  name: string,
  record: (name: string, identity: StagedFile) => Promise<void>,
) {
  const file = await open(path, "wx", mode);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.ino === 0n)
      throw new Error("Cannot verify staged file ownership");
    const identity = {
      dev: String(info.dev),
      ino: String(info.ino),
      sha256: hash(contents),
    };
    created.set(name, identity);
    await record(name, identity);
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function recover(root: string, bin: string, home: string) {
  const path = join(root, "pending.json");
  const raw = await optional(path);
  if (!raw) return;
  const journalIdentity = await inode(path);
  const removeJournal = async () => {
    if ((await optional(path)) !== raw)
      throw new Error("Recovery journal changed; manual review required");
    await removeOwned(path, journalIdentity.dev, journalIdentity.ino);
  };
  const pending = decodeState(pendingSchema, raw);
  const stage = join(root, pending.stage);
  const stageIdentity = await directoryInode(stage);
  if (
    stageIdentity.dev !== pending.stageDev ||
    stageIdentity.ino !== pending.stageIno
  )
    throw new Error("Staging directory changed; manual recovery required");
  if (pending.bindingTmp) {
    if (!pending.bindingDev || !pending.bindingIno)
      throw new Error("Incomplete binding ownership; manual recovery required");
    await removeOwned(
      join(root, pending.bindingTmp),
      pending.bindingDev,
      pending.bindingIno,
    );
  }
  const binding = await readUvBinding(home);
  if (
    binding?.uv.mode === "managed" &&
    binding.uv.directory === pending.stage
  ) {
    const a = await inode(join(bin, "uv"));
    const b = await inode(join(bin, "uvx"));
    if (
      a.dev !== pending.uvDev ||
      a.ino !== pending.uvIno ||
      b.dev !== pending.uvxDev ||
      b.ino !== pending.uvxIno ||
      (await boundedFileHash(join(bin, "uv"), a)) !== binding.uv.uvHash ||
      (await boundedFileHash(join(bin, "uvx"), b)) !== binding.uv.uvxHash
    )
      throw new Error("Published uv entries changed; manual recovery required");
    await removeJournal();
    return;
  }
  const sourceUv = { dev: pending.uvDev, ino: pending.uvIno },
    sourceUvx = { dev: pending.uvxDev, ino: pending.uvxIno };
  if (
    (await boundedFileHash(join(stage, "uv"), sourceUv)) !== pending.uvHash ||
    (await boundedFileHash(join(stage, "uvx"), sourceUvx)) !== pending.uvxHash
  )
    throw new Error("Staged uv entries changed; manual recovery required");
  const uvOwned = await removeIfOwned(
    join(bin, "uv"),
    pending.uvDev,
    pending.uvIno,
  );
  const uvxOwned = await removeIfOwned(
    join(bin, "uvx"),
    pending.uvxDev,
    pending.uvxIno,
  );
  await removeOwned(join(stage, "uv"), pending.uvDev, pending.uvIno);
  await removeOwned(join(stage, "uvx"), pending.uvxDev, pending.uvxIno);
  await rmdir(stage);
  await removeJournal();
  if (!uvOwned || !uvxOwned)
    throw new Error("Conflicting uv entry was preserved during recovery");
}
type Operation = {
  tempIntent(name: string): Promise<void>;
  tempIdentity(identity: z.infer<typeof identitySchema>): Promise<void>;
  tempClear(): Promise<void>;
  stageIntent(name: string): Promise<void>;
  stage(name: string, identity: z.infer<typeof identitySchema>): Promise<void>;
  file(name: string, identity: StagedFile | null): Promise<void>;
  release(committed?: boolean): Promise<void>;
};

async function acquire(root: string): Promise<Operation> {
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
    return await acquireGuarded(root);
  } finally {
    await rmdir(guard);
  }
}

async function acquireGuarded(root: string): Promise<Operation> {
  const path = join(root, "operation.lock");
  let owner: Owner = { pid: process.pid, stage: null, temporary: null };
  let raw = JSON.stringify(owner);
  try {
    const file = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    const info = await file.stat({ bigint: true });
    try {
      await file.writeFile(raw);
      await file.sync();
      await file.close();
    } catch (error) {
      await file.close().catch(() => {});
      await removeOwned(path, String(info.dev), String(info.ino));
      throw error;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
    const before = await inode(path),
      previous = await optional(path);
    const old = decodeState(ownerSchema, previous ?? "null");
    try {
      process.kill(old.pid, 0);
      throw new Error("Another setup operation is running");
    } catch (probe) {
      if (
        !(probe instanceof Error && "code" in probe && probe.code === "ESRCH")
      )
        throw probe;
    }
    if (old.temporary) {
      const tmp = join(root, old.temporary.name);
      if (old.temporary.identity)
        await removeOwned(
          tmp,
          old.temporary.identity.dev,
          old.temporary.identity.ino,
        );
      else if (!(await uvEntryAbsent(tmp)))
        throw new Error(
          "Temporary binding ownership is incomplete; manual recovery required",
        );
    }
    if (old.stage && !(await optional(join(root, "pending.json")))) {
      const binding = await readUvBinding(dirname(root));
      if (
        !(
          binding?.uv.mode === "managed" &&
          binding.uv.directory === old.stage.name
        )
      ) {
        const stage = join(root, old.stage.name);
        if (!old.stage.identity) {
          if (!(await uvEntryAbsent(stage)))
            throw new Error(
              "Staging ownership is incomplete; manual recovery required",
            );
        } else {
          try {
            await cleanupStage(
              stage,
              old.stage.identity,
              new Map(Object.entries(old.stage.files)),
            );
          } catch (cleanup) {
            if (!missing(cleanup)) throw cleanup;
          }
        }
      }
    }
    const after = await inode(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      (await optional(path)) !== previous
    )
      throw new Error("Operation lock changed");
    await unlink(path);
    return acquireGuarded(root);
  }
  const created = await inode(path);
  const update = async (next: Owner) => {
    const current = await inode(path);
    if (
      current.dev !== created.dev ||
      current.ino !== created.ino ||
      (await optional(path)) !== raw
    )
      throw new Error("Operation lock changed");
    const file = await open(path, "r+");
    try {
      const info = await file.stat({ bigint: true });
      if (String(info.dev) !== created.dev || String(info.ino) !== created.ino)
        throw new Error("Operation lock changed");
      const value = JSON.stringify(next);
      await file.truncate(0);
      await file.writeFile(value);
      await file.sync();
      owner = next;
      raw = value;
    } finally {
      await file.close();
    }
  };
  return {
    async tempIntent(name: string) {
      await update({ ...owner, temporary: { name, identity: null } });
    },
    async tempIdentity(identity: { dev: string; ino: string }) {
      if (!owner.temporary) throw new Error("Missing temporary binding intent");
      await update({ ...owner, temporary: { ...owner.temporary, identity } });
    },
    async tempClear() {
      await update({ ...owner, temporary: null });
    },
    async stageIntent(name: string) {
      await update({ ...owner, stage: { name, identity: null, files: {} } });
    },
    async stage(name: string, identity: { dev: string; ino: string }) {
      await update({ ...owner, stage: { name, identity, files: {} } });
    },
    async file(name: string, identity: StagedFile | null) {
      if (!owner.stage || !["archive.tar.gz", "uv", "uvx"].includes(name))
        throw new Error("Invalid staging record");
      const files = { ...owner.stage.files };
      if (identity) files[name as "uv" | "uvx" | "archive.tar.gz"] = identity;
      else delete files[name as "uv" | "uvx" | "archive.tar.gz"];
      await update({ ...owner, stage: { ...owner.stage, files } });
    },
    async release(committed = false) {
      try {
        if ((await optional(path)) !== raw)
          throw new Error("Operation lock changed; manual recovery required");
        await removeOwned(path, created.dev, created.ino);
      } catch (error) {
        if (committed)
          throw new UvCommittedError(
            "uv binding was published; operation lock cleanup needs manual review",
          );
        throw error;
      }
    },
  };
}

export async function inspectUvPath(home: string, path: string) {
  const paths = uvPaths(home, path);
  try {
    await safeDir(paths.root);
    await safeDir(paths.bin);
  } catch (error) {
    if (missing(error))
      throw new Error(`Create ${paths.bin} and add it to PATH before setup`);
    throw error;
  }
  const root = await lstat(paths.root, { bigint: true }),
    bin = await lstat(paths.bin, { bigint: true });
  return {
    ...paths,
    identity: `${root.dev}:${root.ino}:${bin.dev}:${bin.ino}`,
  };
}
export async function uvEntryAbsent(path: string) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (missing(error)) return true;
    throw error;
  }
}
export async function applyUv(input: {
  home: string;
  path: string;
  repo: string;
  profile: string;
  lock: string;
  version: string;
  target: string;
  asset: {
    name: string;
    url: string;
    sha256: string;
    releaseId: number;
    assetId: number;
  };
  signal: AbortSignal;
  recheck: () => Promise<void>;
  checkReachable: () => Promise<void>;
}) {
  const { root, bin } = await inspectUvPath(input.home, input.path);
  const operation = await acquire(root);
  let stage: string | undefined;
  let stageIdentity: { dev: string; ino: string } | undefined;
  const created = new Map<string, StagedFile>();
  let pending: Pending | undefined;
  let journalCreated = false;
  let published = false;
  const finishOperation = async () => {
    if (published) {
      await operation.release(true);
      return;
    }
    try {
      if (pending && journalCreated) await recover(root, bin, input.home);
      else if (stage && stageIdentity)
        await cleanupStage(stage, stageIdentity, created);
      else if (stage && !(await uvEntryAbsent(stage)))
        throw new Error(
          "Staging ownership is incomplete; manual recovery required",
        );
    } catch (error) {
      if (
        !(await optional(join(root, "pending.json"))) &&
        (!stage || (await uvEntryAbsent(stage)))
      )
        await operation.release();
      throw error;
    }
    await operation.release();
  };
  try {
    await recover(root, bin, input.home);
    await input.recheck();
    if (
      !(await uvEntryAbsent(join(bin, "uv"))) ||
      !(await uvEntryAbsent(join(bin, "uvx")))
    )
      throw new Error("uv or uvx entry already exists; refusing to overwrite");
    const stageName = `uv-${input.version}-${input.target}-${randomBytes(16).toString("hex")}`;
    stage = join(root, stageName);
    await operation.stageIntent(stageName);
    await mkdir(stage, { mode: 0o700 });
    stageIdentity = await directoryInode(stage);
    await operation.stage(stageName, stageIdentity);
    if (input.signal.aborted) throw new Error("Cancelled");
    const archive = await downloadUv(
      input.asset.url,
      input.asset.sha256,
      input.signal,
    );
    await createOwned(
      join(stage, "archive.tar.gz"),
      archive,
      0o600,
      created,
      "archive.tar.gz",
      operation.file,
    );
    const files = await readUvArchive(
      join(stage, "archive.tar.gz"),
      input.asset.name,
      input.signal,
    );
    if (input.signal.aborted) throw new Error("Cancelled");
    const archived = created.get("archive.tar.gz");
    if (!archived) throw new Error("Missing archive ownership");
    await removeOwned(
      join(stage, "archive.tar.gz"),
      archived.dev,
      archived.ino,
    );
    created.delete("archive.tar.gz");
    await operation.file("archive.tar.gz", null);
    const uv = files.get("uv"),
      uvx = files.get("uvx");
    if (!uv || !uvx) throw new Error("Missing uv entries");
    await createOwned(
      join(stage, "uv"),
      uv,
      0o755,
      created,
      "uv",
      operation.file,
    );
    await createOwned(
      join(stage, "uvx"),
      uvx,
      0o755,
      created,
      "uvx",
      operation.file,
    );
    if (input.signal.aborted) throw new Error("Cancelled");
    await verifyUvVersion(
      join(stage, "uv"),
      "uv",
      input.version,
      stage,
      input.signal,
    );
    await verifyUvVersion(
      join(stage, "uvx"),
      "uvx",
      input.version,
      stage,
      input.signal,
    );
    const stagedEntries = (await readdir(stage)).sort();
    if (
      stagedEntries.length !== 2 ||
      stagedEntries[0] !== "uv" ||
      stagedEntries[1] !== "uvx"
    )
      throw new Error("Unexpected staged files; manual recovery required");
    const a = await inode(join(stage, "uv")),
      b = await inode(join(stage, "uvx"));
    if (
      (await boundedFileHash(join(stage, "uv"), a)) !== hash(uv) ||
      (await boundedFileHash(join(stage, "uvx"), b)) !== hash(uvx)
    )
      throw new Error("Staged uv entries changed during verification");
    pending = {
      schemaVersion: 1,
      stage: stageName,
      uvDev: a.dev,
      uvIno: a.ino,
      uvxDev: b.dev,
      uvxIno: b.ino,
      stageDev: stageIdentity.dev,
      stageIno: stageIdentity.ino,
      uvHash: hash(uv),
      uvxHash: hash(uvx),
      bindingTmp: null,
      bindingDev: null,
      bindingIno: null,
    };
    const journalPath = join(root, "pending.json");
    const journal = await open(journalPath, "wx", 0o600);
    const journalInfo = await journal.stat({ bigint: true });
    try {
      await journal.writeFile(JSON.stringify(pending));
      await journal.sync();
      journalCreated = true;
    } catch (error) {
      await journal.close();
      await removeOwned(
        journalPath,
        String(journalInfo.dev),
        String(journalInfo.ino),
      );
      throw error;
    }
    await journal.close();
    await input.recheck();
    if (input.signal.aborted) throw new Error("Cancelled");
    await link(join(stage, "uv"), join(bin, "uv"));
    if (input.signal.aborted) throw new Error("Cancelled");
    await input.recheck();
    await link(join(stage, "uvx"), join(bin, "uvx"));
    await verifyUvVersion(
      join(bin, "uv"),
      "uv",
      input.version,
      stage,
      input.signal,
    );
    await verifyUvVersion(
      join(bin, "uvx"),
      "uvx",
      input.version,
      stage,
      input.signal,
    );
    await input.recheck();
    await input.checkReachable();
    const finalEntries = (await readdir(stage)).sort();
    if (
      finalEntries.length !== 2 ||
      finalEntries[0] !== "uv" ||
      finalEntries[1] !== "uvx"
    )
      throw new Error("Unexpected staged files; manual recovery required");
    if (
      (await boundedFileHash(join(bin, "uv"), a)) !== hash(uv) ||
      (await boundedFileHash(join(bin, "uvx"), b)) !== hash(uvx)
    )
      throw new Error("Published uv entries changed during verification");
    if (input.signal.aborted) throw new Error("Cancelled");
    const binding = bindingSchema.parse({
      schemaVersion: 1,
      repo: input.repo,
      profile: input.profile,
      lock: input.lock,
      uv: {
        version: input.version,
        target: input.target,
        mode: "managed",
        directory: stageName,
        uvHash: hash(uv),
        uvxHash: hash(uvx),
        asset: input.asset,
      },
    });
    const bindingPath = join(root, "binding.json");
    if (await optional(bindingPath))
      throw new Error(
        "Existing binding requires review; refusing to replace it",
      );
    if (!pending) throw new Error("Missing recovery journal");
    const tmpName = `binding-${stageName}.tmp`;
    const tmp = join(root, tmpName);
    const file = await open(tmp, "wx", 0o600);
    const tmpInfo = await file.stat({ bigint: true });
    let tmpCleanupError: unknown;
    try {
      const previousJournal = JSON.stringify(pending);
      const nextPending = {
        ...pending,
        bindingTmp: tmpName,
        bindingDev: String(tmpInfo.dev),
        bindingIno: String(tmpInfo.ino),
      };
      if ((await optional(journalPath)) !== previousJournal)
        throw new Error("Recovery journal changed");
      const nextJournal = Buffer.from(JSON.stringify(nextPending));
      const journal = await open(
        journalPath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      try {
        const info = await journal.stat({ bigint: true });
        if (info.dev !== journalInfo.dev || info.ino !== journalInfo.ino)
          throw new Error("Recovery journal changed");
        await journal.truncate(0);
        let offset = 0;
        while (offset < nextJournal.length) {
          const { bytesWritten } = await journal.write(
            nextJournal,
            offset,
            nextJournal.length - offset,
            offset,
          );
          if (!bytesWritten) throw new Error("Cannot write recovery journal");
          offset += bytesWritten;
        }
        await journal.sync();
        pending = nextPending;
      } finally {
        await journal.close();
      }
      await file.writeFile(JSON.stringify(binding));
      await file.sync();
      await file.close();
      await link(tmp, bindingPath);
      published = true;
    } catch (error) {
      await file.close().catch(() => {});
      throw error;
    } finally {
      try {
        await removeOwned(tmp, String(tmpInfo.dev), String(tmpInfo.ino));
      } catch (error) {
        tmpCleanupError = error;
      }
    }
    if (tmpCleanupError)
      throw new UvCommittedError(
        "uv was installed and bound; cleanup remains pending, rerun setup to recover",
      );
    try {
      if ((await optional(journalPath)) !== JSON.stringify(pending))
        throw new Error("Recovery journal changed");
      await removeOwned(
        journalPath,
        String(journalInfo.dev),
        String(journalInfo.ino),
      );
    } catch {
      throw new UvCommittedError(
        "uv was installed and bound; cleanup remains pending, rerun setup to recover",
      );
    }
    return binding;
  } finally {
    await finishOperation();
  }
}

export async function matchesManagedUv(
  home: string,
  binding: UvBinding,
  version: string,
  target: string,
  asset: {
    name: string;
    url: string;
    sha256: string;
    releaseId: number;
    assetId: number;
  },
): Promise<boolean> {
  if (
    binding.uv.mode !== "managed" ||
    binding.uv.version !== version ||
    binding.uv.target !== target ||
    !binding.uv.asset ||
    binding.uv.asset.name !== asset.name ||
    binding.uv.asset.url !== asset.url ||
    binding.uv.asset.sha256 !== asset.sha256 ||
    binding.uv.asset.releaseId !== asset.releaseId ||
    binding.uv.asset.assetId !== asset.assetId ||
    !binding.uv.directory ||
    !/^uv-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/.test(
      binding.uv.directory,
    ) ||
    !binding.uv.uvHash ||
    !binding.uv.uvxHash
  )
    return false;
  const root = join(resolve(home), ".agent-stack"),
    bin = join(root, "bin"),
    stage = join(root, binding.uv.directory);
  try {
    await safeDir(root);
    await safeDir(bin);
    await safeDir(stage);
    for (const [name, expected] of [
      ["uv", binding.uv.uvHash],
      ["uvx", binding.uv.uvxHash],
    ] as const) {
      const source = await inode(join(stage, name)),
        entry = await inode(join(bin, name));
      const info = await lstat(join(stage, name));
      if (
        info.size > 128 * 1024 * 1024 ||
        source.dev !== entry.dev ||
        source.ino !== entry.ino ||
        (await boundedFileHash(join(stage, name), source)) !== expected
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function bindExternalUv(input: {
  home: string;
  repo: string;
  profile: string;
  lock: string;
  version: string;
  target: string;
  managed?: UvBinding;
  rootIdentity: string | null;
  signal: AbortSignal;
  recheck: () => Promise<void>;
}) {
  if (!isAbsolute(input.home))
    throw new Error("HOME must be an absolute directory");
  const root = join(resolve(input.home), ".agent-stack");
  let createdRoot: { dev: string; ino: string } | undefined;
  try {
    await mkdir(root, { mode: 0o700 });
    createdRoot = await directoryInode(root);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  let completed = false;
  try {
    await safeDir(root);
    const rootAtStart = await directoryInode(root);
    const currentRoot = `${rootAtStart.dev}:${rootAtStart.ino}`;
    if (
      input.rootIdentity === null
        ? !createdRoot
        : currentRoot !== input.rootIdentity
    )
      throw new Error("Setup state directory changed after planning");
    const operation = await acquire(root);
    try {
      await input.recheck();
      if (input.signal.aborted) throw new Error("Cancelled");
      const binding = bindingSchema.parse({
        schemaVersion: 1,
        repo: input.repo,
        profile: input.profile,
        lock: input.lock,
        uv: input.managed?.uv ?? {
          version: input.version,
          target: input.target,
          mode: "external",
          directory: null,
          uvHash: null,
          uvxHash: null,
        },
      });
      const path = join(root, "binding.json"),
        existing = await optional(path);
      let previousIdentity: { dev: string; ino: string } | undefined;
      if (existing !== null) {
        const old = decodeState(bindingSchema, existing);
        if (JSON.stringify(old) === JSON.stringify(binding)) {
          completed = true;
          return old;
        }
        if (
          old.uv.version !== input.version ||
          old.uv.target !== input.target ||
          old.uv.mode !== binding.uv.mode ||
          (input.managed &&
            JSON.stringify(old.uv) !== JSON.stringify(input.managed.uv))
        )
          throw new Error("Existing binding has different uv ownership");
        previousIdentity = await inode(path);
      }
      const tmpName = `binding-${randomBytes(16).toString("hex")}.tmp`;
      const tmp = join(root, tmpName);
      await operation.tempIntent(tmpName);
      const file = await open(tmp, "wx", 0o600);
      const info = await file.stat({ bigint: true });
      const cleanup = async () => {
        try {
          await removeOwned(tmp, String(info.dev), String(info.ino));
          await operation.tempClear();
        } catch (error) {
          if (completed)
            throw new UvCommittedError(
              "External uv binding was published; temporary state needs manual review",
            );
          throw error;
        }
      };
      try {
        await operation.tempIdentity({
          dev: String(info.dev),
          ino: String(info.ino),
        });
        try {
          await file.writeFile(JSON.stringify(binding));
          await file.sync();
        } finally {
          await file.close();
        }
        await input.recheck();
        const rootNow = await directoryInode(root);
        if (`${rootNow.dev}:${rootNow.ino}` !== currentRoot)
          throw new Error("Setup state directory changed after planning");
        if (input.signal.aborted) throw new Error("Cancelled");
        if (previousIdentity) {
          const current = await inode(path);
          if (
            current.dev !== previousIdentity.dev ||
            current.ino !== previousIdentity.ino ||
            (await optional(path)) !== existing
          )
            throw new Error("Binding changed after planning");
          await rename(tmp, path);
        } else await link(tmp, path);
        completed = true;
      } finally {
        await file.close().catch(() => {});
        await cleanup();
      }
      return binding;
    } finally {
      await operation.release(completed);
    }
  } finally {
    if (!completed && createdRoot) {
      const now = await directoryInode(root);
      if (
        now.dev === createdRoot.dev &&
        now.ino === createdRoot.ino &&
        (await readdir(root)).length === 0
      )
        await rmdir(root);
    }
  }
}

export async function hasPendingUv(home: string): Promise<boolean> {
  const raw = await optional(
    join(resolve(home), ".agent-stack", "pending.json"),
  );
  if (raw === null) return false;
  decodeState(pendingSchema, raw);
  return true;
}
export async function recoverPendingUv(
  home: string,
  path: string,
  signal: AbortSignal,
  recheck: () => Promise<void>,
) {
  if (signal.aborted) throw new Error("Cancelled");
  const { root, bin } = await inspectUvPath(home, path);
  const operation = await acquire(root);
  try {
    await recheck();
    if (signal.aborted) throw new Error("Cancelled");
    await recover(root, bin, home);
  } finally {
    await operation.release();
  }
}

export async function uvEntryFingerprint(path: string): Promise<string> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isFile() && !entry.isSymbolicLink())
    throw new Error("Cannot verify uv entry identity");
  const target = await realpath(path);
  const identity = await inode(target);
  const digest = await boundedFileHash(target, identity);
  const after = await lstat(path, { bigint: true });
  if (
    entry.dev !== after.dev ||
    entry.ino !== after.ino ||
    entry.mtimeNs !== after.mtimeNs
  )
    throw new Error("uv entry changed during inspection");
  return JSON.stringify({
    entryDev: String(entry.dev),
    entryIno: String(entry.ino),
    target,
    identity,
    digest,
  });
}

export async function uvRootIdentity(home: string): Promise<string | null> {
  if (!isAbsolute(home)) throw new Error("HOME must be an absolute directory");
  const root = join(resolve(home), ".agent-stack");
  try {
    await safeDir(root);
    const value = await directoryInode(root);
    return `${value.dev}:${value.ino}`;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
