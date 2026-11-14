import semver from "semver";
import { z } from "zod";

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  deprecated: z.string().optional(),
  engines: z.object({ node: z.string().optional() }).optional(),
  dist: z.object({ tarball: z.string(), integrity: z.string() }),
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
    const manifest = manifestSchema.parse(value);
    if (
      !semver.valid(key) ||
      manifest.version !== key ||
      manifest.name !== name
    )
      throw new Error(`Contradictory package metadata for ${key}`);
    return manifest;
  });
  const selected = versions
    .filter((v) => !v.deprecated && semver.satisfies(v.version, range))
    .sort((a, b) => semver.rcompare(a.version, b.version))[0];
  if (!selected) throw new Error(`No non-deprecated version matches ${range}`);
  if (
    selected.engines?.node &&
    (!semver.validRange(selected.engines.node) ||
      !semver.satisfies(node, selected.engines.node))
  )
    throw new Error(
      `Node ${node} does not satisfy engines ${selected.engines.node}`,
    );
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
