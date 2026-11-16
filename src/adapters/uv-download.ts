import { createHash } from "node:crypto";

const maxBytes = 64 * 1024 * 1024;
class UvDownloadError extends Error {}
const allowed = new Set(["github.com", "release-assets.githubusercontent.com"]);

// Only GitHub's release endpoint and its asset CDN may be contacted. Redirect
// tokens are never printed and no ambient authentication is supplied.
export async function downloadUv(
  url: string,
  sha256: string,
  signal: AbortSignal,
): Promise<Buffer> {
  if (signal.aborted) throw new UvDownloadError("Cancelled");
  const timeout = AbortSignal.timeout(30000);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    let next = new URL(url);
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (
        (redirects > 0 && next.hostname === "github.com") ||
        (redirects === 0 && (next.hostname !== "github.com" || next.search)) ||
        next.protocol !== "https:" ||
        !allowed.has(next.hostname) ||
        next.username ||
        next.password ||
        next.hash ||
        (next.port && next.port !== "443")
      )
        throw new UvDownloadError("Untrusted uv download URL");
      const response = await fetch(next, {
        redirect: "manual",
        signal: combined,
        headers: { accept: "application/octet-stream" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 4)
          throw new UvDownloadError("Invalid uv download redirect");
        next = new URL(location, next);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new UvDownloadError(
          `uv download failed: HTTP ${response.status}`,
        );
      }
      const declared = response.headers.get("content-length");
      if (
        declared &&
        (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
      ) {
        await response.body.cancel();
        throw new UvDownloadError("uv download exceeds size limit");
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new UvDownloadError("uv download exceeds size limit");
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      const data = Buffer.concat(chunks, size);
      if (createHash("sha256").update(data).digest("hex") !== sha256)
        throw new UvDownloadError("uv download SHA-256 mismatch");
      return data;
    }
    throw new UvDownloadError("Too many uv download redirects");
  } catch (error) {
    if (signal.aborted) throw new UvDownloadError("Cancelled");
    if (timeout.aborted) throw new UvDownloadError("uv download timed out");
    if (error instanceof UvDownloadError) throw error;
    throw new UvDownloadError("uv download failed");
  }
}
