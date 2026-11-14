import { z } from "zod";
import type { ResolutionReport } from "./resolution-report.js";
import type { Profile } from "./schema.js";

const source = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("npm"),
    registry: z.literal("https://registry.npmjs.org"),
    package: z.string(),
  }),
  z.strictObject({
    type: z.literal("github-release"),
    owner: z.literal("astral-sh"),
    repo: z.literal("uv"),
    releaseId: z.number().int().positive(),
    tag: z.string(),
  }),
  z.strictObject({
    type: z.literal("channel-manifest"),
    manifest: z.literal("https://herdr.dev/latest.json"),
    channel: z.literal("stable"),
    version: z.string(),
  }),
]);
const artifact = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("npm"),
    packageName: z.string(),
    packageVersion: z.string(),
    role: z.enum(["top-level", "native"]),
  }),
  z.strictObject({
    type: z.literal("uv"),
    releaseId: z.number().int().positive(),
    assetId: z.number().int().positive(),
    assetName: z.string(),
  }),
  z.strictObject({
    type: z.literal("herdr"),
    assetKey: z.string(),
    assetName: z.string(),
  }),
]);
export const freshLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.string(),
  integrations: z.array(z.string()),
  definitionDigests: z.strictObject({
    algorithm: z.literal("sha256-canonical-json-v1"),
    profile: z.string(),
    components: z.record(z.string(), z.string()),
    integrations: z.record(z.string(), z.string()),
  }),
  node: z.string(),
  targets: z
    .array(
      z.strictObject({
        id: z.string(),
        os: z.enum(["darwin", "win32"]),
        arch: z.enum(["arm64", "x64"]),
        abi: z.literal("native"),
      }),
    )
    .min(1),
  components: z.array(
    z.strictObject({ component: z.string(), version: z.string(), source }),
  ),
  assets: z.array(
    z.strictObject({
      component: z.string(),
      target: z.string(),
      artifact,
      url: z.url(),
      format: z.enum(["npm-tarball", "binary", "zip", "tar.gz"]),
      digest: z.strictObject({
        algorithm: z.enum(["sha256", "sha512-sri"]),
        value: z.string(),
      }),
      digestSource: z.url(),
    }),
  ),
});
export type FreshLock = z.infer<typeof freshLockSchema>;
export function buildFreshLock(
  profile: Profile,
  report: ResolutionReport,
): FreshLock {
  if (
    !report.targets?.length ||
    !report.assets ||
    report.components.some((x) => "error" in x) ||
    report.assets.some((x) => "error" in x)
  )
    throw new Error(
      "Cannot create a lock: incomplete version or asset evidence",
    );
  const targets = report.targets.map((id) => {
    if (!["darwin-arm64", "darwin-x64", "win32-x64"].includes(id))
      throw new Error(`Unsupported lock target: ${id}`);
    const [os, arch] = id.split("-");
    return { id, os, arch, abi: "native" };
  });
  for (const target of report.targets)
    for (const selected of profile.components) {
      const items = report.assets.filter(
        (x) =>
          x.target === target &&
          x.component === selected.component &&
          !("error" in x),
      );
      if (items.length !== (selected.component === "pnpm" ? 2 : 1))
        throw new Error(
          `Incomplete asset evidence for ${selected.component} ${target}`,
        );
    }
  const components = report.components
    .map((x) => {
      if ("error" in x) throw new Error("Incomplete component evidence");
      return { component: x.component, version: x.version, source: x.source };
    })
    .sort((a, b) =>
      a.component < b.component ? -1 : a.component > b.component ? 1 : 0,
    );
  const assets = report.assets
    .map((x) => {
      if ("error" in x) throw new Error("Incomplete asset evidence");
      const common = {
        component: x.component,
        target: x.target,
        url: x.url,
        format: x.format,
        digestSource: x.digestSource,
      };
      if ("integrity" in x)
        return {
          ...common,
          artifact: {
            type: "npm",
            packageName: x.packageName,
            packageVersion: x.packageVersion,
            role: x.role,
          },
          digest: { algorithm: "sha512-sri", value: x.integrity },
        };
      if ("releaseId" in x)
        return {
          ...common,
          artifact: {
            type: "uv",
            releaseId: x.releaseId,
            assetId: x.assetId,
            assetName: x.assetName,
          },
          digest: { algorithm: "sha256", value: x.sha256 },
        };
      return {
        ...common,
        artifact: {
          type: "herdr",
          assetKey: x.assetKey,
          assetName: x.assetName,
        },
        digest: { algorithm: "sha256", value: x.sha256 },
      };
    })
    .sort((a, b) =>
      `${a.target}/${a.component}/${JSON.stringify(a.artifact)}` <
      `${b.target}/${b.component}/${JSON.stringify(b.artifact)}`
        ? -1
        : `${a.target}/${a.component}/${JSON.stringify(a.artifact)}` >
            `${b.target}/${b.component}/${JSON.stringify(b.artifact)}`
          ? 1
          : 0,
    );
  return freshLockSchema.parse({
    schemaVersion: 1,
    profile: profile.id,
    integrations: [...profile.integrations].sort(),
    definitionDigests: report.definitionDigests,
    node: report.node,
    targets,
    components,
    assets,
  });
}
