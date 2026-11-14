import semver from "semver";
import { z } from "zod";

const selectionSchema = z.object({
  name: z.string(),
  version: z.string(),
  deprecated: z.string().optional(),
  engines: z.object({ node: z.string().optional() }).optional(),
});
const manifestSchema = selectionSchema.extend({
  dist: z.object({ tarball: z.string(), integrity: z.string() }),
  os: z.unknown().optional(),
  cpu: z.unknown().optional(),
  libc: z.unknown().optional(),
  optionalDependencies: z.unknown().optional(),
});
const packumentSchema = z.object({
  name: z.string(),
  versions: z.record(z.string(), z.unknown()),
});
export type Candidate = z.infer<typeof manifestSchema>;

export function selectCandidate(
  data: unknown,
  name: string,
  range: string,
  node: string,
): Candidate {
  if (!semver.validRange(range))
    throw new Error(`Invalid semver range: ${range}`);
  const metadata = packumentSchema.parse(data);
  if (metadata.name !== name)
    throw new Error(`Package name mismatch: expected ${name}`);
  const versions = Object.entries(metadata.versions).map(([key, value]) => {
    const manifest = selectionSchema.parse(value);
    if (
      !semver.valid(key) ||
      manifest.version !== key ||
      manifest.name !== name
    )
      throw new Error(`Contradictory package metadata for ${key}`);
    return { manifest, value };
  });
  const matching = versions.filter(
    ({ manifest }) =>
      !manifest.deprecated && semver.satisfies(manifest.version, range),
  );
  if (!matching.length)
    throw new Error(`No non-deprecated version matches ${range}`);
  for (const { manifest } of matching) {
    if (manifest.engines?.node && !semver.validRange(manifest.engines.node))
      throw new Error(`Invalid Node engines range: ${manifest.engines.node}`);
  }
  const compatible = matching.filter(
    ({ manifest }) =>
      !manifest.engines?.node || semver.satisfies(node, manifest.engines.node),
  );
  const best = compatible.sort((a, b) =>
    semver.rcompare(a.manifest.version, b.manifest.version),
  )[0];
  if (!best)
    throw new Error(
      `Node ${node} does not satisfy engines for any matching version`,
    );
  const selected = manifestSchema.parse(best.value);
  const url = new URL(selected.dist.tarball);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "registry.npmjs.org" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Invalid tarball URL: expected official npm HTTPS registry",
    );
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(selected.dist.integrity);
  if (
    !match?.[1] ||
    Buffer.from(match[1], "base64").length !== 64 ||
    Buffer.from(match[1], "base64").toString("base64") !== match[1]
  )
    throw new Error("Missing or invalid SHA512 integrity");
  return selected;
}
