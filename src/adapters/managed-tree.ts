import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type ManagedTree,
  type ManagedTreeReceipt,
  managedTreeReceiptSchema,
  managedTreeSchema,
} from "../core/managed-tree.js";
import {
  boundedFileHash,
  directoryInode,
  hash,
  inode,
  missing,
  removeOwned,
  safeDir,
} from "./managed-operation.js";

export const treeManifestName = ".ownership.json";
const limit = 16 * 1024 * 1024;
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
const manual = () =>
  new Error("Managed tree changed; manual recovery required");

export async function managedTreeDigest(root: string): Promise<string> {
  return hash(Buffer.from(JSON.stringify(await snapshot(root, false, true))));
}

async function snapshot(
  root: string,
  omitManifest: boolean,
  resolveLinks: boolean,
): Promise<ManagedTree> {
  if (!isAbsolute(root) || resolve(root) !== root) throw manual();
  const entries: ManagedTree["entries"] = [];
  let bytes = 0n;
  const visit = async (
    path: string,
    name: string,
    depth: number,
  ): Promise<void> => {
    if (depth > 128 || entries.length >= 50000) throw manual();
    const before = await lstat(path, { bigint: true });
    if (!before.ino) throw manual();
    const identity = { dev: String(before.dev), ino: String(before.ino) };
    const base = {
      ...identity,
      path: name,
      mode: Number(before.mode & 0o7777n),
    };
    if (before.isDirectory()) {
      await safeDir(path);
      const names = (await readdir(path)).sort();
      entries.push({ ...base, type: "directory" });
      for (const child of names) {
        if (!name && child === treeManifestName) {
          if (!omitManifest) throw manual();
          continue;
        }
        if (!child || child === "." || child === ".." || /[/\\\0]/.test(child))
          throw manual();
        await visit(
          join(path, child),
          name ? `${name}/${child}` : child,
          depth + 1,
        );
      }
      const after = await directoryInode(path);
      if (!same(after, identity) || !same((await readdir(path)).sort(), names))
        throw manual();
    } else if (before.isFile()) {
      bytes += before.size;
      if (bytes > 1024n * 1024n * 1024n) throw manual();
      entries.push({
        ...base,
        type: "file",
        sha256: await boundedFileHash(path, identity),
      });
    } else if (before.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target)) throw manual();
      const lexical = relative(root, resolve(dirname(path), target));
      if (
        lexical === ".." ||
        lexical.startsWith(`..${sep}`) ||
        isAbsolute(lexical)
      )
        throw manual();
      if (resolveLinks) {
        const destination = await realpath(path);
        const rel = relative(root, destination);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
          throw manual();
      }
      const after = await lstat(path, { bigint: true });
      if (
        !after.isSymbolicLink() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        (await readlink(path)) !== target
      )
        throw manual();
      entries.push({ ...base, type: "link", target });
    } else throw manual();
  };
  await visit(root, "", 0);
  return managedTreeSchema.parse({ schemaVersion: 1, entries });
}

async function manifest(
  root: string,
  receipt: ManagedTreeReceipt,
): Promise<ManagedTree> {
  if (!same(await directoryInode(root), receipt.root)) throw manual();
  const path = join(root, treeManifestName);
  if (
    !same(await inode(path), {
      dev: receipt.manifest.dev,
      ino: receipt.manifest.ino,
    })
  )
    throw manual();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size > BigInt(limit) ||
      String(before.dev) !== receipt.manifest.dev ||
      String(before.ino) !== receipt.manifest.ino
    )
      throw manual();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      BigInt(length) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      !same(await inode(path), {
        dev: receipt.manifest.dev,
        ino: receipt.manifest.ino,
      })
    )
      throw manual();
    const bytes = buffer.subarray(0, length);
    if (hash(bytes) !== receipt.manifest.sha256) throw manual();
    let parsed: ManagedTree;
    try {
      parsed = managedTreeSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw manual();
    }
    const rootEntry = parsed.entries.find((item) => item.path === "");
    if (
      !rootEntry ||
      rootEntry.dev !== receipt.root.dev ||
      rootEntry.ino !== receipt.root.ino
    )
      throw manual();
    return parsed;
  } finally {
    await file.close();
  }
}

// Called only after the installer has stopped. The receipt authorizes exact
// recorded entries, never arbitrary recursive removal of the enclosing path.
export async function recordManagedTree(
  root: string,
  record: (receipt: ManagedTreeReceipt) => Promise<void>,
  expectedDigest?: string,
): Promise<ManagedTreeReceipt> {
  const tree = await snapshot(root, false, true);
  const bytes = Buffer.from(JSON.stringify(tree));
  if (expectedDigest !== undefined && hash(bytes) !== expectedDigest)
    throw manual();
  if (bytes.length > limit) throw manual();
  const file = await open(join(root, treeManifestName), "wx", 0o600);
  try {
    const value = await file.stat({ bigint: true });
    const receipt = managedTreeReceiptSchema.parse({
      root: await directoryInode(root),
      manifest: {
        dev: String(value.dev),
        ino: String(value.ino),
        sha256: hash(bytes),
      },
    });
    // Persist creation identity before writing, retaining an interrupted or
    // incomplete manifest for manual review rather than guessing its ownership.
    await record(receipt);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    await verifyManagedTree(root, receipt);
    return receipt;
  } finally {
    await file.close().catch(() => {});
  }
}

export async function verifyManagedTree(
  root: string,
  receipt: ManagedTreeReceipt,
): Promise<void> {
  const expected = await manifest(root, receipt);
  const actual = await snapshot(root, true, true);
  if (!same(actual, expected)) throw manual();
  await manifest(root, receipt);
}

export async function removeManagedTree(
  root: string,
  receipt: ManagedTreeReceipt,
): Promise<void> {
  try {
    await safeDir(root);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (!same(await directoryInode(root), receipt.root)) throw manual();
  let expected: ManagedTree;
  try {
    expected = await manifest(root, receipt);
  } catch (error) {
    // A previous cleanup can die after deleting its manifest but before rmdir.
    if (missing(error) && (await readdir(root)).length === 0) {
      if (!same(await directoryInode(root), receipt.root)) throw manual();
      await rmdir(root);
      return;
    }
    throw error;
  }
  const recorded = new Map(expected.entries.map((item) => [item.path, item]));
  const actual = await snapshot(root, true, false);
  for (const item of actual.entries)
    if (!same(item, recorded.get(item.path))) throw manual();
  const ordered = [...expected.entries]
    .filter((item) => item.path)
    .sort((a, b) => b.path.split("/").length - a.path.split("/").length);
  for (const item of ordered) {
    const path = join(root, ...item.path.split("/"));
    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(path);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    const identity = await lstat(path, { bigint: true });
    if (
      String(identity.dev) !== item.dev ||
      String(identity.ino) !== item.ino ||
      Number(identity.mode & 0o7777n) !== item.mode
    )
      throw manual();
    if (item.type === "directory") {
      if (!current.isDirectory() || current.isSymbolicLink()) throw manual();
      await safeDir(path);
      await rmdir(path);
    } else if (item.type === "file") {
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        (await boundedFileHash(path, item)) !== item.sha256
      )
        throw manual();
      await removeOwned(path, item.dev, item.ino);
    } else {
      if (!current.isSymbolicLink() || (await readlink(path)) !== item.target)
        throw manual();
      const after = await lstat(path, { bigint: true });
      if (String(after.dev) !== item.dev || String(after.ino) !== item.ino)
        throw manual();
      await unlink(path);
    }
  }
  if (
    !same((await readdir(root)).sort(), [treeManifestName]) ||
    !same(await directoryInode(root), receipt.root)
  )
    throw manual();
  await manifest(root, receipt);
  await removeOwned(
    join(root, treeManifestName),
    receipt.manifest.dev,
    receipt.manifest.ino,
  );
  await rmdir(root);
}
