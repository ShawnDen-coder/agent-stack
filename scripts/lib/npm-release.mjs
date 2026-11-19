import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function registryDecision({
  registry,
  name,
  version,
  tarball,
  fetcher = fetch,
}) {
  const url = new URL(
    `${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    registry,
  );
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return "publish";
  if (!response.ok)
    throw new Error(`npm registry returned HTTP ${response.status}`);
  const metadata = await response.json();
  if (
    metadata.name !== name ||
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
