import { z } from "zod";

const itemSchema = z.union([
  z.object({ component: z.string(), error: z.string() }),
  z.object({
    component: z.string(),
    version: z.string(),
    requirement: z.string(),
    metadata: z.string(),
    identity: z.string(),
    evidence: z.enum(["release", "channel"]),
  }),
  z.object({
    component: z.string(),
    package: z.string(),
    version: z.string(),
    requirement: z.string(),
    metadata: z.string(),
    tarball: z.string(),
    integrity: z.string(),
  }),
]);
const assetSchema = z.union([
  z.object({ component: z.string(), target: z.string(), error: z.string() }),
  z.object({
    component: z.string(),
    target: z.string(),
    identity: z.string(),
    url: z.string(),
    sha256: z.string(),
    digestSource: z.string(),
    format: z.enum(["zip", "binary"]),
  }),
]);
export type AssetItem = z.infer<typeof assetSchema>;
export const resolutionReportSchema = z.object({
  kind: z.literal("resolution-report"),
  profile: z.string(),
  node: z.string(),
  components: z.array(itemSchema),
  scope: z.string(),
  targets: z.array(z.string()).optional(),
  assets: z.array(assetSchema).optional(),
});
export type ResolutionItem = z.infer<typeof itemSchema>;
export type ResolutionReport = z.infer<typeof resolutionReportSchema>;
