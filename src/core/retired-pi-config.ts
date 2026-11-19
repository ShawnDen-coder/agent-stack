import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

// These keys were introduced by the previous Pi import. A receipt from
// another destination never grants ownership (checked in previousOwnership).
export const importedPackageSchema = z.strictObject({
  source: z.string().regex(/^npm:(?:@[^/]+\/)?[^@/]+@\d+\.\d+\.\d+$/),
  skills: z.array(z.never()).length(0),
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function retirePiPreferences(
  raw: string | null,
  fields: Record<string, string>,
  packages: z.infer<typeof importedPackageSchema>[],
): string | null {
  if (!raw || (!Object.keys(fields).length && !packages.length)) return raw;
  const settings: unknown = JSON.parse(raw);
  if (!record(settings)) throw Error("Invalid Pi settings");
  let changed = false;
  for (const [path, expected] of Object.entries(fields)) {
    let parent = settings;
    let key = path;
    if (key !== "defaultModel" && key !== "defaultProvider") {
      const match =
        /^subagents\.agentOverrides\.([a-z][a-z-]*)\.(model|thinking)$/.exec(
          path,
        );
      const agents = settings.subagents;
      if (
        !match?.[1] ||
        !match[2] ||
        !record(agents) ||
        !record(agents.agentOverrides)
      )
        continue;
      const roles = agents.agentOverrides;
      if (!Object.hasOwn(roles, match[1])) continue;
      const role = roles[match[1]];
      if (!record(role)) continue;
      parent = role;
      key = match[2];
    }
    if (Object.hasOwn(parent, key) && parent[key] === expected) {
      delete parent[key];
      changed = true;
    }
  }
  if (Array.isArray(settings.packages) && packages.length) {
    const remaining = [...settings.packages];
    for (const item of packages) {
      const i = remaining.findIndex((candidate) =>
        isDeepStrictEqual(candidate, item),
      );
      if (i >= 0) {
        remaining.splice(i, 1);
        changed = true;
      }
    }
    settings.packages = remaining;
  }
  return changed ? JSON.stringify(settings, null, 2) + "\n" : raw;
}

// A changed entry, including an additional user-supplied key, stays local.
export function retireReui(
  raw: string | null,
  ownedUrl: string | null,
): string | null {
  if (raw === null || ownedUrl === null) return raw;
  const config: unknown = JSON.parse(raw);
  if (
    !record(config) ||
    !record(config.mcpServers) ||
    !isDeepStrictEqual(config.mcpServers.reui, { url: ownedUrl })
  )
    return raw;
  delete config.mcpServers.reui;
  return JSON.stringify(config, null, 2) + "\n";
}
