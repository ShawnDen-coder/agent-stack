import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { crc32, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { inode } from "./managed-operation.js";

export const herdrWindowsNames = [
  "conpty/arm64/OpenConsole.exe",
  "conpty/conpty.dll",
  "conpty/herdr-conpty.json",
  "conpty/x64/OpenConsole.exe",
  "herdr.exe",
  "THIRD-PARTY-NOTICES/Microsoft.Windows.Console.ConPTY-LICENSE.txt",
  "THIRD-PARTY-NOTICES/Microsoft.Windows.Console.ConPTY-NOTICE.md",
] as const;
export type HerdrWindowsFile = (typeof herdrWindowsNames)[number];
const expected = new Set<string>(herdrWindowsNames);
const maxExpanded = 128 * 1024 * 1024;
const maxZip = 64 * 1024 * 1024;
const markerSchema = z.strictObject({
  architecture: z.literal("x86_64"),
  files: z.strictObject({
    "conpty/arm64/OpenConsole.exe": z.string().regex(/^[a-f0-9]{64}$/),
    "conpty/conpty.dll": z.string().regex(/^[a-f0-9]{64}$/),
    "conpty/x64/OpenConsole.exe": z.string().regex(/^[a-f0-9]{64}$/),
  }),
  package: z.literal("Microsoft.Windows.Console.ConPTY"),
  schema_version: z.literal(1),
  version: z.string().min(1).max(128),
});
function fail(message: string): never {
  throw new Error(`Invalid Herdr Windows archive: ${message}`);
}
function checkPE(value: Buffer, machine: number, dll: boolean) {
  if (value.length < 64 || value.readUInt16LE(0) !== 0x5a4d)
    fail("invalid PE header");
  const offset = value.readUInt32LE(0x3c);
  if (offset > value.length - 26 || value.readUInt32LE(offset) !== 0x4550)
    fail("invalid PE signature");
  if (
    value.readUInt16LE(offset + 4) !== machine ||
    value.readUInt16LE(offset + 24) !== 0x20b
  )
    fail("unexpected PE architecture");
  if (Boolean(value.readUInt16LE(offset + 22) & 0x2000) !== dll)
    fail("unexpected PE file type");
}

// External reuse proves the observed entry is x64 PE; it does not claim the
// file came from the locked release or take ownership of it.
export async function verifyWindowsHerdrEntry(path: string): Promise<void> {
  const target = await realpath(path);
  const identity = await inode(target);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      String(before.dev) !== identity.dev ||
      String(before.ino) !== identity.ino ||
      before.size > 128n * 1024n * 1024n
    )
      throw new Error("External Herdr entry changed or exceeds size limit");
    const prefix = Buffer.alloc(64);
    if (
      (await file.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length
    )
      throw new Error("External Herdr PE header is incomplete");
    const offset = prefix.readUInt32LE(0x3c);
    if (offset < 64 || offset > 1024 * 1024)
      throw new Error("External Herdr PE offset is invalid");
    const value = Buffer.alloc(offset + 26);
    prefix.copy(value);
    if ((await file.read(value, offset, 26, offset)).bytesRead !== 26)
      throw new Error("External Herdr PE header is incomplete");
    checkPE(value, 0x8664, false);
    const after = await file.stat({ bigint: true });
    const current = await inode(target);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw new Error("External Herdr entry changed during inspection");
  } finally {
    await file.close();
  }
}

// Never use ZIP entry names as filesystem paths. The complete release layout
// is whitelisted, bounded and validated before any extracted bytes are used.
export function readHerdrWindowsArchive(
  zip: Buffer,
): Map<HerdrWindowsFile, Buffer> {
  if (zip.length < 22 || zip.length > maxZip) fail("archive size");
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (
      zip.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + zip.readUInt16LE(i + 20) === zip.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) fail("missing end record");
  if (
    zip.readUInt16LE(end + 4) !== 0 ||
    zip.readUInt16LE(end + 6) !== 0 ||
    zip.readUInt16LE(end + 8) !== herdrWindowsNames.length ||
    zip.readUInt16LE(end + 10) !== herdrWindowsNames.length
  )
    fail("unsupported archive entries");
  const size = zip.readUInt32LE(end + 12),
    start = zip.readUInt32LE(end + 16);
  if (start + size !== end) fail("invalid central directory");
  let pos = start,
    expanded = 0;
  const files = new Map<HerdrWindowsFile, Buffer>(),
    ranges: Array<[number, number]> = [];
  for (let i = 0; i < herdrWindowsNames.length; i++) {
    if (pos + 46 > end || zip.readUInt32LE(pos) !== 0x02014b50)
      fail("invalid central record");
    const flags = zip.readUInt16LE(pos + 8),
      method = zip.readUInt16LE(pos + 10);
    const crc = zip.readUInt32LE(pos + 16),
      compressed = zip.readUInt32LE(pos + 20),
      length = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28),
      extraLen = zip.readUInt16LE(pos + 30),
      commentLen = zip.readUInt16LE(pos + 32);
    const disk = zip.readUInt16LE(pos + 34),
      external = zip.readUInt32LE(pos + 38),
      local = zip.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (
      next > end ||
      disk !== 0 ||
      (flags & ~0x800) !== 0 ||
      (method !== 8 && method !== 0)
    )
      fail("unsupported record");
    const rawName = zip.subarray(pos + 46, pos + 46 + nameLen),
      name = rawName.toString("utf8");
    if (
      !Buffer.from(name, "utf8").equals(rawName) ||
      !expected.has(name) ||
      files.has(name as HerdrWindowsFile)
    )
      fail("unexpected or duplicate path");
    // Reject links and special files even when a producer misstates its OS.
    const unixType = (external >>> 16) & 0xf000;
    if (unixType !== 0 && unixType !== 0x8000) fail("non-regular entry");
    const entryLimit =
      name === "conpty/herdr-conpty.json"
        ? 1024 * 1024
        : name.startsWith("THIRD-PARTY-NOTICES/")
          ? 4 * 1024 * 1024
          : 64 * 1024 * 1024;
    expanded += length;
    if (
      (external & 0x458) !== 0 ||
      length === 0 ||
      length > entryLimit ||
      expanded > maxExpanded
    )
      fail("entry size or type");
    if (local + 30 > start || zip.readUInt32LE(local) !== 0x04034b50)
      fail("invalid local record");
    const localNameLen = zip.readUInt16LE(local + 26),
      localExtra = zip.readUInt16LE(local + 28);
    const body = local + 30 + localNameLen + localExtra,
      bodyEnd = body + compressed;
    if (
      bodyEnd > start ||
      zip.readUInt16LE(local + 6) !== flags ||
      zip.readUInt16LE(local + 8) !== method ||
      zip.readUInt32LE(local + 14) !== crc ||
      zip.readUInt32LE(local + 18) !== compressed ||
      zip.readUInt32LE(local + 22) !== length ||
      !zip.subarray(local + 30, local + 30 + localNameLen).equals(rawName)
    )
      fail("local record mismatch");
    if (ranges.some(([a, b]) => local < b && bodyEnd > a))
      fail("overlapping records");
    ranges.push([local, bodyEnd]);
    let data: Buffer;
    try {
      data =
        method === 8
          ? inflateRawSync(zip.subarray(body, bodyEnd), {
              maxOutputLength: length,
            })
          : Buffer.from(zip.subarray(body, bodyEnd));
    } catch {
      return fail("invalid compressed data");
    }
    if (data.length !== length || crc32(data) !== crc)
      fail("invalid entry checksum");
    files.set(name as HerdrWindowsFile, data);
    pos = next;
  }
  ranges.sort(([a], [b]) => a - b);
  let cursor = 0;
  for (const [begin, finish] of ranges) {
    if (begin !== cursor) fail("unexpected archive data");
    cursor = finish;
  }
  if (
    pos !== end ||
    files.size !== herdrWindowsNames.length ||
    cursor !== start
  )
    fail("invalid entry layout");
  const file = (name: HerdrWindowsFile) => {
    const value = files.get(name);
    if (!value) return fail("missing file");
    return value;
  };
  checkPE(file("herdr.exe"), 0x8664, false);
  checkPE(file("conpty/conpty.dll"), 0x8664, true);
  checkPE(file("conpty/x64/OpenConsole.exe"), 0x8664, false);
  checkPE(file("conpty/arm64/OpenConsole.exe"), 0xaa64, false);
  let marker: z.infer<typeof markerSchema>;
  try {
    marker = markerSchema.parse(
      JSON.parse(file("conpty/herdr-conpty.json").toString("utf8")),
    );
  } catch {
    return fail("invalid ConPTY marker");
  }
  for (const [name, digest] of Object.entries(marker.files)) {
    if (
      createHash("sha256")
        .update(file(name as HerdrWindowsFile))
        .digest("hex") !== digest
    )
      fail("ConPTY marker mismatch");
  }
  return files;
}
