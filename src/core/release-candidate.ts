import semver from "semver";
import { z } from "zod";

const releaseSchema = z.object({
  id: z.number().int().positive(),
  tag_name: z.string(),
  html_url: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.unknown().optional(),
});
export type UvRelease = z.infer<typeof releaseSchema>;
const manifestSchema = z.object({ version: z.string() });
const releaseStatusSchema = z.object({
  draft: z.boolean(),
  prerelease: z.boolean(),
});
export function selectUv(data: unknown[], range: string) {
  if (!semver.validRange(range))
    throw new Error(`Invalid semver range: ${range}`);
  const ids = new Set<number>();
  const tags = new Set<string>();
  const candidates = data
    .filter((entry) => {
      const status = releaseStatusSchema.parse(entry);
      return !status.draft && !status.prerelease;
    })
    .map((entry) => {
      const r = releaseSchema.parse(entry);
      if (ids.has(r.id) || tags.has(r.tag_name))
        throw new Error("Duplicate release identity");
      ids.add(r.id);
      tags.add(r.tag_name);
      const version = r.tag_name;
      if (
        semver.valid(version) !== version ||
        r.html_url !==
          `https://github.com/astral-sh/uv/releases/tag/${r.tag_name}`
      )
        throw new Error("Invalid uv release identity");
      return { ...r, version };
    })
    .filter(
      (r) =>
        !semver.prerelease(r.version) && semver.satisfies(r.version, range),
    );
  candidates.sort((a, b) => semver.rcompare(a.version, b.version));
  if (!candidates[0])
    throw new Error(`No official uv release matches ${range}`);
  return candidates[0];
}
export function selectHerdr(data: unknown, channel: string) {
  if (channel !== "stable")
    throw new Error(`Unsupported herdr channel: ${channel}`);
  const manifest = manifestSchema.parse(data);
  if (
    semver.valid(manifest.version) !== manifest.version ||
    semver.prerelease(manifest.version)
  )
    throw new Error("Invalid herdr stable manifest version");
  return manifest.version;
}
