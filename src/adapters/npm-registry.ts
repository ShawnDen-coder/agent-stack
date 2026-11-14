import { readJsonBody } from "./json-body.js";

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
    const body = await readJsonBody(response, limit);
    if (!body.ok) {
      if (body.reason === "no-body")
        throw new Error("Registry response has no body");
      if (body.reason === "invalid-json")
        throw new Error("Registry response is invalid JSON");
      throw new Error("Registry response exceeds size limit");
    }
    return body.data;
  } catch (error) {
    if (timeout.aborted) throw new Error("Registry request timed out");
    if (signal.aborted) throw new Error("Registry request cancelled");
    throw error;
  }
}
