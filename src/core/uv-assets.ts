import { z } from "zod";
import type { UvRelease } from "./release-candidate.js";

const mappings: Record<string, { name: string; format: "tar.gz" | "zip" }> = {
  "darwin-arm64": { name: "uv-aarch64-apple-darwin.tar.gz", format: "tar.gz" },
  "darwin-x64": { name: "uv-x86_64-apple-darwin.tar.gz", format: "tar.gz" },
  "win32-x64": { name: "uv-x86_64-pc-windows-msvc.zip", format: "zip" },
};
const assetSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  state: z.literal("uploaded"),
  browser_download_url: z.string(),
  digest: z.string(),
});
export function uvAsset(release: UvRelease, target: string) {
  const mapping = mappings[target];
  if (!mapping) throw new Error(`uv target ${target} is not supported`);
  if (!Array.isArray(release.assets))
    throw new Error("Selected uv release assets are unavailable");
  const matches = release.assets.filter(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      entry.name === mapping.name,
  );
  if (matches.length !== 1)
    throw new Error(`Missing or duplicate uv asset: ${mapping.name}`);
  const asset = assetSchema.parse(matches[0]);
  const otherIds = release.assets.filter(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "id" in entry &&
      entry.id === asset.id,
  );
  if (otherIds.length !== 1) throw new Error("Duplicate uv asset identity");
  const digest = /^sha256:([0-9a-fA-F]{64})$/.exec(asset.digest);
  if (!digest?.[1])
    throw new Error(`Missing or invalid SHA-256 digest for ${mapping.name}`);
  let url: URL;
  try {
    url = new URL(asset.browser_download_url);
  } catch {
    throw new Error("Invalid uv asset URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !==
      `/astral-sh/uv/releases/download/${release.tag_name}/${mapping.name}`
  )
    throw new Error("Untrusted or version-mismatched uv asset URL");
  return {
    target,
    identity: `${mapping.name} (asset ${asset.id})`,
    releaseId: release.id,
    assetId: asset.id,
    assetName: asset.name,
    url: asset.browser_download_url,
    sha256: digest[1].toLowerCase(),
    digestSource: "https://api.github.com/repos/astral-sh/uv/releases",
    format: mapping.format,
  };
}
