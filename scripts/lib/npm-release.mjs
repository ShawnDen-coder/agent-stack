import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const registry = "https://npm.pkg.github.com";

export async function registryDecision({
  name,
  version,
  tarball,
  token,
  fetcher = fetch,
}) {
  if (!token) throw new Error("GitHub Packages requires NODE_AUTH_TOKEN");
  const url = new URL(registry);
  url.pathname = name.replace("/", "%2f");
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  if (response.status === 404) return "publish";
  if (!response.ok)
    throw new Error(`npm registry returned HTTP ${response.status}`);
  const packument = await response.json();
  if (
    packument?.name !== name ||
    !packument.versions ||
    typeof packument.versions !== "object" ||
    Array.isArray(packument.versions)
  )
    throw new Error("Registry package metadata is invalid");
  if (!Object.hasOwn(packument.versions, version)) return "publish";
  const metadata = packument.versions[version];
  if (
    metadata?.name !== name ||
    metadata.version !== version ||
    typeof metadata.dist?.integrity !== "string"
  )
    throw new Error("Registry version metadata is invalid");
  const actual = `sha512-${createHash("sha512")
    .update(await readFile(tarball))
    .digest("base64")}`;
  if (metadata.dist.integrity !== actual)
    throw new Error(
      "Published version integrity differs from verified tarball",
    );
  return "skip";
}
