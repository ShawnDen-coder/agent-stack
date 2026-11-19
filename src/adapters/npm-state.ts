import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Observation } from "../core/doctor.js";
import type { ManagedTreeReceipt } from "../core/managed-tree.js";
import {
  type ManagedNpmReceipt,
  managedNpmReceiptSchema,
  type NpmPending,
  type NpmReceipt,
  npmAssetReceiptSchema,
  npmPendingSchema,
  npmStageName,
} from "../core/npm-state.js";
import { assertNodeTarget } from "./external-node.js";
import {
  boundedFileHash,
  directoryInode,
  hash,
  inode,
  optional,
  optionalBytes,
  removeOwned,
  safeDir,
} from "./managed-operation.js";
import {
  managedTreeDigest,
  recordManagedTree,
  removeManagedTree,
  treeManifestName,
  verifyManagedTree,
} from "./managed-tree.js";
import { prepareLockedPnpm } from "./npm-archive.js";
import { inspectPiInstallation, stagePi } from "./pi-staging.js";
import {
  decodeSetupState,
  readSetupState,
  type SetupState,
  setupStateSchema,
} from "./setup-state.js";
import { findExecutable } from "./toolchain.js";
import {
  acquireSetupOperation,
  inspectUvPath,
  publishSetupState,
  recoverPendingUv,
  uvEntryAbsent,
  uvEntryFingerprint,
  withSetupOperation,
} from "./uv-state.js";

type Assets = ManagedNpmReceipt["assets"];
type Entry = NonNullable<NpmPending["entry"]>;
const identical = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const manual = () =>
  new Error("npm installation changed; manual recovery required");
function sourceEntry(root: string, component: "pi" | "pnpm") {
  return component === "pi"
    ? join(
        root,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "bundle",
        "cli.js",
      )
    : join(root, "pnpm");
}
async function entryIdentity(path: string): Promise<Entry> {
  const before = await lstat(path, { bigint: true });
  if ((!before.isFile() && !before.isSymbolicLink()) || !before.ino)
    throw manual();
  const target = before.isSymbolicLink() ? await readlink(path) : null;
  const after = await lstat(path, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeNs !== after.mtimeNs
  )
    throw manual();
  return {
    dev: String(before.dev),
    ino: String(before.ino),
    type: before.isSymbolicLink() ? "link" : "file",
    target,
  };
}
async function verifyPublic(
  root: string,
  bin: string,
  receipt: ManagedNpmReceipt,
) {
  const stage = join(root, receipt.directory);
  await verifyManagedTree(stage, receipt.tree);
  const entry = await entryIdentity(join(bin, receipt.component));
  if (!identical(entry, receipt.entry)) throw manual();
  const source = sourceEntry(stage, receipt.component);
  if (receipt.component === "pi") {
    if (entry.type !== "link" || entry.target !== source) throw manual();
  } else {
    const expected = await inode(source);
    if (
      entry.type !== "file" ||
      entry.target !== null ||
      entry.dev !== expected.dev ||
      entry.ino !== expected.ino
    )
      throw manual();
    if (
      (await boundedFileHash(join(bin, "pnpm"), expected)) !==
      (await boundedFileHash(source, expected))
    )
      throw manual();
  }
}
export async function matchesManagedNpm(
  home: string,
  receipt: NpmReceipt,
  version: string,
  target: string,
  assets: Assets,
) {
  if (
    receipt.mode !== "managed" ||
    receipt.version !== version ||
    receipt.target !== target ||
    !identical(receipt.assets, assets)
  )
    return false;
  try {
    const root = join(resolve(home), ".agent-stack"),
      bin = join(root, "bin");
    await safeDir(root);
    await safeDir(bin);
    await verifyPublic(root, bin, receipt);
    return true;
  } catch {
    return false;
  }
}

// Read-only: a verified receipt identifies previously version-checked bytes.
// In particular this does not start Pi or discover its user extensions.
export async function observeInstalledNpm(
  home: string,
  component: "pi" | "pnpm",
): Promise<Observation | null> {
  const receipt = (await readSetupState(home))?.installations[component];
  if (!receipt) return null;
  const path =
    receipt.mode === "managed"
      ? join(resolve(home), ".agent-stack", "bin", component)
      : receipt.path;
  try {
    if (
      receipt.component !== component ||
      (await findExecutable(component)) !== path
    )
      throw manual();
    if (receipt.mode === "managed") {
      await verifyPublic(
        join(resolve(home), ".agent-stack"),
        join(resolve(home), ".agent-stack", "bin"),
        receipt,
      );
    } else if ((await uvEntryFingerprint(path)) !== receipt.fingerprint)
      throw manual();
    return {
      path,
      version: receipt.version,
      failure: null,
      evidence: "installation_receipt",
    };
  } catch {
    return {
      path,
      version: null,
      failure: "unverified_entrypoint",
      evidence: null,
    };
  }
}

async function verifyProgram(
  path: string,
  component: "pi" | "pnpm",
  version: string,
  node: { path: string; version: string },
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error("Cancelled");
  const temporary = await mkdtemp(
    join(await realpath(tmpdir()), "agent-stack-npm-version-"),
  );
  try {
    await new Promise<void>((done, fail) => {
      let closed = false,
        outcome: Error | null | undefined;
      const finish = () => {
        if (closed && outcome !== undefined) outcome ? fail(outcome) : done();
      };
      const child = execFile(
        component === "pi" ? node.path : path,
        component === "pi" ? [path, "--version"] : ["--version"],
        {
          cwd: temporary,
          env: {
            PATH: `${dirname(node.path)}:/usr/bin:/bin`,
            HOME: temporary,
            USERPROFILE: temporary,
            PI_CODING_AGENT_DIR: join(temporary, "pi"),
            XDG_CONFIG_HOME: temporary,
            XDG_CACHE_HOME: temporary,
            npm_config_manage_package_manager_versions: "false",
            pnpm_config_pm_on_fail: "ignore",
            COREPACK_ENABLE_NETWORK: "0",
          },
          timeout: 10000,
          maxBuffer: 16384,
          killSignal: "SIGKILL",
          encoding: "utf8",
        },
        (error, stdout) => {
          outcome =
            error || stdout.trim() !== version
              ? new Error(`Cannot verify installed ${component} version`)
              : null;
          finish();
        },
      );
      const abort = () => {
        child.kill("SIGKILL");
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.once("close", () => {
        signal.removeEventListener("abort", abort);
        closed = true;
        finish();
      });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function recoverNpmInstallation(
  root: string,
  bin: string,
  pending: NpmPending,
  raw: string,
  journalIdentity: { dev: string; ino: string },
) {
  if (!pending.stage.startsWith(`${pending.component}-`)) throw manual();
  const path = join(root, "pending.json"),
    statePath = join(root, "binding.json");
  if (
    (await optional(path)) !== raw ||
    !identical(await inode(path), journalIdentity)
  )
    throw manual();
  const bytes = await optionalBytes(statePath),
    stateHash = bytes === null ? null : hash(bytes);
  const committed =
    pending.afterHash !== null && stateHash === pending.afterHash;
  if (!committed && stateHash !== pending.beforeHash)
    throw new Error("Setup state is a third value; manual recovery required");
  if (
    !committed &&
    bytes !== null &&
    (!pending.beforeIdentity ||
      !identical(await inode(statePath), pending.beforeIdentity))
  )
    throw manual();
  const stage = join(root, pending.stage),
    publicPath = join(bin, pending.component);
  if (committed) {
    const receipt =
      bytes === null
        ? null
        : decodeSetupState(bytes.toString("utf8")).installations[
            pending.component
          ];
    if (
      receipt?.mode !== "managed" ||
      receipt.directory !== pending.stage ||
      !identical(receipt.tree, pending.tree) ||
      !identical(receipt.entry, pending.entry)
    )
      throw manual();
    await verifyPublic(root, bin, receipt);
  } else {
    // Validate the whole tree before deleting even the public entry. Unknown
    // or modified files preserve both the journal and the visible installation.
    if (!(await uvEntryAbsent(stage))) {
      if (!(await uvEntryAbsent(publicPath)))
        await verifyManagedTree(stage, pending.tree);
      if (!(await uvEntryAbsent(publicPath))) {
        if (
          !pending.entry ||
          !identical(await entryIdentity(publicPath), pending.entry)
        )
          throw manual();
        if (
          pending.component === "pi" &&
          pending.entry.target !== sourceEntry(stage, "pi")
        )
          throw manual();
        if (
          pending.component === "pnpm" &&
          !identical(
            await inode(publicPath),
            await inode(sourceEntry(stage, "pnpm")),
          )
        )
          throw manual();
        await unlink(publicPath);
      }
      await removeManagedTree(stage, pending.tree);
    } else if (!(await uvEntryAbsent(publicPath))) throw manual();
  }
  if ((await optional(path)) !== raw) throw manual();
  await removeOwned(path, journalIdentity.dev, journalIdentity.ino);
}

export type NpmInstallationInput = {
  home: string;
  path: string;
  repo: string;
  profile: string;
  lock: string;
  component: "pi" | "pnpm";
  version: string;
  target: "darwin-arm64" | "darwin-x64";
  node: { path: string; version: string };
  npm: string;
  assets: Assets;
  signal: AbortSignal;
  recheck: () => Promise<void>;
  checkReachable: () => Promise<void>;
  deferBinding?: boolean;
};

function nextBinding(
  old: SetupState | null,
  input: NpmInstallationInput,
  receipt: NpmReceipt,
): SetupState {
  return setupStateSchema.parse({
    schemaVersion: 2,
    defaultBinding: input.deferBinding
      ? (old?.defaultBinding ?? null)
      : { repo: input.repo, profile: input.profile, lock: input.lock },
    installations: { ...old?.installations, [input.component]: receipt },
  });
}

export async function applyNpmComponent(
  input: NpmInstallationInput,
): Promise<SetupState> {
  if (
    process.platform !== "darwin" ||
    input.target !== `darwin-${process.arch}`
  )
    throw new Error("npm setup requires the current native macOS target");
  const { root, bin } = await inspectUvPath(input.home, input.path);
  if (input.component === "pi")
    await assertNodeTarget(input.node, input.target, input.signal);
  const assets = input.assets.map((asset) =>
    npmAssetReceiptSchema.parse(asset),
  );
  const top = assets.find((asset) => asset.role === "top-level");
  if (
    !top ||
    top.name !==
      (input.component === "pi" ? "@earendil-works/pi-coding-agent" : "pnpm") ||
    top.version !== input.version
  )
    throw new Error("Missing locked npm package identity");
  return withSetupOperation(root, async () => {
    await recoverPendingUv(input.home, input.path, input.signal, input.recheck);
    const operation = await acquireSetupOperation(root);
    const statePath = join(root, "binding.json"),
      beforeBytes = await optionalBytes(statePath);
    const old =
      beforeBytes === null
        ? null
        : decodeSetupState(beforeBytes.toString("utf8"));
    const existing = old?.installations[input.component];
    const currentRoot = await directoryInode(root);
    const publish = async (binding: SetupState, completed: () => void) => {
      await publishSetupState({
        root,
        path: statePath,
        existingBytes: beforeBytes,
        binding,
        operation,
        currentRoot: `${currentRoot.dev}:${currentRoot.ino}`,
        signal: input.signal,
        recheck: input.recheck,
        committed: completed,
        label: `${input.component} installation`,
      });
    };
    if (existing) {
      if (
        !(await matchesManagedNpm(
          input.home,
          existing,
          input.version,
          input.target,
          assets,
        ))
      )
        throw new Error(
          "Existing npm installation does not match the lock; retain its native installation",
        );
      if (existing.mode === "managed" && existing.component === "pi") {
        await inspectPiInstallation(
          join(root, existing.directory),
          input.version,
          input.node.version,
        );
      }
      const binding = nextBinding(old, input, existing);
      await input.recheck();
      await input.checkReachable();
      if (!identical(old, binding)) await publish(binding, () => {});
      return binding;
    }
    const publicPath = join(bin, input.component);
    await input.recheck();
    if (!(await uvEntryAbsent(publicPath)))
      throw new Error("Existing npm entry is not owned; refusing to overwrite");
    const name = npmStageName.parse(
      `${input.component}-${input.version}-${input.target}-${randomBytes(16).toString("hex")}`,
    );
    const stage = join(root, name);
    await operation.stageIntent(name);
    await mkdir(stage, { mode: 0o700 });
    const stageIdentity = await directoryInode(stage);
    await operation.stage(name, stageIdentity);
    let tree: ManagedTreeReceipt | undefined, journalRaw: string | undefined;
    let journalIdentity: { dev: string; ino: string } | undefined;
    let pending: NpmPending | undefined,
      published = false;
    const journalPath = join(root, "pending.json");
    const cleanup = async () => {
      if (published) return;
      if (pending && journalRaw && journalIdentity)
        await recoverNpmInstallation(
          root,
          bin,
          pending,
          journalRaw,
          journalIdentity,
        );
      else if (tree) await removeManagedTree(stage, tree);
      else if ((await readdir(stage)).length === 0) {
        if (!identical(await directoryInode(stage), stageIdentity))
          throw manual();
        await rmdir(stage);
      } else
        throw new Error(
          `Incomplete npm tree ownership; files retained at ${stage}; manual recovery required`,
        );
    };
    try {
      let npmVersion: string | null = null,
        lockHash: string | null = null;
      let expectedTree: string;
      if (input.component === "pi") {
        if (assets.length !== 1) throw new Error("Unexpected Pi assets");
        const result = await stagePi({
          stage,
          npm: input.npm,
          node: input.node,
          version: input.version,
          url: top.url,
          integrity: top.integrity,
          signal: input.signal,
        });
        expectedTree = result.treeDigest;
        npmVersion = result.npmVersion;
        lockHash = hash(result.lockBytes);
      } else {
        const native = assets.find((asset) => asset.role === "native");
        if (assets.length !== 2 || !native)
          throw new Error("Missing locked native pnpm package");
        const binary = await prepareLockedPnpm({
          top: { ...top },
          native: { ...native },
          target: input.target,
          node: input.node.version,
          signal: input.signal,
        });
        const file = await open(join(stage, "pnpm"), "wx", 0o755);
        try {
          await file.writeFile(binary);
          await file.sync();
        } finally {
          await file.close();
        }
        await verifyProgram(
          join(stage, "pnpm"),
          "pnpm",
          input.version,
          input.node,
          input.signal,
        );
        if (!identical((await readdir(stage)).sort(), ["pnpm"])) throw manual();
        expectedTree = await managedTreeDigest(stage);
      }
      tree = await recordManagedTree(
        stage,
        async (receipt) => {
          tree = receipt;
          await operation.file(treeManifestName, receipt.manifest);
        },
        expectedTree,
      );
      await input.recheck();
      if (input.signal.aborted) throw new Error("Cancelled");
      pending = npmPendingSchema.parse({
        schemaVersion: 2,
        kind: "npm-install",
        component: input.component,
        stage: name,
        tree,
        entry: null,
        beforeHash: beforeBytes === null ? null : hash(beforeBytes),
        beforeIdentity: beforeBytes === null ? null : await inode(statePath),
        afterHash: null,
      });
      const journal = await open(journalPath, "wx", 0o600);
      journalIdentity = await inode(journalPath);
      journalRaw = JSON.stringify(pending);
      try {
        await journal.writeFile(journalRaw);
        await journal.sync();
      } finally {
        await journal.close();
      }
      if (input.component === "pi")
        await symlink(sourceEntry(stage, "pi"), publicPath);
      else await link(sourceEntry(stage, "pnpm"), publicPath);
      const entry = await entryIdentity(publicPath);
      const receipt = managedNpmReceiptSchema.parse({
        mode: "managed",
        component: input.component,
        version: input.version,
        target: input.target,
        directory: name,
        entry,
        tree,
        assets,
        npmVersion,
        lockHash,
      });
      const binding = nextBinding(old, input, receipt);
      const next = npmPendingSchema.parse({
        ...pending,
        entry,
        afterHash: hash(Buffer.from(JSON.stringify(binding))),
      });
      if ((await optional(journalPath)) !== journalRaw) throw manual();
      const handle = await open(
        journalPath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      try {
        const handleIdentity = await handle.stat({ bigint: true });
        if (
          String(handleIdentity.dev) !== journalIdentity.dev ||
          String(handleIdentity.ino) !== journalIdentity.ino
        )
          throw manual();
        if (!identical(await inode(journalPath), journalIdentity))
          throw manual();
        await handle.truncate(0);
        await handle.writeFile(JSON.stringify(next));
        await handle.sync();
      } finally {
        await handle.close();
      }
      pending = next;
      journalRaw = JSON.stringify(next);
      await verifyPublic(root, bin, receipt);
      await input.recheck();
      await input.checkReachable();
      await verifyProgram(
        publicPath,
        input.component,
        input.version,
        input.node,
        input.signal,
      );
      await verifyPublic(root, bin, receipt);
      await publish(binding, () => {
        published = true;
      });
      if ((await optional(journalPath)) !== journalRaw) throw manual();
      await removeOwned(journalPath, journalIdentity.dev, journalIdentity.ino);
      journalRaw = undefined;
      return binding;
    } finally {
      await cleanup();
    }
  });
}
