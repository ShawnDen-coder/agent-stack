const uvUrl = "https://api.github.com/repos/astral-sh/uv/releases";
const herdrUrl = "https://herdr.dev/latest.json";

async function readJson(
  url: string,
  signal: AbortSignal,
  pageLimit = 4 * 1024 * 1024,
  remaining = pageLimit,
): Promise<{ data: unknown; link: string | null; bytes: number }> {
  const timeout = AbortSignal.timeout(5000);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, timeout]),
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(`Release metadata HTTP ${response.status}`);
    if (!response.body) throw new Error("Release metadata has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > pageLimit)
          throw new Error("Release metadata exceeds size limit");
        if (length > remaining)
          throw new Error("Release metadata exceeds total size limit");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    try {
      return {
        data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        link: response.headers.get("link"),
        bytes: length,
      };
    } catch {
      throw new Error("Release metadata is invalid JSON");
    }
  } catch (error) {
    if (timeout.aborted) throw new Error("Release metadata request timed out");
    if (signal.aborted) throw new Error("Release metadata request cancelled");
    throw error;
  }
}
export async function uvReleases(signal: AbortSignal): Promise<unknown[]> {
  const items: unknown[] = [];
  let page = 1;
  let total = 0;
  const pageLimit = 12 * 1024 * 1024;
  const totalLimit = 64 * 1024 * 1024;
  while (true) {
    const result = await readJson(
      `${uvUrl}?per_page=100&page=${page}`,
      signal,
      pageLimit,
      totalLimit - total,
    );
    total += result.bytes;
    if (!Array.isArray(result.data) || result.data.length > 100)
      throw new Error("Invalid release page");
    items.push(...result.data);
    const links = result.link?.split(",") ?? [];
    const next = links.filter((entry) => /\brel\s*=\s*"?next"?/i.test(entry));
    if (!next.length) return items;
    if (next.length !== 1 || page >= 10)
      throw new Error("Invalid or excessive release pagination");
    const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(next[0] ?? "");
    if (
      match?.[1] !== `${uvUrl}?per_page=100&page=${page + 1}` &&
      match?.[1] !== `${uvUrl}?page=${page + 1}&per_page=100` &&
      match?.[1] !==
        `https://api.github.com/repositories/699532645/releases?per_page=100&page=${page + 1}` &&
      match?.[1] !==
        `https://api.github.com/repositories/699532645/releases?page=${page + 1}&per_page=100`
    )
      throw new Error("Untrusted release pagination URL");
    page++;
  }
}
export async function herdrManifest(signal: AbortSignal): Promise<unknown> {
  return (await readJson(herdrUrl, signal)).data;
}
export { herdrUrl, uvUrl };
