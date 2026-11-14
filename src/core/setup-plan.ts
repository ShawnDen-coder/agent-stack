import { z } from "zod";

const observation = z.object({
  name: z.string(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  failure: z.string().nullable(),
  evidence: z.string().nullable(),
  requirement: z.string().nullable(),
  status: z.string(),
  source: z.string(),
});
export const setupPlanSchema = z.object({
  kind: z.literal("setup-plan"),
  repo: z.object({ path: z.string(), selectedBy: z.string() }),
  profile: z.object({ id: z.string(), selectedBy: z.string() }),
  lock: z.object({
    path: z.string(),
    selectedBy: z.string(),
    node: z.string(),
  }),
  host: z.object({
    platform: z.string(),
    processArch: z.string(),
    machine: z.string(),
    target: z.string(),
    native: z.boolean(),
  }),
  prerequisites: z.array(observation),
  components: z.array(
    z.object({
      component: z.string(),
      lockedVersion: z.string(),
      observation,
      ownership: z.literal("unknown"),
      action: z.string(),
    }),
  ),
  integrations: z.array(z.string()),
  resources: z.array(z.string()),
  blockers: z.array(z.string()),
  scope: z.string(),
});
export type SetupPlan = z.infer<typeof setupPlanSchema>;
