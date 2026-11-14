import { z } from "zod";

const targetSchema = z.string().regex(/^[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)?$/);
export function validTarget(value: string) {
  return targetSchema.safeParse(value).success;
}
const manifestSchema = z.object({
  assets: z.record(z.string(), z.unknown()),
  sha256: z.record(z.string(), z.unknown()),
});
const mappings: Record<string, string> = {
  "darwin-arm64": "macos-aarch64",
  "darwin-x64": "macos-x86_64",
  "win32-x64": "windows-x86_64",
};
export function herdrAsset(data: unknown, version: string, target: string) {
  const key = mappings[target];
  if (!key)
    throw new Error(
      `Target ${target} is not supported by herdr asset preview (Linux ABI evidence is not established)`,
    );
  const manifest = manifestSchema.parse(data);
  const rawUrl = manifest.assets[key];
  const digest = manifest.sha256[key];
  if (typeof rawUrl !== "string")
    throw new Error(`Missing asset URL for ${key}`);
  if (typeof digest !== "string" || !/^[a-fA-F0-9]{64}$/.test(digest))
    throw new Error(`Missing or invalid SHA-256 for ${key}`);
  const expectedName = `herdr-${key}${key.startsWith("windows-") ? ".zip" : ""}`;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid asset URL for ${key}`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !==
      `/herdrdev/herdr/releases/download/v${version}/${expectedName}`
  )
    throw new Error(`Untrusted or version-mismatched asset URL for ${key}`);
  return {
    target,
    identity: expectedName,
    url: rawUrl,
    sha256: digest.toLowerCase(),
    digestSource: "https://herdr.dev/latest.json",
    format: key.startsWith("windows-") ? ("zip" as const) : ("binary" as const),
  };
}
