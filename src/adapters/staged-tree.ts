import { createHash } from "node:crypto";
import { lstat, readdir, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { boundedFileHash, directoryInode } from "./managed-operation.js";

// Snapshot identities and contents without traversing symlinks. A digest alone
// is evidence of equality, not authorization to recursively delete this tree.
export async function stagedTreeDigest(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error("Staging path must be absolute");
  const digest = createHash("sha256");
  let entries = 0;
  let bytes = 0n;
  const add = (record: unknown) => digest.update(`${JSON.stringify(record)}\n`);
  const visit = async (path: string, name: string): Promise<void> => {
    if (++entries > 50000) throw new Error("Staging tree exceeds entry limit");
    const before = await lstat(path, { bigint: true });
    if (!before.ino) throw new Error("Cannot verify staging ownership");
    const identity = { dev: String(before.dev), ino: String(before.ino) };
    if (before.isDirectory()) {
      const names = (await readdir(path)).sort();
      add({ name, type: "directory", ...identity });
      for (const child of names) {
        if (!child || child === "." || child === ".." || child.includes("/"))
          throw new Error("Invalid staging path");
        await visit(join(path, child), name ? `${name}/${child}` : child);
      }
      const after = await directoryInode(path);
      if (
        after.dev !== identity.dev ||
        after.ino !== identity.ino ||
        JSON.stringify((await readdir(path)).sort()) !== JSON.stringify(names)
      )
        throw new Error("Staging directory changed during inspection");
    } else if (before.isFile()) {
      bytes += before.size;
      if (bytes > 1024n * 1024n * 1024n)
        throw new Error("Staging tree exceeds size limit");
      add({
        name,
        type: "file",
        ...identity,
        mode: String(before.mode),
        sha256: await boundedFileHash(path, identity),
      });
    } else if (before.isSymbolicLink()) {
      const target = await readlink(path);
      const destination = resolve(dirname(path), target);
      const rel = relative(root, destination);
      if (isAbsolute(target) || rel === ".." || rel.startsWith(`..${sep}`))
        throw new Error("Staging link escapes its directory");
      const after = await lstat(path, { bigint: true });
      if (
        !after.isSymbolicLink() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        (await readlink(path)) !== target
      )
        throw new Error("Staging link changed during inspection");
      add({ name, type: "link", ...identity, target });
    } else throw new Error("Unsupported staging entry");
  };
  await visit(root, "");
  return digest.digest("hex");
}
