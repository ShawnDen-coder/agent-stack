const limit = 8 * 1024 * 1024;
export async function readPackument(
  name: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name))
    throw new Error("Invalid npm package name");
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const timeout = AbortSignal.timeout(5000);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, timeout]),
      redirect: "error",
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!response.ok) throw new Error(`Registry HTTP ${response.status}`);
    if (!response.body) throw new Error("Registry response has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > limit)
          throw new Error("Registry response exceeds size limit");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new Error("Registry response is invalid JSON");
    }
  } catch (error) {
    if (timeout.aborted) throw new Error("Registry request timed out");
    if (signal.aborted) throw new Error("Registry request cancelled");
    throw error;
  }
}
