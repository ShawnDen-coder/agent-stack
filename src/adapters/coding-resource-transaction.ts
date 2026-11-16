import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import {
  directoryInode,
  inode,
  optionalBytes,
  removeOwned,
  safeDir,
} from "./managed-operation.js";

const identity = z.strictObject({
  dev: z.string().min(1),
  ino: z.string().min(1),
});
const itemSchema = z
  .strictObject({
    target: z.string().refine(isAbsolute),
    beforeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    beforeMode: z.number().int().min(0).max(0o777).nullable(),
    afterMode: z.number().int().min(0).max(0o777),
    before: identity.nullable(),
    backup: identity.nullable(),
    afterHash: z.string().regex(/^[a-f0-9]{64}$/),
    after: identity,
  })
  .refine(
    (item) =>
      (item.before === null) === (item.beforeHash === null) &&
      (item.before === null) === (item.beforeMode === null) &&
      (item.before === null) === (item.backup === null),
  );
const journalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  directory: z.string().regex(/^resource-stage-[a-f0-9]{32}$/),
  stage: identity,
  items: z.array(itemSchema).min(1).max(4),
});
type Identity = z.infer<typeof identity>;
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
async function same(
  path: string,
  expected: Identity,
  digest: string,
  mode?: number,
) {
  try {
    const id = await inode(path);
    if (id.dev !== expected.dev || id.ino !== expected.ino) return false;
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat({ bigint: true });
      if (
        !info.isFile() ||
        info.size > 1024n * 1024n ||
        String(info.dev) !== id.dev ||
        String(info.ino) !== id.ino ||
        (mode !== undefined && Number(info.mode & 0o777n) !== mode)
      )
        return false;
      const buffer = Buffer.alloc(Number(info.size) + 1);
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
      const bytes = buffer.subarray(0, length);
      const after = await file.stat({ bigint: true });
      const finalIdentity = await inode(path);
      return (
        finalIdentity.dev === id.dev &&
        finalIdentity.ino === id.ino &&
        info.size === after.size &&
        BigInt(length) === info.size &&
        info.mode === after.mode &&
        info.mtimeNs === after.mtimeNs &&
        hash(bytes) === digest
      );
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function absent(path: string) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
async function create(path: string, bytes: Buffer, mode = 0o600) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.chmod(mode);
    await file.sync();
    const stat = await file.stat({ bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino) };
  } finally {
    await file.close();
  }
}
async function ensureParent(
  home: string,
  target: string,
  recheck: () => Promise<void>,
  signal: AbortSignal,
) {
  const parent = dirname(target),
    rel = relative(home, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    await safeDir(parent);
    return;
  }
  await safeDir(home);
  let current = home;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (signal.aborted) throw new Error("Cancelled");
    await recheck();
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await safeDir(current);
  }
}

// The caller holds Agent Stack's operation lease. Unrecognized or modified
// journal data always blocks; recovery only restores verified owned entries.
export async function recoverCodingResources(home: string, allowed: string[]) {
  const root = join(home, ".agent-stack"),
    journalPath = join(root, "resources.pending.json");
  await safeDir(root);
  const raw = await optionalBytes(journalPath);
  if (raw === null) return false;
  const journalIdentity = await inode(journalPath);
  const journal = journalSchema.parse(JSON.parse(raw.toString("utf8")));
  if (
    journal.items.some((item) => !allowed.includes(item.target)) ||
    new Set(journal.items.map((item) => item.target)).size !==
      journal.items.length
  )
    throw new Error("Resource journal target mismatch");
  await safeDir(root);
  const stage = join(root, journal.directory);
  await safeDir(stage);
  const stageId = await directoryInode(stage);
  if (stageId.dev !== journal.stage.dev || stageId.ino !== journal.stage.ino)
    throw new Error("Resource staging changed; manual recovery required");
  for (let i = journal.items.length - 1; i >= 0; i--) {
    const item = journal.items[i];
    if (!item) throw new Error("Invalid resource journal");
    await safeDir(dirname(item.target));
    const beforePath = join(stage, `before-${i}`);
    const suffix = `${journal.directory.slice("resource-stage-".length)}-${i}`;
    const forwardTemp = join(
      dirname(item.target),
      `.agent-stack-resource-${suffix}`,
    );
    const restoreTemp = join(
      dirname(item.target),
      `.agent-stack-restore-${suffix}`,
    );
    if (!(await absent(forwardTemp))) {
      if (
        !(await same(forwardTemp, item.after, item.afterHash, item.afterMode))
      )
        throw new Error(
          "Resource temporary entry changed; manual recovery required",
        );
      await removeOwned(forwardTemp, item.after.dev, item.after.ino);
    }
    if (!(await absent(restoreTemp))) {
      if (
        !item.backup ||
        !item.beforeHash ||
        !(await same(
          restoreTemp,
          item.backup,
          item.beforeHash,
          item.beforeMode ?? undefined,
        ))
      )
        throw new Error(
          "Resource restore entry changed; manual recovery required",
        );
      await removeOwned(restoreTemp, item.backup.dev, item.backup.ino);
    }
    const beforePresent =
      item.before &&
      item.beforeHash &&
      (await same(
        item.target,
        item.before,
        item.beforeHash,
        item.beforeMode ?? undefined,
      ));
    const restored =
      item.backup &&
      item.beforeHash &&
      (await same(
        item.target,
        item.backup,
        item.beforeHash,
        item.beforeMode ?? undefined,
      ));
    if (
      beforePresent ||
      restored ||
      (item.before === null && (await absent(item.target)))
    )
      continue;
    if (!(await same(item.target, item.after, item.afterHash, item.afterMode)))
      throw new Error("Resource target changed; manual recovery required");
    if (item.before === null) await unlink(item.target);
    else {
      if (
        !item.backup ||
        !item.beforeHash ||
        !(await same(
          beforePath,
          item.backup,
          item.beforeHash,
          item.beforeMode ?? undefined,
        ))
      )
        throw new Error("Resource backup changed; manual recovery required");
      const restore = restoreTemp;
      await link(beforePath, restore);
      try {
        if (
          !(await same(item.target, item.after, item.afterHash, item.afterMode))
        )
          throw new Error("Resource target changed; manual recovery required");
        await rename(restore, item.target);
      } finally {
        await removeOwned(restore, item.backup.dev, item.backup.ino);
      }
    }
  }
  if (!(await same(journalPath, journalIdentity, hash(raw))))
    throw new Error("Resource journal changed; manual recovery required");
  await unlink(journalPath);
  // Stage data is deliberately retained as backup evidence; no recursive cleanup
  // of unknown entries is authorized by a directory identity alone.
  return true;
}

export async function publishCodingResources(input: {
  home: string;
  directory?: string;
  files: Array<{
    target: string;
    before: Buffer | null;
    beforeMode: number | null;
    after: Buffer;
  }>;
  signal: AbortSignal;
  recheck: () => Promise<void>;
}) {
  const root = join(input.home, ".agent-stack");
  await safeDir(root);
  const journalPath = join(root, "resources.pending.json");
  if (!(await absent(journalPath)))
    throw new Error("Pending resource operation requires recovery");
  for (const file of input.files) {
    if (
      !isAbsolute(file.target) ||
      file.after.length > 1024 * 1024 ||
      (file.before?.length ?? 0) > 1024 * 1024
    )
      throw new Error("Invalid resource target");
    if (input.signal.aborted) throw new Error("Cancelled");
    await input.recheck();
    await ensureParent(input.home, file.target, input.recheck, input.signal);
  }
  const directory =
    input.directory ?? `resource-stage-${randomBytes(16).toString("hex")}`;
  if (!/^resource-stage-[a-f0-9]{32}$/.test(directory))
    throw Error("Invalid resource backup directory");
  const stage = join(root, directory);
  if (input.signal.aborted) throw new Error("Cancelled");
  await input.recheck();
  await mkdir(stage, { mode: 0o700 });
  const stageId = await directoryInode(stage);
  const items: z.infer<typeof itemSchema>[] = [];
  let journalPublished = false;
  try {
    for (const [i, file] of input.files.entries()) {
      if (input.signal.aborted) throw new Error("Cancelled");
      await input.recheck();
      const before = file.before === null ? null : await inode(file.target);
      if (
        file.before === null
          ? !(await absent(file.target))
          : !before || !(await same(file.target, before, hash(file.before)))
      )
        throw new Error("Resource target changed after planning");
      if ((file.before === null) !== (file.beforeMode === null))
        throw new Error("Invalid resource mode baseline");
      const mode = file.beforeMode ?? 0o600;
      if (
        before &&
        file.before &&
        !(await same(file.target, before, hash(file.before), mode))
      )
        throw new Error("Resource permissions changed after planning");
      const backup =
        file.before === null
          ? null
          : await create(join(stage, `before-${i}`), file.before, mode);
      const after = await create(join(stage, `after-${i}`), file.after, mode);
      items.push({
        target: file.target,
        beforeHash: file.before === null ? null : hash(file.before),
        beforeMode: file.beforeMode,
        afterMode: mode,
        before,
        backup,
        afterHash: hash(file.after),
        after,
      });
    }
    const journal = journalSchema.parse({
      schemaVersion: 1,
      directory,
      stage: stageId,
      items,
    });
    const raw = Buffer.from(JSON.stringify(journal));
    await create(join(stage, "backup-map.json"), raw);
    const pending = await create(join(stage, "journal"), raw);
    await input.recheck();
    if (input.signal.aborted) throw new Error("Cancelled");
    await link(join(stage, "journal"), journalPath);
    journalPublished = true;
    for (const [i, item] of items.entries()) {
      if (input.signal.aborted) throw new Error("Cancelled");
      await input.recheck();
      await safeDir(dirname(item.target));
      if (
        !(await same(
          join(stage, `after-${i}`),
          item.after,
          item.afterHash,
          item.afterMode,
        ))
      )
        throw new Error("Resource staging changed");
      if (item.before === null) {
        if (!(await absent(item.target)))
          throw new Error("Resource target changed after planning");
        await link(join(stage, `after-${i}`), item.target);
      } else {
        if (
          !item.beforeHash ||
          !(await same(
            item.target,
            item.before,
            item.beforeHash,
            item.beforeMode ?? undefined,
          ))
        )
          throw new Error("Resource target changed after planning");
        // Hard-link a sibling temporary file so rename stays on the target filesystem.
        const temp = join(
          dirname(item.target),
          `.agent-stack-resource-${directory.slice("resource-stage-".length)}-${i}`,
        );
        await link(join(stage, `after-${i}`), temp);
        try {
          if (
            !(await same(
              item.target,
              item.before,
              item.beforeHash,
              item.beforeMode ?? undefined,
            ))
          )
            throw new Error("Resource target changed after planning");
          await rename(temp, item.target);
        } finally {
          await removeOwned(temp, item.after.dev, item.after.ino);
        }
      }
    }
    if (input.signal.aborted) throw new Error("Cancelled");
    await input.recheck();
    for (const item of items)
      if (
        !(await same(item.target, item.after, item.afterHash, item.afterMode))
      )
        throw new Error("Published resource changed before completion");
    if (!(await same(journalPath, pending, hash(raw))))
      throw new Error("Resource journal changed");
    await unlink(journalPath);
    journalPublished = false;
    return;
  } catch (error) {
    if (journalPublished)
      await recoverCodingResources(
        input.home,
        input.files.map((file) => file.target),
      );
    throw error;
  }
}
