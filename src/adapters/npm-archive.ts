import { createHash, timingSafeEqual } from "node:crypto";
import https from "node:https";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import semver from "semver";
import { list, type Parser } from "tar";
import { z } from "zod";
import { checkNpmDistribution } from "../core/npm-candidate.js";

const maxDownload = 128 * 1024 * 1024;
const maxExpanded = 256 * 1024 * 1024;
const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  engines: z.object({ node: z.string().optional() }).optional(),
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

async function fetchBytes(url: string, signal: AbortSignal) {
  const timeout = AbortSignal.timeout(30000);
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.any([signal, timeout]),
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`npm download failed: HTTP ${response.status}`);
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxDownload)) {
    await response.body.cancel();
    throw new Error("npm download exceeds size limit");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxDownload) {
        await reader.cancel();
        throw new Error("npm download exceeds size limit");
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

// An independent, bounded retry for a stalled fetch body. In particular, some
// Node 26 environments stall on large registry responses while core HTTPS
// completes them. Neither transport follows redirects or bypasses the SRI gate.
async function httpsBytes(url: string, signal: AbortSignal): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        headers: { accept: "application/octet-stream" },
        maxHeaderSize: 16384,
      },
      async (response) => {
        try {
          if (
            response.statusCode === undefined ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          )
            throw Error(`npm download failed: HTTP ${response.statusCode}`);
          const declared = response.headers["content-length"];
          if (
            declared !== undefined &&
            (typeof declared !== "string" ||
              !/^\d+$/.test(declared) ||
              Number(declared) > maxDownload)
          )
            throw Error("npm download exceeds size limit");
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > maxDownload)
              throw Error("npm download exceeds size limit");
            chunks.push(bytes);
          }
          if (signal.aborted) throw Error("Cancelled");
          resolve(Buffer.concat(chunks, size));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    request.once("error", reject);
  });
}

export async function downloadNpm(
  url: string,
  integrity: string,
  signal: AbortSignal,
) {
  checkNpmDistribution(url, integrity);
  if (signal.aborted) throw Error("Cancelled");
  let data: Buffer;
  try {
    data = await fetchBytes(url, signal);
  } catch (error) {
    if (
      signal.aborted ||
      !(error instanceof Error) ||
      error.name !== "TimeoutError"
    )
      throw error;
    data = await httpsBytes(url, signal);
  }
  if (signal.aborted) throw Error("Cancelled");
  const expected = Buffer.from(integrity.slice(7), "base64");
  if (!timingSafeEqual(createHash("sha512").update(data).digest(), expected))
    throw new Error("npm tarball integrity mismatch");
  return data;
}

// Inspect the complete tar stream before handing it to npm or publishing bytes.
// No archive-controlled pathname is passed to a filesystem extractor.
export async function inspectNpmArchive(
  data: Buffer,
  expected: {
    name: string;
    version: string;
    node: string;
    native?: { os: string; cpu: string };
  },
  signal: AbortSignal,
) {
  const seen = new Set<string>();
  let total = 0;
  let manifest: Buffer | undefined;
  let binary: Buffer | undefined;
  let parser: Parser;
  parser = list({
    strict: true,
    onReadEntry(entry) {
      const path = entry.path;
      const pieces = path.replace(/\/$/, "").split("/");
      if (
        pieces[0] !== "package" ||
        pieces.some((p) => !p || p === "." || p === "..") ||
        path.includes("\\") ||
        seen.has(pieces.join("/")) ||
        seen.size >= 50000 ||
        !["File", "Directory"].includes(entry.type)
      ) {
        parser.abort(new Error("Unsafe npm archive entry"));
        return;
      }
      seen.add(pieces.join("/"));
      if (entry.size < 0 || total + entry.size > maxExpanded) {
        parser.abort(new Error("npm archive exceeds size limit"));
        return;
      }
      total += entry.size;
      if (
        entry.type !== "File" ||
        (path !== "package/package.json" &&
          !(expected.native && path === "package/pnpm"))
      )
        return;
      if (
        (path.endsWith("package.json") && entry.size > 1024 * 1024) ||
        entry.size === 0
      ) {
        parser.abort(new Error("Invalid npm archive entry size"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      entry.on("data", (chunk: Buffer) => {
        size += chunk.length;
        chunks.push(chunk);
      });
      entry.on("end", () => {
        if (size !== entry.size) {
          parser.abort(new Error("Truncated npm archive entry"));
          return;
        }
        if (path === "package/package.json")
          manifest = Buffer.concat(chunks, size);
        else binary = Buffer.concat(chunks, size);
      });
    },
  });
  let expanded = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      expanded += chunk.length;
      callback(
        expanded > maxExpanded + 16 * 1024 * 1024
          ? new Error("npm archive exceeds expanded limit")
          : null,
        chunk,
      );
    },
  });
  await pipeline(Readable.from(data), createGunzip(), limit, parser, {
    signal,
  });
  if (!manifest) throw new Error("npm package manifest missing");
  const metadata = manifestSchema.parse(JSON.parse(manifest.toString("utf8")));
  if (metadata.name !== expected.name || metadata.version !== expected.version)
    throw new Error("npm package identity mismatch");
  if (
    metadata.engines?.node &&
    (!semver.validRange(metadata.engines.node) ||
      !semver.satisfies(expected.node, metadata.engines.node))
  )
    throw new Error("npm package Node engines mismatch");
  if (
    expected.native &&
    (metadata.os?.length !== 1 ||
      metadata.os[0] !== expected.native.os ||
      metadata.cpu?.length !== 1 ||
      metadata.cpu[0] !== expected.native.cpu ||
      !binary)
  )
    throw new Error("npm native package target mismatch");
  return { metadata, binary };
}

export async function prepareLockedPnpm(input: {
  top: { url: string; integrity: string; version: string };
  native: { url: string; integrity: string; name: string; version: string };
  target: "darwin-arm64" | "darwin-x64";
  node: string;
  signal: AbortSignal;
}) {
  const cpu = input.target === "darwin-arm64" ? "arm64" : "x64";
  const name = `@pnpm/exe.darwin-${cpu}`;
  if (
    input.native.name !== name ||
    input.native.version !== input.top.version ||
    !semver.satisfies(input.top.version, ">=12.15.0 <13")
  )
    throw new Error("Unsupported pnpm native distribution");
  const [topArchive, nativeArchive] = await Promise.all([
    downloadNpm(input.top.url, input.top.integrity, input.signal),
    downloadNpm(input.native.url, input.native.integrity, input.signal),
  ]);
  const [top, native] = await Promise.all([
    inspectNpmArchive(
      topArchive,
      { name: "pnpm", version: input.top.version, node: input.node },
      input.signal,
    ),
    inspectNpmArchive(
      nativeArchive,
      {
        name,
        version: input.native.version,
        node: input.node,
        native: { os: "darwin", cpu },
      },
      input.signal,
    ),
  ]);
  if (top.metadata.optionalDependencies?.[name] !== input.native.version)
    throw new Error("pnpm native dependency does not match locked asset");
  const binary = native.binary;
  if (!binary || binary.length < 32)
    throw new Error("pnpm native binary is incomplete");
  const magic = binary.subarray(0, 4).toString("hex");
  if (magic !== "cffaedfe" && magic !== "feedfacf")
    throw new Error("pnpm asset is not a standalone 64-bit Mach-O binary");
  const architecture =
    magic === "cffaedfe" ? binary.readUInt32LE(4) : binary.readUInt32BE(4);
  if (architecture !== (cpu === "arm64" ? 0x0100000c : 0x01000007))
    throw new Error("pnpm binary architecture mismatch");
  return binary;
}
