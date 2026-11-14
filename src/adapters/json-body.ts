// Only the response body is shared; each source owns its timeout, status and error wording.
export async function readJsonBody(
  response: Response,
  pageLimit: number,
  remaining = pageLimit,
) {
  if (!response.body) return { ok: false, reason: "no-body" } as const;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > pageLimit)
        return { ok: false, reason: "page-limit" } as const;
      if (bytes > remaining)
        return { ok: false, reason: "total-limit" } as const;
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return {
      ok: true,
      data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      bytes,
    } as const;
  } catch {
    return { ok: false, reason: "invalid-json" } as const;
  }
}
