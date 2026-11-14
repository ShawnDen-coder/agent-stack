import { z } from "zod";
import {
  channelSourceShape,
  definitionDigestsShape,
  npmSourceShape,
  releaseSourceShape,
} from "./source-shapes.js";

const itemSchema = z.union([
  z.object({ component: z.string(), error: z.string() }),
  z.object({
    component: z.string(),
    version: z.string(),
    requirement: z.string(),
    metadata: z.string(),
    identity: z.string(),
    evidence: z.enum(["release", "channel"]),
    source: z.union([
      z.object(releaseSourceShape),
      z.object(channelSourceShape),
    ]),
  }),
  z.object({
    component: z.string(),
    package: z.string(),
    source: z.object(npmSourceShape),
    version: z.string(),
    requirement: z.string(),
    metadata: z.string(),
    tarball: z.string(),
    integrity: z.string(),
  }),
]);
const assetSchema = z.union([
  z.object({
    component: z.string(),
    target: z.string(),
    identity: z.string(),
    url: z.string(),
    integrity: z.string(),
    digestSource: z.string(),
    format: z.literal("npm-tarball"),
    role: z.enum(["top-level", "native"]),
    packageName: z.string(),
    packageVersion: z.string(),
  }),
  z.object({ component: z.string(), target: z.string(), error: z.string() }),
  z.object({
    component: z.string(),
    target: z.string(),
    identity: z.string(),
    url: z.string(),
    sha256: z.string(),
    digestSource: z.string(),
    format: z.enum(["zip", "binary"]),
    assetKey: z.string(),
    assetName: z.string(),
  }),
  z.object({
    component: z.string(),
    target: z.string(),
    identity: z.string(),
    url: z.string(),
    sha256: z.string(),
    digestSource: z.string(),
    format: z.enum(["zip", "tar.gz"]),
    releaseId: z.number().int().positive(),
    assetId: z.number().int().positive(),
    assetName: z.string(),
  }),
]);
export type AssetItem = z.infer<typeof assetSchema>;
export const resolutionReportSchema = z.object({
  kind: z.literal("resolution-report"),
  profile: z.string(),
  node: z.string(),
  components: z.array(itemSchema),
  scope: z.string(),
  definitionDigests: z.object(definitionDigestsShape),
  targets: z.array(z.string()).optional(),
  assets: z.array(assetSchema).optional(),
});
export type ResolutionItem = z.infer<typeof itemSchema>;
export type ResolutionReport = z.infer<typeof resolutionReportSchema>;
