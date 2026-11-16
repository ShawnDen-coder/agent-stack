import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
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
import { z } from "zod";
import type { CodingVerification } from "../core/coding-verification.js";
import { npmPendingSchema, npmStageName } from "../core/npm-state.js";
import {
  herdrWindowsNames,
  readHerdrWindowsArchive,
} from "./herdr-windows-archive.js";
import {
  assertFileUnchanged,
  boundedFileHash,
  decodeState,
  directoryInode,
  hash,
  inode,
  missing,
  optional,
  optionalBytes,
  removeIfOwned,
  removeOwned,
  safeDir,
  withOperationGuard,
} from "./managed-operation.js";
import { removeManagedTree, treeManifestName } from "./managed-tree.js";
import {
  decodeSetupState,
  readSetupState,
  type SetupState,
  setupStateSchema,
  type UvReceipt,
  windowsHerdrDirs,
  windowsHerdrFileSchema,
} from "./setup-state.js";
import { readUvArchive } from "./uv-archive.js";
import { downloadRelease, downloadUv } from "./uv-download.js";
import { verifyUvVersion } from "./uv-version.js";

export class UvCommittedError extends Error {}

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
const pendingV2Schema = z
  .strictObject({
    ...pendingSchema.shape,
    schemaVersion: z.literal(2),
    kind: z.literal("uv-install"),
    beforeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    beforeIdentity: z
      .strictObject({ dev: z.string(), ino: z.string() })
      .nullable(),
    afterHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((x) => (x.beforeHash === null) === (x.beforeIdentity === null))
  .refine((x) => x.beforeHash !== x.afterHash)
  .refine(
    (x) =>
      (x.bindingTmp === null &&
        x.bindingDev === null &&
        x.bindingIno === null) ||
      (x.bindingTmp !== null &&
        x.bindingDev === null &&
        x.bindingIno === null) ||
      (x.bindingTmp !== null && x.bindingDev !== null && x.bindingIno !== null),
  );
const herdrPendingSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    kind: z.literal("herdr-install"),
    stage: z
      .string()
      .regex(/^herdr-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/),
    stageDev: z.string(),
    stageIno: z.string(),
    entryDev: z.string(),
    entryIno: z.string(),
    entryHash: z.string().regex(/^[a-f0-9]{64}$/),
    beforeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    beforeIdentity: z
      .strictObject({ dev: z.string(), ino: z.string() })
      .nullable(),
    afterHash: z.string().regex(/^[a-f0-9]{64}$/),
    bindingTmp: z
      .string()
      .regex(/^binding-[a-f0-9]{32}\.tmp$/)
      .nullable(),
    bindingIdentity: z
      .strictObject({ dev: z.string(), ino: z.string() })
      .nullable(),
  })
  .refine((x) => (x.beforeHash === null) === (x.beforeIdentity === null))
  .refine((x) => x.beforeHash !== x.afterHash)
  .refine((x) => x.bindingTmp !== null || x.bindingIdentity === null);
const windowsDirectoryPendingSchema = z
  .strictObject({
    name: z.enum(windowsHerdrDirs),
    phase: z.enum(["unattempted", "intent", "created"]),
    identity: z.strictObject({ dev: z.string(), ino: z.string() }).nullable(),
  })
  .refine((value) => (value.phase === "created") === (value.identity !== null));
const windowsHerdrPendingSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    kind: z.literal("herdr-windows-install"),
    stage: z.string().regex(/^herdr-\d+\.\d+\.\d+-win32-x64-[a-f0-9]{32}$/),
    stageDev: z.string(),
    stageIno: z.string(),
    files: z.array(windowsHerdrFileSchema).length(7),
    directories: z
      .array(windowsDirectoryPendingSchema)
      .length(4)
      .refine((dirs) =>
        dirs.every((dir, index) => dir.name === windowsHerdrDirs[index]),
      ),
    beforeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    beforeIdentity: z
      .strictObject({ dev: z.string(), ino: z.string() })
      .nullable(),
    afterHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    bindingTmp: z
      .string()
      .regex(/^binding-[a-f0-9]{32}\.tmp$/)
      .nullable(),
    bindingIdentity: z
      .strictObject({ dev: z.string(), ino: z.string() })
      .nullable(),
  })
  .refine((x) => (x.beforeHash === null) === (x.beforeIdentity === null))
  .refine((x) => x.afterHash === null || x.beforeHash !== x.afterHash)
  .refine((x) => x.bindingTmp !== null || x.bindingIdentity === null);
const allPendingSchema = z.union([
  pendingSchema,
  pendingV2Schema,
  herdrPendingSchema,
  windowsHerdrPendingSchema,
  npmPendingSchema,
]);
const anyPendingSchema = z.union([pendingSchema, pendingV2Schema]);
type Pending = z.infer<typeof anyPendingSchema>;
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
    .union([
      z.strictObject({
        name: npmStageName,
        identity: identitySchema.nullable(),
        files: z.partialRecord(z.literal(".ownership.json"), stagedFileSchema),
      }),
      z.strictObject({
        name: z
          .string()
          .regex(/^uv-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/),
        identity: identitySchema.nullable(),
        files: z.partialRecord(
          z.enum(["archive.tar.gz", "uv", "uvx"]),
          stagedFileSchema,
        ),
      }),
      z.strictObject({
        name: z
          .string()
          .regex(/^herdr-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/),
        identity: identitySchema.nullable(),
        files: z.partialRecord(z.enum(["herdr"]), stagedFileSchema),
      }),
      z.strictObject({
        name: z.string().regex(/^herdr-\d+\.\d+\.\d+-win32-x64-[a-f0-9]{32}$/),
        identity: identitySchema.nullable(),
        files: z.partialRecord(
          z.enum([
            "f0.exe",
            "f1.exe",
            "f2.exe",
            "f3.exe",
            "f4.exe",
            "f5.exe",
            "f6.exe",
          ]),
          stagedFileSchema,
        ),
      }),
    ])
    .nullable(),
});
type Owner = z.infer<typeof ownerSchema>;

export function uvPaths(home: string, path: string) {
  if (!isAbsolute(home)) throw new Error("HOME must be an absolute directory");
  const root = join(resolve(home), ".agent-stack");
  const bin = join(root, "bin");
  if (!path.split(delimiter).some((part) => part && resolve(part) === bin))
    throw new Error(`Add ${bin} to PATH in your shell before setup`);
  return { root, bin };
}
async function cleanupStage(
  stage: string,
  expected: { dev: string; ino: string },
  created: Map<string, StagedFile>,
) {
  const actual = await directoryInode(stage);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino)
    throw new Error("Staging directory changed; manual recovery required");
  const entries = (await readdir(stage)).sort();
  for (const name of entries) {
    const identity = created.get(name);
    if (!identity)
      throw new Error("Unexpected staging file; manual recovery required");
    if (
      (await boundedFileHash(join(stage, name), identity)) !== identity.sha256
    )
      throw new Error("Staging file changed; manual recovery required");
  }
  const checked = await directoryInode(stage);
  if (
    checked.dev !== expected.dev ||
    checked.ino !== expected.ino ||
    JSON.stringify((await readdir(stage)).sort()) !== JSON.stringify(entries)
  )
    throw new Error("Staging directory changed; manual recovery required");
  for (const name of entries) {
    const identity = created.get(name);
    if (!identity)
      throw new Error("Missing staging identity; manual recovery required");
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
async function recover(root: string, bin: string) {
  const path = join(root, "pending.json");
  const raw = await optional(path);
  if (raw === null) return;
  const journalIdentity = await inode(path);
  const removeJournal = async () => {
    if ((await optional(path)) !== raw)
      throw new Error("Recovery journal changed; manual review required");
    await removeOwned(path, journalIdentity.dev, journalIdentity.ino);
  };
  const allPending = decodeState(allPendingSchema, raw);
  if (allPending.schemaVersion === 2 && allPending.kind === "npm-install") {
    const { recoverNpmInstallation } = await import("./npm-state.js");
    await recoverNpmInstallation(root, bin, allPending, raw, journalIdentity);
    return;
  }
  if (
    allPending.schemaVersion === 2 &&
    allPending.kind === "herdr-windows-install"
  ) {
    await recoverWindowsHerdr(
      root,
      bin,
      allPending,
      path,
      raw,
      journalIdentity,
    );
    return;
  }
  if (allPending.schemaVersion === 2 && allPending.kind === "herdr-install") {
    await recoverHerdr(root, bin, allPending, path, raw, journalIdentity);
    return;
  }
  const pending = decodeState(anyPendingSchema, raw);
  const statePath = join(root, "binding.json");
  const stateBytes = await optionalBytes(statePath);
  const stateIdentity = stateBytes === null ? null : await inode(statePath);
  const state =
    stateBytes === null ? null : decodeSetupState(stateBytes.toString("utf8"));
  const stateHash = stateBytes === null ? null : hash(stateBytes);
  const receipt = state?.installations.uv;
  const committed =
    pending.schemaVersion === 2
      ? stateHash === pending.afterHash
      : receipt?.mode === "managed" && receipt.directory === pending.stage;
  if (pending.schemaVersion === 2) {
    if (!committed && stateHash !== pending.beforeHash)
      throw new Error("Setup state changed; manual recovery required");
    if (
      !committed &&
      stateBytes !== null &&
      (!pending.beforeIdentity ||
        stateIdentity?.dev !== pending.beforeIdentity.dev ||
        stateIdentity?.ino !== pending.beforeIdentity.ino)
    )
      throw new Error("Setup state identity changed; manual recovery required");
  }
  const stage = join(root, pending.stage);
  const stageIdentity = await directoryInode(stage);
  if (
    stageIdentity.dev !== pending.stageDev ||
    stageIdentity.ino !== pending.stageIno
  )
    throw new Error("Staging directory changed; manual recovery required");
  const sourceUv = { dev: pending.uvDev, ino: pending.uvIno },
    sourceUvx = { dev: pending.uvxDev, ino: pending.uvxIno };
  if (
    (await boundedFileHash(join(stage, "uv"), sourceUv)) !== pending.uvHash ||
    (await boundedFileHash(join(stage, "uvx"), sourceUvx)) !== pending.uvxHash
  )
    throw new Error("Staged uv entries changed; manual recovery required");
  if (committed) {
    if (
      receipt?.mode !== "managed" ||
      receipt.directory !== pending.stage ||
      receipt.uvHash !== pending.uvHash ||
      receipt.uvxHash !== pending.uvxHash ||
      (await boundedFileHash(join(bin, "uv"), sourceUv)) !== pending.uvHash ||
      (await boundedFileHash(join(bin, "uvx"), sourceUvx)) !== pending.uvxHash
    )
      throw new Error("Published uv entries changed; manual recovery required");
  }
  if (!committed && pending.schemaVersion === 2) {
    const entries = (await readdir(stage)).sort();
    if (entries.length !== 2 || entries[0] !== "uv" || entries[1] !== "uvx")
      throw new Error("Unexpected staging file; manual recovery required");
    for (const [name, expected] of [
      ["uv", sourceUv],
      ["uvx", sourceUvx],
    ] as const) {
      const entryPath = join(bin, name);
      if (!(await uvEntryAbsent(entryPath))) {
        const actual = await inode(entryPath);
        if (actual.dev !== expected.dev || actual.ino !== expected.ino)
          throw new Error(
            "Conflicting uv entry preserved; manual recovery required",
          );
      }
    }
  }
  if (
    pending.bindingTmp &&
    !(await uvEntryAbsent(join(root, pending.bindingTmp)))
  ) {
    if (!pending.bindingDev || !pending.bindingIno)
      throw new Error(
        "Temporary binding ownership is incomplete; manual recovery required",
      );
    const temp = await inode(join(root, pending.bindingTmp));
    if (temp.dev !== pending.bindingDev || temp.ino !== pending.bindingIno)
      throw new Error("Temporary binding changed; manual recovery required");
  }
  const currentState = await optionalBytes(statePath);
  if (
    (stateBytes === null) !== (currentState === null) ||
    (stateBytes !== null &&
      currentState !== null &&
      !stateBytes.equals(currentState))
  )
    throw new Error("Setup state changed; manual recovery required");
  if (stateIdentity && stateBytes)
    await assertFileUnchanged(statePath, stateIdentity, stateBytes);
  if ((await optional(path)) !== raw)
    throw new Error("Recovery journal changed; manual review required");
  const journalNow = await inode(path);
  if (
    journalNow.dev !== journalIdentity.dev ||
    journalNow.ino !== journalIdentity.ino
  )
    throw new Error("Recovery journal changed; manual review required");
  if (pending.bindingTmp && pending.bindingDev && pending.bindingIno)
    await removeOwned(
      join(root, pending.bindingTmp),
      pending.bindingDev,
      pending.bindingIno,
    );
  if (committed) {
    await removeJournal();
    return;
  }
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
async function recoverHerdr(
  root: string,
  bin: string,
  pending: z.infer<typeof herdrPendingSchema>,
  journalPath: string,
  journalRaw: string,
  journalIdentity: { dev: string; ino: string },
) {
  const statePath = join(root, "binding.json"),
    stateBytes = await optionalBytes(statePath);
  const stateIdentity = stateBytes === null ? null : await inode(statePath);
  const stateHash = stateBytes === null ? null : hash(stateBytes);
  if (stateHash !== pending.beforeHash && stateHash !== pending.afterHash)
    throw new Error("Setup state changed; manual recovery required");
  const committed = stateHash === pending.afterHash;
  if (
    !committed &&
    stateBytes !== null &&
    (!pending.beforeIdentity ||
      stateIdentity?.dev !== pending.beforeIdentity.dev ||
      stateIdentity.ino !== pending.beforeIdentity.ino)
  )
    throw new Error("Setup state identity changed; manual recovery required");
  const stage = join(root, pending.stage),
    stageId = await directoryInode(stage);
  if (stageId.dev !== pending.stageDev || stageId.ino !== pending.stageIno)
    throw new Error(
      "Herdr staging directory changed; manual recovery required",
    );
  const entry = { dev: pending.entryDev, ino: pending.entryIno };
  if (
    (await boundedFileHash(join(stage, "herdr"), entry)) !== pending.entryHash
  )
    throw new Error("Staged Herdr changed; manual recovery required");
  if ((await readdir(stage)).sort().join(",") !== "herdr")
    throw new Error("Unexpected staged Herdr files; manual recovery required");
  const installedPath = join(bin, "herdr");
  if (committed) {
    const state = stateBytes && decodeSetupState(stateBytes.toString("utf8"));
    if (
      state?.installations.herdr?.mode !== "managed" ||
      state.installations.herdr.directory !== pending.stage ||
      state.installations.herdr.entryHash !== pending.entryHash ||
      (await boundedFileHash(installedPath, entry)) !== pending.entryHash
    )
      throw new Error("Published Herdr changed; manual recovery required");
  } else if (!(await uvEntryAbsent(installedPath))) {
    const current = await inode(installedPath);
    if (current.dev !== entry.dev || current.ino !== entry.ino)
      throw new Error(
        "Conflicting Herdr entry preserved; manual recovery required",
      );
  }
  if (
    pending.bindingTmp &&
    !(await uvEntryAbsent(join(root, pending.bindingTmp)))
  ) {
    const temp = await inode(join(root, pending.bindingTmp));
    if (
      !pending.bindingIdentity ||
      temp.dev !== pending.bindingIdentity.dev ||
      temp.ino !== pending.bindingIdentity.ino
    )
      throw new Error(
        "Temporary binding ownership is incomplete; manual recovery required",
      );
  }
  if (stateIdentity && stateBytes)
    await assertFileUnchanged(statePath, stateIdentity, stateBytes);
  else if ((await optionalBytes(statePath)) !== null)
    throw new Error("Setup state changed; manual recovery required");
  if ((await optional(journalPath)) !== journalRaw)
    throw new Error("Recovery journal changed; manual review required");
  const currentJournal = await inode(journalPath);
  if (
    currentJournal.dev !== journalIdentity.dev ||
    currentJournal.ino !== journalIdentity.ino
  )
    throw new Error("Recovery journal changed; manual review required");
  if (pending.bindingTmp && pending.bindingIdentity)
    await removeOwned(
      join(root, pending.bindingTmp),
      pending.bindingIdentity.dev,
      pending.bindingIdentity.ino,
    );
  if (!committed) {
    await removeOwned(installedPath, entry.dev, entry.ino);
    await removeOwned(join(stage, "herdr"), entry.dev, entry.ino);
    await rmdir(stage);
  }
  await removeOwned(journalPath, journalIdentity.dev, journalIdentity.ino);
}

function windowsStageName(index: number) {
  return `f${index}.exe`;
}
function windowsBundlePath(bin: string, name: string) {
  return join(bin, ...name.split("/"));
}
async function recoverWindowsHerdr(
  root: string,
  bin: string,
  pending: z.infer<typeof windowsHerdrPendingSchema>,
  journalPath: string,
  journalRaw: string,
  journalIdentity: { dev: string; ino: string },
) {
  const statePath = join(root, "binding.json");
  const stateBytes = await optionalBytes(statePath);
  const stateIdentity = stateBytes === null ? null : await inode(statePath);
  const stateHash = stateBytes === null ? null : hash(stateBytes);
  if (
    stateHash !== pending.beforeHash &&
    (pending.afterHash === null || stateHash !== pending.afterHash)
  )
    throw new Error("Setup state changed; manual recovery required");
  const committed =
    pending.afterHash !== null && stateHash === pending.afterHash;
  if (
    !committed &&
    stateBytes !== null &&
    (!pending.beforeIdentity ||
      stateIdentity?.dev !== pending.beforeIdentity.dev ||
      stateIdentity.ino !== pending.beforeIdentity.ino)
  )
    throw new Error("Setup state identity changed; manual recovery required");
  const stage = join(root, pending.stage),
    stageId = await directoryInode(stage);
  if (stageId.dev !== pending.stageDev || stageId.ino !== pending.stageIno)
    throw new Error(
      "Herdr staging directory changed; manual recovery required",
    );
  const stageNames = pending.files
    .map((_, index) => windowsStageName(index))
    .sort();
  if (
    JSON.stringify((await readdir(stage)).sort()) !== JSON.stringify(stageNames)
  )
    throw new Error("Unexpected staged Herdr files; manual recovery required");
  for (const [index, identity] of pending.files.entries()) {
    if (
      (await boundedFileHash(
        join(stage, windowsStageName(index)),
        identity,
      )) !== identity.sha256
    )
      throw new Error("Staged Herdr changed; manual recovery required");
  }
  for (const directory of pending.directories) {
    const path = windowsBundlePath(bin, directory.name);
    if (directory.phase !== "created") {
      if (!(await uvEntryAbsent(path)))
        throw new Error(
          "Unowned Herdr directory preserved; manual recovery required",
        );
      if (committed)
        throw new Error(
          "Published Herdr directory missing; manual recovery required",
        );
      continue;
    }
    if (!directory.identity)
      throw new Error("Missing Herdr directory identity");
    await safeDir(path);
    const current = await directoryInode(path);
    if (
      current.dev !== directory.identity.dev ||
      current.ino !== directory.identity.ino
    )
      throw new Error("Herdr directory changed; manual recovery required");
    const allowed = new Set(
      [...herdrWindowsNames, ...windowsHerdrDirs]
        .filter((name) => name.startsWith(`${directory.name}/`))
        .map((name) => name.slice(directory.name.length + 1).split("/")[0]),
    );
    for (const entry of await readdir(path))
      if (!allowed.has(entry))
        throw new Error(
          "Unexpected Herdr directory content; manual recovery required",
        );
  }
  for (const [index, name] of herdrWindowsNames.entries()) {
    const target = windowsBundlePath(bin, name),
      expected = pending.files[index];
    if (!expected) throw new Error("Missing staged Herdr identity");
    if (await uvEntryAbsent(target)) {
      if (committed)
        throw new Error(
          "Published Herdr file missing; manual recovery required",
        );
      continue;
    }
    if ((await boundedFileHash(target, expected)) !== expected.sha256)
      throw new Error("Published Herdr changed; manual recovery required");
  }
  if (committed) {
    const state = stateBytes && decodeSetupState(stateBytes.toString("utf8"));
    const receipt = state?.installations.herdr;
    const dirs = pending.directories.map(({ name, identity }) => ({
      name,
      ...identity,
    }));
    if (
      receipt?.mode !== "managed" ||
      receipt.target !== "win32-x64" ||
      receipt.directory !== pending.stage ||
      receipt.stageIdentity.dev !== pending.stageDev ||
      receipt.stageIdentity.ino !== pending.stageIno ||
      JSON.stringify(receipt.files) !== JSON.stringify(pending.files) ||
      JSON.stringify(receipt.directories) !== JSON.stringify(dirs)
    )
      throw new Error(
        "Published Herdr receipt changed; manual recovery required",
      );
  }
  if (
    pending.bindingTmp &&
    !(await uvEntryAbsent(join(root, pending.bindingTmp)))
  ) {
    if (!pending.bindingIdentity)
      throw new Error(
        "Temporary binding ownership is incomplete; manual recovery required",
      );
    const tmp = await inode(join(root, pending.bindingTmp));
    if (
      tmp.dev !== pending.bindingIdentity.dev ||
      tmp.ino !== pending.bindingIdentity.ino
    )
      throw new Error("Temporary binding changed; manual recovery required");
  }
  if (stateIdentity && stateBytes)
    await assertFileUnchanged(statePath, stateIdentity, stateBytes);
  else if ((await optionalBytes(statePath)) !== null)
    throw new Error("Setup state changed; manual recovery required");
  if ((await optional(journalPath)) !== journalRaw)
    throw new Error("Recovery journal changed; manual review required");
  const journalNow = await inode(journalPath);
  if (
    journalNow.dev !== journalIdentity.dev ||
    journalNow.ino !== journalIdentity.ino
  )
    throw new Error("Recovery journal changed; manual review required");
  if (pending.bindingTmp && pending.bindingIdentity)
    await removeOwned(
      join(root, pending.bindingTmp),
      pending.bindingIdentity.dev,
      pending.bindingIdentity.ino,
    );
  if (!committed) {
    for (const [index, name] of herdrWindowsNames.entries()) {
      const identity = pending.files[index];
      if (!identity) throw new Error("Missing staged Herdr identity");
      await removeOwned(
        windowsBundlePath(bin, name),
        identity.dev,
        identity.ino,
      );
    }
    for (const dir of [...pending.directories].reverse())
      if (dir.phase === "created" && dir.identity) {
        const path = windowsBundlePath(bin, dir.name),
          current = await directoryInode(path);
        if (
          current.dev !== dir.identity.dev ||
          current.ino !== dir.identity.ino
        )
          throw new Error("Herdr directory changed; manual recovery required");
        await rmdir(path);
      }
    for (const [index, identity] of pending.files.entries())
      await removeOwned(
        join(stage, windowsStageName(index)),
        identity.dev,
        identity.ino,
      );
    await rmdir(stage);
  }
  await removeOwned(journalPath, journalIdentity.dev, journalIdentity.ino);
}

type Operation = {
  tempIntent(name: string): Promise<void>;
  tempIdentity(identity: z.infer<typeof identitySchema>): Promise<void>;
  tempClear(): Promise<void>;
  stageIntent(name: string): Promise<void>;
  stage(name: string, identity: z.infer<typeof identitySchema>): Promise<void>;
  file(name: string, identity: StagedFile | null): Promise<void>;
  release(
    committed?: boolean,
    component?: "uv" | "Herdr" | "coding",
  ): Promise<void>;
};
const operationScope = new AsyncLocalStorage<{
  root: string;
  operation: Operation;
  active: boolean;
}>();

export async function withSetupOperation<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const enclosing = operationScope.getStore();
  if (enclosing?.active && enclosing.root === root) return action();
  const operation = await acquire(root);
  const scope = { root, operation, active: true };
  return operationScope.run(scope, async () => {
    let committed = false;
    try {
      const result = await action();
      committed = true;
      return result;
    } finally {
      scope.active = false;
      // A failed group can retain an incomplete tree or journal. Keep its PID
      // and ownership evidence for the next CLI process to classify safely.
      if (committed) await operation.release(true, "coding");
    }
  });
}
export { acquire as acquireSetupOperation };

async function acquire(root: string): Promise<Operation> {
  const enclosing = operationScope.getStore();
  if (enclosing?.active && enclosing.root === root)
    return { ...enclosing.operation, async release() {} };
  return withOperationGuard(root, () => acquireGuarded(root));
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
    const pendingRaw = await optional(join(root, "pending.json"));
    if (pendingRaw !== null) decodeState(allPendingSchema, pendingRaw);
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
    if (old.stage && pendingRaw === null) {
      const binding = await readSetupState(dirname(root));
      if (
        !(
          (binding?.installations.uv?.mode === "managed" &&
            binding.installations.uv.directory === old.stage.name) ||
          (binding?.installations.herdr?.mode === "managed" &&
            binding.installations.herdr.directory === old.stage.name) ||
          (binding?.installations.pi?.mode === "managed" &&
            binding.installations.pi.directory === old.stage.name) ||
          (binding?.installations.pnpm?.mode === "managed" &&
            binding.installations.pnpm.directory === old.stage.name)
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
            if (/^(?:pi|pnpm)-/.test(old.stage.name)) {
              const manifest = (old.stage.files as Record<string, StagedFile>)[
                treeManifestName
              ];
              if (manifest)
                await removeManagedTree(stage, {
                  root: old.stage.identity,
                  manifest,
                });
              else if ((await readdir(stage)).length === 0) {
                const actual = await directoryInode(stage);
                if (
                  actual.dev !== old.stage.identity.dev ||
                  actual.ino !== old.stage.identity.ino
                )
                  throw new Error(
                    "Staging ownership changed; manual recovery required",
                  );
                await rmdir(stage);
              } else
                throw new Error(
                  "Incomplete npm tree ownership; manual recovery required",
                );
            } else
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
      if (
        !owner.stage ||
        !(
          /^(?:pi|pnpm)-/.test(owner.stage.name)
            ? [treeManifestName]
            : owner.stage.name.includes("-win32-x64-")
              ? [
                  "f0.exe",
                  "f1.exe",
                  "f2.exe",
                  "f3.exe",
                  "f4.exe",
                  "f5.exe",
                  "f6.exe",
                ]
              : owner.stage.name.startsWith("herdr-")
                ? ["herdr"]
                : ["archive.tar.gz", "uv", "uvx"]
        ).includes(name)
      )
        throw new Error("Invalid staging record");
      const files: Record<string, StagedFile> = { ...owner.stage.files };
      if (identity) files[name] = identity;
      else delete files[name];
      await update(
        ownerSchema.parse({ ...owner, stage: { ...owner.stage, files } }),
      );
    },
    async release(committed = false, component = "uv") {
      try {
        if ((await optional(path)) !== raw)
          throw new Error("Operation lock changed; manual recovery required");
        await removeOwned(path, created.dev, created.ino);
      } catch (error) {
        if (committed)
          throw new UvCommittedError(
            `${component} binding was published; operation lock cleanup needs manual review`,
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
  deferBinding?: boolean;
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
      if (pending && journalCreated) await recover(root, bin);
      else if (stage && stageIdentity)
        await cleanupStage(stage, stageIdentity, created);
      else if (stage && !(await uvEntryAbsent(stage)))
        throw new Error(
          "Staging ownership is incomplete; manual recovery required",
        );
    } catch (error) {
      if (
        (await optional(join(root, "pending.json"))) === null &&
        (!stage || (await uvEntryAbsent(stage)))
      )
        await operation.release();
      throw error;
    }
    await operation.release();
  };
  try {
    await recover(root, bin);
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
    const beforeBytes = await optionalBytes(join(root, "binding.json"));
    const beforeIdentity =
      beforeBytes === null ? null : await inode(join(root, "binding.json"));
    const oldState =
      beforeBytes === null
        ? null
        : decodeSetupState(beforeBytes.toString("utf8"));
    if (oldState?.installations.uv)
      throw new Error("Existing uv receipt requires review");
    const binding = setupStateSchema.parse({
      schemaVersion: 2,
      defaultBinding: input.deferBinding
        ? (oldState?.defaultBinding ?? null)
        : {
            repo: input.repo,
            profile: input.profile,
            lock: input.lock,
          },
      installations: {
        ...oldState?.installations,
        uv: {
          version: input.version,
          target: input.target,
          mode: "managed",
          directory: stageName,
          uvHash: hash(uv),
          uvxHash: hash(uvx),
          asset: input.asset,
        },
      },
    });
    const bindingBytes = Buffer.from(JSON.stringify(binding));
    pending = {
      schemaVersion: 2,
      kind: "uv-install",
      beforeHash: beforeBytes === null ? null : hash(beforeBytes),
      beforeIdentity,
      afterHash: hash(bindingBytes),
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
    const bindingPath = join(root, "binding.json");
    if (!pending) throw new Error("Missing recovery journal");
    const tmpName = `binding-${stageName}.tmp`;
    const tmp = join(root, tmpName);
    const updateJournal = async (nextPending: Pending) => {
      if ((await optional(journalPath)) !== JSON.stringify(pending))
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
    };
    await updateJournal({ ...pending, bindingTmp: tmpName });
    const file = await open(tmp, "wx", 0o600);
    const tmpInfo = await file.stat({ bigint: true });
    let tmpCleanupError: unknown;
    try {
      await updateJournal({
        ...pending,
        bindingTmp: tmpName,
        bindingDev: String(tmpInfo.dev),
        bindingIno: String(tmpInfo.ino),
      });
      await file.writeFile(bindingBytes);
      await file.sync();
      await file.close();
      if (beforeIdentity && beforeBytes) {
        await assertFileUnchanged(bindingPath, beforeIdentity, beforeBytes);
        await rename(tmp, bindingPath);
      } else await link(tmp, bindingPath);
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
  binding: UvReceipt,
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
    binding.mode !== "managed" ||
    binding.version !== version ||
    binding.target !== target ||
    !binding.asset ||
    binding.asset.name !== asset.name ||
    binding.asset.url !== asset.url ||
    binding.asset.sha256 !== asset.sha256 ||
    binding.asset.releaseId !== asset.releaseId ||
    binding.asset.assetId !== asset.assetId ||
    !binding.directory ||
    !/^uv-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/.test(
      binding.directory,
    ) ||
    !binding.uvHash ||
    !binding.uvxHash
  )
    return false;
  const root = join(resolve(home), ".agent-stack"),
    bin = join(root, "bin"),
    stage = join(root, binding.directory);
  try {
    await safeDir(root);
    await safeDir(bin);
    await safeDir(stage);
    for (const [name, expected] of [
      ["uv", binding.uvHash],
      ["uvx", binding.uvxHash],
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

export async function publishSetupState(input: {
  root: string;
  path: string;
  existingBytes: Buffer | null;
  binding: SetupState;
  operation: Operation;
  currentRoot: string;
  signal: AbortSignal;
  recheck: () => Promise<void>;
  committed: () => void;
  label: string;
}) {
  const { root, path, existingBytes, binding, operation, currentRoot } = input;
  const previousIdentity =
    existingBytes === null ? undefined : await inode(path);
  const tmpName = `binding-${randomBytes(16).toString("hex")}.tmp`,
    tmp = join(root, tmpName);
  await operation.tempIntent(tmpName);
  const file = await open(tmp, "wx", 0o600),
    info = await file.stat({ bigint: true });
  let published = false;
  const cleanup = async () => {
    try {
      await removeOwned(tmp, String(info.dev), String(info.ino));
      await operation.tempClear();
    } catch (error) {
      if (published)
        throw new UvCommittedError(
          `${input.label} binding was published; temporary state needs manual review`,
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
    const now = await directoryInode(root);
    if (`${now.dev}:${now.ino}` !== currentRoot)
      throw new Error("Setup state directory changed after planning");
    if (input.signal.aborted) throw new Error("Cancelled");
    if (previousIdentity && existingBytes) {
      await assertFileUnchanged(path, previousIdentity, existingBytes);
      await rename(tmp, path);
    } else await link(tmp, path);
    published = true;
    input.committed();
  } finally {
    await file.close().catch(() => {});
    await cleanup();
  }
}

export async function bindExternalUv(input: {
  home: string;
  deferBinding?: boolean;
  codingVerification?: CodingVerification;
  repo: string;
  profile: string;
  lock: string;
  version: string;
  target: string;
  managed?: UvReceipt;
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
      const path = join(root, "binding.json"),
        existingBytes = await optionalBytes(path);
      const old =
        existingBytes === null
          ? null
          : decodeSetupState(existingBytes.toString("utf8"));
      const receipt = input.managed ?? {
        version: input.version,
        target: input.target,
        mode: "external" as const,
        directory: null,
        uvHash: null,
        uvxHash: null,
      };
      if (
        old?.installations.uv &&
        (old.installations.uv.version !== input.version ||
          old.installations.uv.target !== input.target ||
          old.installations.uv.mode !== receipt.mode ||
          (input.managed &&
            JSON.stringify(old.installations.uv) !== JSON.stringify(receipt)))
      )
        throw new Error("Existing binding has different uv ownership");
      const binding = setupStateSchema.parse({
        schemaVersion: 2,
        defaultBinding: input.deferBinding
          ? (old?.defaultBinding ?? null)
          : {
              repo: input.repo,
              profile: input.profile,
              lock: input.lock,
              ...(input.codingVerification
                ? { codingVerification: input.codingVerification }
                : {}),
            },
        installations: { ...old?.installations, uv: receipt },
      });
      if (
        existingBytes !== null &&
        JSON.stringify(old) === JSON.stringify(binding)
      ) {
        completed = true;
        return binding;
      }
      await publishSetupState({
        root,
        path,
        existingBytes,
        binding,
        operation,
        currentRoot,
        signal: input.signal,
        recheck: input.recheck,
        committed: () => {
          completed = true;
        },
        label: "External uv",
      });
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
  decodeState(allPendingSchema, raw);
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
    await recover(root, bin);
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

export async function bindExternalHerdr(input: {
  home: string;
  deferBinding?: boolean;
  repo: string;
  profile: string;
  lock: string;
  version: string;
  target: string;
  path: string;
  fingerprint: string;
  managed?: Extract<
    NonNullable<SetupState["installations"]["herdr"]>,
    { mode: "managed" }
  >;
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
      const pendingRaw = await optional(join(root, "pending.json"));
      if (pendingRaw !== null) {
        decodeState(allPendingSchema, pendingRaw);
        throw new Error(
          "Pending uv operation requires recovery before Herdr setup",
        );
      }
      await input.recheck();
      if (input.signal.aborted) throw new Error("Cancelled");
      const path = join(root, "binding.json"),
        existingBytes = await optionalBytes(path);
      const old =
        existingBytes === null
          ? null
          : decodeSetupState(existingBytes.toString("utf8"));
      const binding = setupStateSchema.parse({
        schemaVersion: 2,
        defaultBinding: input.deferBinding
          ? (old?.defaultBinding ?? null)
          : {
              repo: input.repo,
              profile: input.profile,
              lock: input.lock,
            },
        installations: {
          ...old?.installations,
          herdr: input.managed ?? {
            mode: "external",
            source: "unknown",
            version: input.version,
            target: input.target,
            path: input.path,
            fingerprint: input.fingerprint,
          },
        },
      });
      if (
        old?.installations.herdr &&
        JSON.stringify(old.installations.herdr) !==
          JSON.stringify(binding.installations.herdr)
      )
        throw new Error(
          "Existing Herdr entry changed; refusing to replace receipt",
        );
      if (
        existingBytes !== null &&
        JSON.stringify(old) === JSON.stringify(binding)
      ) {
        completed = true;
        return binding;
      }
      await publishSetupState({
        root,
        path,
        existingBytes,
        binding,
        operation,
        currentRoot,
        signal: input.signal,
        recheck: input.recheck,
        committed: () => {
          completed = true;
        },
        label: "Herdr",
      });
      return binding;
    } finally {
      await operation.release(completed, "Herdr");
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

function verifyHerdrBinaryIdentity(binary: Buffer, target: string) {
  if (binary.length < 32) throw new Error("Herdr binary header is incomplete");
  const magic = binary.subarray(0, 4).toString("hex");
  if (magic !== "cffaedfe" && magic !== "feedfacf")
    throw new Error("Herdr asset is not a standalone 64-bit Mach-O binary");
  const cpu =
    magic === "cffaedfe" ? binary.readUInt32LE(4) : binary.readUInt32BE(4);
  const expected =
    target === "darwin-arm64"
      ? 0x0100000c
      : target === "darwin-x64"
        ? 0x01000007
        : -1;
  if (cpu !== expected)
    throw new Error(
      "Herdr binary architecture does not match the locked target",
    );
}

export async function applyHerdr(input: {
  home: string;
  deferBinding?: boolean;
  path: string;
  repo: string;
  profile: string;
  lock: string;
  version: string;
  target: string;
  asset: {
    assetKey: string;
    name: string;
    url: string;
    sha256: string;
    digestSource: string;
  };
  signal: AbortSignal;
  recheck: () => Promise<void>;
  checkReachable: () => Promise<void>;
}) {
  const { root, bin } = await inspectUvPath(input.home, input.path);
  const operation = await acquire(root);
  let stage: string | undefined,
    stageIdentity: { dev: string; ino: string } | undefined;
  const created = new Map<string, StagedFile>();
  let journalCreated = false,
    published = false;
  const finishHerdrOperation = async () => {
    if (!published) {
      try {
        if (journalCreated) await recover(root, bin);
        else if (stage && stageIdentity)
          await cleanupStage(stage, stageIdentity, created);
        else if (stage && !(await uvEntryAbsent(stage)))
          throw new Error(
            "Staging ownership is incomplete; manual recovery required",
          );
      } catch (error) {
        if (
          (await optional(join(root, "pending.json"))) === null &&
          (!stage || (await uvEntryAbsent(stage)))
        )
          await operation.release();
        throw error;
      }
    }
    await operation.release(published, "Herdr");
  };
  try {
    await recover(root, bin);
    await input.recheck();
    if (!(await uvEntryAbsent(join(bin, "herdr"))))
      throw new Error("Herdr entry already exists; refusing to overwrite");
    const stageName = `herdr-${input.version}-${input.target}-${randomBytes(16).toString("hex")}`;
    stage = join(root, stageName);
    await operation.stageIntent(stageName);
    await mkdir(stage, { mode: 0o700 });
    stageIdentity = await directoryInode(stage);
    await operation.stage(stageName, stageIdentity);
    const binary = await downloadRelease(
      input.asset.url,
      input.asset.sha256,
      input.signal,
      "herdr",
    );
    verifyHerdrBinaryIdentity(binary, input.target);
    await createOwned(
      join(stage, "herdr"),
      binary,
      0o755,
      created,
      "herdr",
      operation.file,
    );
    await verifyUvVersion(
      join(stage, "herdr"),
      "herdr",
      input.version,
      stage,
      input.signal,
    );
    if ((await readdir(stage)).sort().join(",") !== "herdr")
      throw new Error("Unexpected staged files; manual recovery required");
    const entry = await inode(join(stage, "herdr"));
    if (
      (await boundedFileHash(join(stage, "herdr"), entry)) !==
      input.asset.sha256
    )
      throw new Error("Staged Herdr changed during verification");
    const bindingPath = join(root, "binding.json"),
      beforeBytes = await optionalBytes(bindingPath);
    const beforeIdentity =
      beforeBytes === null ? null : await inode(bindingPath);
    const old =
      beforeBytes === null
        ? null
        : decodeSetupState(beforeBytes.toString("utf8"));
    if (old?.installations.herdr)
      throw new Error("Existing Herdr receipt requires review");
    const binding = setupStateSchema.parse({
      schemaVersion: 2,
      defaultBinding: input.deferBinding
        ? (old?.defaultBinding ?? null)
        : {
            repo: input.repo,
            profile: input.profile,
            lock: input.lock,
          },
      installations: {
        ...old?.installations,
        herdr: {
          mode: "managed",
          version: input.version,
          target: input.target,
          directory: stageName,
          entryHash: input.asset.sha256,
          asset: input.asset,
        },
      },
    });
    const bindingBytes = Buffer.from(JSON.stringify(binding));
    let pending = herdrPendingSchema.parse({
      schemaVersion: 2,
      kind: "herdr-install",
      stage: stageName,
      stageDev: stageIdentity.dev,
      stageIno: stageIdentity.ino,
      entryDev: entry.dev,
      entryIno: entry.ino,
      entryHash: input.asset.sha256,
      beforeHash: beforeBytes === null ? null : hash(beforeBytes),
      beforeIdentity,
      afterHash: hash(bindingBytes),
      bindingTmp: null,
      bindingIdentity: null,
    });
    const journalPath = join(root, "pending.json"),
      journal = await open(journalPath, "wx", 0o600);
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
    const updateJournal = async (next: typeof pending) => {
      if ((await optional(journalPath)) !== JSON.stringify(pending))
        throw new Error("Recovery journal changed");
      const handle = await open(
        journalPath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat({ bigint: true });
        if (info.dev !== journalInfo.dev || info.ino !== journalInfo.ino)
          throw new Error("Recovery journal changed");
        const value = Buffer.from(JSON.stringify(next));
        await handle.truncate(0);
        let offset = 0;
        while (offset < value.length) {
          const { bytesWritten } = await handle.write(
            value,
            offset,
            value.length - offset,
            offset,
          );
          if (!bytesWritten) throw new Error("Cannot write recovery journal");
          offset += bytesWritten;
        }
        await handle.sync();
        pending = next;
      } finally {
        await handle.close();
      }
    };
    await input.recheck();
    if (input.signal.aborted) throw new Error("Cancelled");
    await link(join(stage, "herdr"), join(bin, "herdr"));
    await verifyUvVersion(
      join(bin, "herdr"),
      "herdr",
      input.version,
      stage,
      input.signal,
    );
    await input.recheck();
    await input.checkReachable();
    if (
      (await boundedFileHash(join(bin, "herdr"), entry)) !== input.asset.sha256
    )
      throw new Error("Published Herdr changed");
    const tmpName = `binding-${randomBytes(16).toString("hex")}.tmp`,
      tmp = join(root, tmpName);
    await updateJournal({ ...pending, bindingTmp: tmpName });
    const file = await open(tmp, "wx", 0o600),
      tmpInfo = await file.stat({ bigint: true });
    const cleanupTemporary = async () => {
      try {
        await removeOwned(tmp, String(tmpInfo.dev), String(tmpInfo.ino));
      } catch (error) {
        if (published)
          throw new UvCommittedError(
            "Herdr was installed; temporary state needs manual review",
          );
        throw error;
      }
    };
    try {
      await updateJournal({
        ...pending,
        bindingIdentity: { dev: String(tmpInfo.dev), ino: String(tmpInfo.ino) },
      });
      await file.writeFile(bindingBytes);
      await file.sync();
      await file.close();
      await input.recheck();
      await input.checkReachable();
      await safeDir(stage);
      if (
        (await boundedFileHash(join(stage, "herdr"), entry)) !==
          input.asset.sha256 ||
        (await boundedFileHash(join(bin, "herdr"), entry)) !==
          input.asset.sha256
      )
        throw new Error("Published Herdr changed before state commit");
      if (input.signal.aborted) throw new Error("Cancelled");
      if (beforeIdentity && beforeBytes) {
        await assertFileUnchanged(bindingPath, beforeIdentity, beforeBytes);
        await rename(tmp, bindingPath);
      } else await link(tmp, bindingPath);
      published = true;
    } finally {
      await file.close().catch(() => {});
      await cleanupTemporary();
    }
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
        "Herdr was installed; recovery journal needs manual review",
      );
    }
    return binding;
  } finally {
    await finishHerdrOperation();
  }
}

export async function applyWindowsHerdr(
  input: Parameters<typeof applyHerdr>[0],
) {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    input.target !== "win32-x64"
  )
    throw new Error("Windows Herdr installation requires native Windows x64");
  const { root, bin } = await inspectUvPath(input.home, input.path);
  const operation = await acquire(root);
  let stage: string | undefined,
    stageIdentity: { dev: string; ino: string } | undefined;
  const created = new Map<string, StagedFile>();
  let journalCreated = false,
    published = false;
  const finish = async () => {
    if (!published) {
      try {
        if (journalCreated) await recover(root, bin);
        else if (stage && stageIdentity)
          await cleanupStage(stage, stageIdentity, created);
        else if (stage && !(await uvEntryAbsent(stage)))
          throw new Error(
            "Staging ownership is incomplete; manual recovery required",
          );
      } catch (error) {
        if (
          (await optional(join(root, "pending.json"))) === null &&
          (!stage || (await uvEntryAbsent(stage)))
        )
          await operation.release();
        throw error;
      }
    }
    await operation.release(published, "Herdr");
  };
  try {
    await recover(root, bin);
    await input.recheck();
    for (const name of ["herdr.exe", "conpty", "THIRD-PARTY-NOTICES"])
      if (!(await uvEntryAbsent(windowsBundlePath(bin, name))))
        throw new Error(
          "Windows Herdr entry or runtime already exists; refusing to overwrite",
        );
    const stageName = `herdr-${input.version}-${input.target}-${randomBytes(16).toString("hex")}`;
    stage = join(root, stageName);
    await operation.stageIntent(stageName);
    await mkdir(stage, { mode: 0o700 });
    stageIdentity = await directoryInode(stage);
    await operation.stage(stageName, stageIdentity);
    const archive = await downloadRelease(
      input.asset.url,
      input.asset.sha256,
      input.signal,
      "herdr",
    );
    await input.recheck();
    if (input.signal.aborted) throw new Error("Cancelled");
    const bundle = readHerdrWindowsArchive(archive);
    for (const [index, name] of herdrWindowsNames.entries()) {
      if (input.signal.aborted) throw new Error("Cancelled");
      const data = bundle.get(name);
      if (!data) throw new Error("Missing validated Herdr bundle entry");
      const stageFile = windowsStageName(index);
      await createOwned(
        join(stage, stageFile),
        data,
        0o700,
        created,
        stageFile,
        operation.file,
      );
    }
    const files = herdrWindowsNames.map((_, index) => {
      const item = created.get(windowsStageName(index));
      if (!item) throw new Error("Missing staged Herdr identity");
      return item;
    });
    await safeDir(stage);
    for (const [index, identity] of files.entries())
      if (
        (await boundedFileHash(
          join(stage, windowsStageName(index)),
          identity,
        )) !== identity.sha256
      )
        throw new Error("Staged Herdr changed before version verification");
    await verifyUvVersion(
      join(stage, windowsStageName(herdrWindowsNames.indexOf("herdr.exe"))),
      "herdr",
      input.version,
      stage,
      input.signal,
    );
    for (const [index, identity] of files.entries())
      if (
        (await boundedFileHash(
          join(stage, windowsStageName(index)),
          identity,
        )) !== identity.sha256
      )
        throw new Error("Staged Herdr changed during verification");
    const bindingPath = join(root, "binding.json"),
      beforeBytes = await optionalBytes(bindingPath);
    const beforeIdentity =
      beforeBytes === null ? null : await inode(bindingPath);
    const old =
      beforeBytes === null
        ? null
        : decodeSetupState(beforeBytes.toString("utf8"));
    if (old?.installations.herdr)
      throw new Error("Existing Herdr receipt requires review");
    let pending = windowsHerdrPendingSchema.parse({
      schemaVersion: 2,
      kind: "herdr-windows-install",
      stage: stageName,
      stageDev: stageIdentity.dev,
      stageIno: stageIdentity.ino,
      files,
      directories: windowsHerdrDirs.map((name) => ({
        name,
        phase: "unattempted",
        identity: null,
      })),
      beforeHash: beforeBytes === null ? null : hash(beforeBytes),
      beforeIdentity,
      afterHash: null,
      bindingTmp: null,
      bindingIdentity: null,
    });
    const journalPath = join(root, "pending.json"),
      journal = await open(journalPath, "wx", 0o600);
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
    const updateJournal = async (next: typeof pending) => {
      if ((await optional(journalPath)) !== JSON.stringify(pending))
        throw new Error("Recovery journal changed");
      const handle = await open(
        journalPath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat({ bigint: true });
        if (info.dev !== journalInfo.dev || info.ino !== journalInfo.ino)
          throw new Error("Recovery journal changed");
        const value = Buffer.from(JSON.stringify(next));
        await handle.truncate(0);
        let offset = 0;
        while (offset < value.length) {
          const { bytesWritten } = await handle.write(
            value,
            offset,
            value.length - offset,
            offset,
          );
          if (!bytesWritten) throw new Error("Cannot write recovery journal");
          offset += bytesWritten;
        }
        await handle.sync();
        pending = next;
      } finally {
        await handle.close();
      }
    };
    for (const [index, dir] of pending.directories.entries()) {
      await input.recheck();
      if (input.signal.aborted) throw new Error("Cancelled");
      let directories = pending.directories.map((item, i) =>
        i === index ? { ...item, phase: "intent" as const } : item,
      );
      await updateJournal({ ...pending, directories });
      const path = windowsBundlePath(bin, dir.name);
      await mkdir(path, { mode: 0o700 });
      const identity = await directoryInode(path);
      directories = pending.directories.map((item, i) =>
        i === index ? { ...item, phase: "created" as const, identity } : item,
      );
      await updateJournal({ ...pending, directories });
    }
    const directories = pending.directories.map(({ name, identity }) => {
      if (!identity) throw new Error("Incomplete Herdr directory ownership");
      return { name, ...identity };
    });
    const entryIndex = herdrWindowsNames.indexOf("herdr.exe"),
      entry = files[entryIndex];
    if (!entry) throw new Error("Missing Herdr entry");
    const binding = setupStateSchema.parse({
      schemaVersion: 2,
      defaultBinding: input.deferBinding
        ? (old?.defaultBinding ?? null)
        : {
            repo: input.repo,
            profile: input.profile,
            lock: input.lock,
          },
      installations: {
        ...old?.installations,
        herdr: {
          mode: "managed",
          version: input.version,
          target: "win32-x64",
          directory: stageName,
          entryHash: entry.sha256,
          stageIdentity,
          files,
          directories,
          asset: input.asset,
        },
      },
    });
    const bindingBytes = Buffer.from(JSON.stringify(binding));
    const receipt = binding.installations.herdr;
    if (receipt?.mode !== "managed" || receipt.target !== "win32-x64")
      throw new Error("Invalid Windows Herdr receipt");
    await updateJournal({ ...pending, afterHash: hash(bindingBytes) });
    await input.recheck();
    for (const [index, name] of herdrWindowsNames.entries()) {
      if (input.signal.aborted) throw new Error("Cancelled");
      await link(
        join(stage, windowsStageName(index)),
        windowsBundlePath(bin, name),
      );
    }
    await input.checkReachable();
    await safeDir(bin);
    if (
      (await boundedFileHash(
        join(stage, windowsStageName(entryIndex)),
        entry,
      )) !== entry.sha256 ||
      (await boundedFileHash(windowsBundlePath(bin, "herdr.exe"), entry)) !==
        entry.sha256
    )
      throw new Error("Published Herdr changed before version verification");
    await verifyUvVersion(
      windowsBundlePath(bin, "herdr.exe"),
      "herdr",
      input.version,
      stage,
      input.signal,
    );
    const tmpName = `binding-${randomBytes(16).toString("hex")}.tmp`,
      tmp = join(root, tmpName);
    await updateJournal({ ...pending, bindingTmp: tmpName });
    const file = await open(tmp, "wx", 0o600),
      tmpInfo = await file.stat({ bigint: true });
    const cleanupTemporary = async () => {
      try {
        await removeOwned(tmp, String(tmpInfo.dev), String(tmpInfo.ino));
      } catch (error) {
        if (published)
          throw new UvCommittedError(
            "Herdr was installed; temporary state needs manual review",
          );
        throw error;
      }
    };
    try {
      await updateJournal({
        ...pending,
        bindingIdentity: { dev: String(tmpInfo.dev), ino: String(tmpInfo.ino) },
      });
      await file.writeFile(bindingBytes);
      await file.sync();
      await file.close();
      await input.recheck();
      await input.checkReachable();
      for (const [index, name] of herdrWindowsNames.entries()) {
        const identity = files[index];
        if (
          !identity ||
          (await boundedFileHash(
            join(stage, windowsStageName(index)),
            identity,
          )) !== identity.sha256 ||
          (await boundedFileHash(windowsBundlePath(bin, name), identity)) !==
            identity.sha256
        )
          throw new Error("Published Herdr changed before state commit");
      }
      for (const directory of directories) {
        await safeDir(windowsBundlePath(bin, directory.name));
        const actual = await directoryInode(
          windowsBundlePath(bin, directory.name),
        );
        if (actual.dev !== directory.dev || actual.ino !== directory.ino)
          throw new Error(
            "Published Herdr directory changed before state commit",
          );
      }
      if (!(await windowsHerdrMatches(root, bin, receipt)))
        throw new Error("Published Herdr bundle changed before state commit");
      if (input.signal.aborted) throw new Error("Cancelled");
      if (beforeIdentity && beforeBytes) {
        await assertFileUnchanged(bindingPath, beforeIdentity, beforeBytes);
        await rename(tmp, bindingPath);
      } else await link(tmp, bindingPath);
      published = true;
    } finally {
      await file.close().catch(() => {});
      await cleanupTemporary();
    }
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
        "Herdr was installed; recovery journal needs manual review",
      );
    }
    return binding;
  } finally {
    await finish();
  }
}

async function windowsHerdrMatches(
  root: string,
  bin: string,
  receipt: Extract<
    NonNullable<SetupState["installations"]["herdr"]>,
    { mode: "managed"; target: "win32-x64" }
  >,
) {
  try {
    const stage = join(root, receipt.directory);
    await safeDir(stage);
    const stageId = await directoryInode(stage);
    if (
      stageId.dev !== receipt.stageIdentity.dev ||
      stageId.ino !== receipt.stageIdentity.ino
    )
      return false;
    const stageNames = receipt.files
      .map((_, index) => windowsStageName(index))
      .sort();
    if (
      JSON.stringify((await readdir(stage)).sort()) !==
      JSON.stringify(stageNames)
    )
      return false;
    for (const dir of receipt.directories) {
      const path = windowsBundlePath(bin, dir.name);
      await safeDir(path);
      const actual = await directoryInode(path);
      if (actual.dev !== dir.dev || actual.ino !== dir.ino) return false;
      const expected = [
        ...new Set(
          [...herdrWindowsNames, ...windowsHerdrDirs]
            .filter((name) => name.startsWith(`${dir.name}/`))
            .map((name) => name.slice(dir.name.length + 1).split("/")[0]),
        ),
      ].sort();
      if (
        JSON.stringify((await readdir(path)).sort()) !==
        JSON.stringify(expected)
      )
        return false;
    }
    for (const [index, name] of herdrWindowsNames.entries()) {
      const identity = receipt.files[index];
      if (
        !identity ||
        (await boundedFileHash(
          join(stage, windowsStageName(index)),
          identity,
        )) !== identity.sha256 ||
        (await boundedFileHash(windowsBundlePath(bin, name), identity)) !==
          identity.sha256
      )
        return false;
    }
    return (
      receipt.files[herdrWindowsNames.indexOf("herdr.exe")]?.sha256 ===
      receipt.entryHash
    );
  } catch {
    return false;
  }
}

export async function matchesManagedHerdr(
  home: string,
  receipt: Extract<
    NonNullable<SetupState["installations"]["herdr"]>,
    { mode: "managed" }
  >,
  version: string,
  target: string,
  asset: {
    assetKey: string;
    name: string;
    url: string;
    sha256: string;
    digestSource: string;
  },
) {
  if (
    receipt.version !== version ||
    receipt.target !== target ||
    JSON.stringify(receipt.asset) !== JSON.stringify(asset)
  )
    return false;
  const root = join(resolve(home), ".agent-stack"),
    bin = join(root, "bin"),
    stage = join(root, receipt.directory);
  try {
    await safeDir(root);
    await safeDir(bin);
    if (receipt.target === "win32-x64")
      return await windowsHerdrMatches(root, bin, receipt);
    await safeDir(stage);
    const source = await inode(join(stage, "herdr")),
      entry = await inode(join(bin, "herdr"));
    return (
      source.dev === entry.dev &&
      source.ino === entry.ino &&
      (await boundedFileHash(join(stage, "herdr"), source)) ===
        receipt.entryHash &&
      receipt.entryHash === asset.sha256
    );
  } catch {
    return false;
  }
}
