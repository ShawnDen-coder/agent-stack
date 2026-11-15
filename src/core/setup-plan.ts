import { z } from "zod";

const observation = z.object({
  name: z.string(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  failure: z
    .enum([
      "not_found",
      "unverified_entrypoint",
      "cancelled",
      "unparseable_version",
      "nonzero_exit",
      "timeout",
      "output_limit",
      "execution_error",
      "platform_not_applicable",
      "not_checked",
    ])
    .nullable(),
  evidence: z
    .enum(["running_process", "version_command", "package_metadata"])
    .nullable(),
  requirement: z.string().nullable(),
  status: z.enum([
    "ok",
    "version_mismatch",
    "unparseable_requirement",
    "not_found",
    "unverified_entrypoint",
    "cancelled",
    "unparseable_version",
    "nonzero_exit",
    "timeout",
    "output_limit",
    "execution_error",
    "platform_not_applicable",
    "not_checked",
  ]),
  source: z.literal("unknown"),
});
export const setupPlanSchema = z.object({
  kind: z.literal("setup-plan"),
  repo: z.object({
    path: z.string(),
    selectedBy: z.enum(["option", "environment", "binding", "cwd"]),
  }),
  profile: z.object({
    id: z.string(),
    selectedBy: z.enum(["option", "environment", "binding", "interactive"]),
  }),
  lock: z.object({
    path: z.string(),
    selectedBy: z.enum(["default", "option", "binding"]),
    node: z.string(),
  }),
  host: z.object({
    platform: z.string(),
    processArch: z.string(),
    machine: z.string(),
    target: z.string(),
    native: z.boolean(),
    evidence: z.enum([
      "native-arm64-process",
      "same-architecture-sysctl",
      "rosetta",
      "probe-unknown",
      "IsWow64Process2",
      "emulated-or-unsupported",
      "unsupported-or-unknown",
    ]),
  }),
  prerequisites: z.array(observation),
  components: z.array(
    z.object({
      component: z.string(),
      lockedVersion: z.string(),
      observation,
      ownership: z.enum(["unknown", "managed"]),
      lockedAsset: z
        .object({
          target: z.string(),
          name: z.string(),
          url: z.url(),
          format: z.enum(["tar.gz", "zip"]),
          sha256: z.string(),
          digestSource: z.url(),
        })
        .optional(),
      action: z.enum([
        "installation needed",
        "verify reuse; ownership unknown",
        "investigate entry or version conflict",
      ]),
    }),
  ),
  uvInstallation: z
    .object({
      mode: z.enum(["install", "reuse", "managed"]),
      bin: z.string().nullable(),
      uvx: observation,
      recovery: z.boolean(),
    })
    .optional(),
  integrations: z.array(z.string()),
  resources: z.array(z.string()),
  blockers: z.array(z.string()),
  scope: z.string(),
});
export type SetupPlan = z.infer<typeof setupPlanSchema>;

export function componentAction(
  status: string,
): SetupPlan["components"][number]["action"] {
  if (status === "not_found") return "installation needed";
  return status === "ok"
    ? "verify reuse; ownership unknown"
    : "investigate entry or version conflict";
}
