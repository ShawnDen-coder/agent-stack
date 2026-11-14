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
export const resolutionReportSchema = z.object({
  kind: z.literal("resolution-report"),
  profile: z.string(),
  node: z.string(),
  components: z.array(itemSchema),
  scope: z.string(),
});
export type ResolutionItem = z.infer<typeof itemSchema>;
export type ResolutionReport = z.infer<typeof resolutionReportSchema>;
