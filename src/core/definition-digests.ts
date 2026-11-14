import { createHash } from "node:crypto";
import type { Profile, Repository } from "./schema.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Unsupported declaration value");
  return result;
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}
export function definitionDigests(repository: Repository, profile: Profile) {
  const components: Record<string, string> = {};
  const integrations: Record<string, string> = {};
  for (const id of profile.components.map((item) => item.component).sort()) {
    const value = repository.components.find((item) => item.id === id);
    if (!value) throw new Error(`Unknown component: ${id}`);
    components[id] = digest(value);
  }
  for (const id of [...profile.integrations].sort()) {
    const value = repository.integrations.find((item) => item.id === id);
    if (!value) throw new Error(`Unknown integration: ${id}`);
    integrations[id] = digest(value);
  }
  return {
    algorithm: "sha256-canonical-json-v1" as const,
    profile: digest(profile),
    components,
    integrations,
  };
}
