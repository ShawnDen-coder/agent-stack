import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { list, type Parser } from "tar";

const maxExpanded = 128 * 1024 * 1024;

// The release archive is treated as untrusted input. Never pass its paths to
// a filesystem extractor: only these two known regular files are consumed.
export async function readUvArchive(
  path: string,
  assetName: string,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error("Cancelled");
  if (!/^uv-(?:aarch64|x86_64)-apple-darwin\.tar\.gz$/.test(assetName))
    throw new Error("Unsupported uv archive identity");
  const root = assetName.slice(0, -".tar.gz".length);
  const allowed = new Set([`${root}/uv`, `${root}/uvx`]);
  const files = new Map<string, Buffer>();
  const seen = new Set<string>();
  let total = 0;
  let parser: Parser;
  parser = list({
    strict: true,
    onReadEntry(entry): void {
      if (seen.has(entry.path)) {
        parser.abort(new Error("Duplicate uv archive entry"));
        return;
      }
      seen.add(entry.path);
      if (seen.size > 3) {
        parser.abort(new Error("Too many uv archive entries"));
        return;
      }
      if (entry.type === "Directory" && entry.path === `${root}/`) return;
      if (entry.type !== "File" || !allowed.has(entry.path)) {
        parser.abort(new Error("Unexpected uv archive entry"));
        return;
      }
      if (entry.size <= 0 || total + entry.size > maxExpanded) {
        parser.abort(new Error("uv archive exceeds expanded size limit"));
        return;
      }
      total += entry.size;
      const chunks: Buffer[] = [];
      let size = 0;
      entry.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > entry.size)
          parser.abort(new Error("Invalid uv archive entry size"));
        else chunks.push(chunk);
      });
      entry.on("end", () => {
        if (size !== entry.size)
          parser.abort(new Error("Truncated uv archive entry"));
        else
          files.set(entry.path.slice(root.length + 1), Buffer.concat(chunks));
      });
    },
  });
  let inflated = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      inflated += chunk.length;
      if (inflated > maxExpanded + 1024 * 1024)
        callback(new Error("uv archive exceeds expanded size limit"));
      else callback(null, chunk);
    },
  });
  await pipeline(createReadStream(path), createGunzip(), limiter, parser, {
    signal,
  });
  if (files.size !== 2 || !files.has("uv") || !files.has("uvx"))
    throw new Error("Missing uv archive entries");
  return files;
}
