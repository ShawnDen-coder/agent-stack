import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { z } from "zod";

export const resourceFileSchema = z.strictObject({
  source: z.string(),
  target: z.string(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  targetMode: z.number().int().min(0).max(0o777).nullable(),
  targetHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  action: z.enum(["create", "update", "unchanged", "conflict"]),
});
export const piPackageSchema = z.strictObject({
  source: z.string().regex(/^npm:(?:@[^/]+\/)?[^@/]+@\d+\.\d+\.\d+$/),
  skills: z.array(z.never()).length(0),
});
export const piDefaultsSchema = z
  .strictObject({
    skills: z.array(z.string()).length(0),
    defaultProvider: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    subagents: z
      .strictObject({
        agentOverrides: z.record(
          z.string().regex(/^[a-z][a-z-]*$/),
          z.strictObject({
            model: z.string().min(1),
            thinking: z.string().min(1),
          }),
        ),
      })
      .optional(),
    packages: z.array(piPackageSchema).optional(),
  })
  .superRefine((value, ctx) => {
    const ids = (value.packages ?? []).map((item) =>
      item.source.replace(/@\d+\.\d+\.\d+$/, ""),
    );
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: "Duplicate Pi package source",
        path: ["packages"],
      });
  });
export type PiPackage = z.infer<typeof piPackageSchema>;
export function piDefaultLeaves(value: z.infer<typeof piDefaultsSchema>) {
  const result: Record<string, string> = {};
  if (value.defaultProvider !== undefined)
    result.defaultProvider = value.defaultProvider;
  if (value.defaultModel !== undefined)
    result.defaultModel = value.defaultModel;
  for (const [role, fields] of Object.entries(
    value.subagents?.agentOverrides ?? {},
  ))
    for (const [key, item] of Object.entries(fields))
      result[`subagents.agentOverrides.${role}.${key}`] = item;
  return result;
}
export const codingResourcePlanSchema = z.strictObject({
  kind: z.literal("coding-resources-plan"),
  repo: z.string(),
  home: z.string(),
  backupRoot: z.string(),
  profile: z.string(),
  target: z.string(),
  piVersion: z.string(),
  herdrVersion: z.string(),
  environment: z.strictObject({
    pi: z.string().nullable(),
    herdr: z.string().nullable(),
    xdg: z.string().nullable(),
  }),
  receiptMode: z.number().int().min(0).max(0o777).nullable(),
  receiptHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  managedSkills: z.array(z.string()),
  managedPiDefaults: z.record(z.string(), z.string()).default({}),
  managedPackages: z.array(piPackageSchema).default([]),
  managedHerdr: z.record(z.string(), z.boolean()),
  managedExtension: z.boolean(),
  managedMcp: z.boolean().default(false),
  files: z.array(resourceFileSchema),
  blockers: z.array(z.string()),
});
export type CodingResourcePlan = z.infer<typeof codingResourcePlanSchema>;

// Preserve unowned array members. Missing formerly managed entries are drift,
// unless they are no longer needed; identical pre-existing entries remain unowned.
export function mergePiSettings(
  raw: string | null,
  desired: string[],
  previous: string[],
  defaults: Record<string, string> = {},
  previousDefaults: Record<string, string> = {},
  desiredPackages?: PiPackage[],
  previousPackages: PiPackage[] = [],
) {
  const settings = z
    .record(z.string(), z.unknown())
    .parse(raw === null ? {} : JSON.parse(raw));
  const existing = z.array(z.string()).parse(settings.skills ?? []);
  if (new Set(existing).size !== existing.length)
    throw new Error("Duplicate Pi skill entries");
  const previousIntact = previous.every((item) => existing.includes(item));
  const alreadyDesired =
    desired.every((item) => existing.includes(item)) &&
    previous
      .filter((item) => !desired.includes(item))
      .every((item) => !existing.includes(item));
  if (!previousIntact && !alreadyDesired)
    throw new Error("Managed Pi skills changed locally");
  const keep = existing.filter(
    (item) => !previous.includes(item) || desired.includes(item),
  );
  const owned = desired.filter(
    (item) => previous.includes(item) || !existing.includes(item),
  );
  for (const item of desired) if (!keep.includes(item)) keep.push(item);
  const unchanged =
    keep.length === existing.length &&
    keep.every((item, index) => item === existing[index]);
  if (keep.length || settings.skills !== undefined) settings.skills = keep;
  const ownedDefaults: Record<string, string> = { ...previousDefaults };
  let defaultsChanged = false;
  for (const [key, next] of Object.entries(defaults)) {
    const parts = key.split(".");
    let container = settings;
    for (const part of parts.slice(0, -1)) {
      const value = container[part];
      if (value === undefined) container[part] = {};
      else if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value)
      )
        throw new Error(`Pi ${key} conflicts with local content`);
      container = container[part] as Record<string, unknown>;
    }
    const leaf = parts.at(-1);
    if (
      !leaf ||
      ["__proto__", "constructor", "prototype"].some((x) => parts.includes(x))
    )
      throw new Error("Invalid Pi field path");
    const actual = container[leaf],
      old = previousDefaults[key];
    if (actual === next) {
      if (old !== undefined) ownedDefaults[key] = next;
      continue;
    }
    if (old === undefined && actual !== undefined)
      throw new Error(`Pi ${key} conflicts with desired value`);
    if (old !== undefined && actual !== old)
      throw new Error(`Managed Pi ${key} changed locally`);
    container[leaf] = next;
    defaultsChanged = true;
    ownedDefaults[key] = next;
  }
  const packageId = (source: string) => {
    const match = /^npm:((?:@[^/@]+\/)?[^@/]+)(?:@.*)?$/.exec(source);
    return match ? `npm:${match[1]}` : source;
  };
  const currentPackages = z.array(z.unknown()).parse(settings.packages ?? []);
  const ownedPackages: PiPackage[] =
    desiredPackages === undefined ? [...previousPackages] : [];
  let packagesChanged = false;
  for (const old of previousPackages) {
    if (
      desiredPackages === undefined ||
      desiredPackages.some((p) => packageId(p.source) === packageId(old.source))
    )
      continue;
    const index = currentPackages.findIndex((item) =>
      isDeepStrictEqual(item, old),
    );
    if (index < 0)
      throw new Error(
        `Managed Pi package ${packageId(old.source)} changed locally`,
      );
    currentPackages.splice(index, 1);
    packagesChanged = true;
  }
  for (const next of desiredPackages ?? []) {
    const id = packageId(next.source);
    const found = currentPackages
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        const source =
          typeof item === "string"
            ? item
            : item && typeof item === "object" && "source" in item
              ? item.source
              : undefined;
        return typeof source === "string" && packageId(source) === id;
      });
    if (found.length > 1) throw new Error(`Duplicate Pi package ${id}`);
    const actual = found[0]?.item,
      old = previousPackages.find((p) => packageId(p.source) === id);
    if (isDeepStrictEqual(actual, next)) {
      if (old) ownedPackages.push(next);
      continue;
    }
    if (actual !== undefined && !isDeepStrictEqual(actual, old))
      throw new Error(`Pi package ${id} conflicts with local content`);
    if (old && actual === undefined)
      throw new Error(`Managed Pi package ${id} changed locally`);
    if (found[0]) currentPackages[found[0].index] = next;
    else currentPackages.push(next);
    ownedPackages.push(next);
    packagesChanged = true;
  }
  if (packagesChanged) settings.packages = currentPackages;
  return {
    text:
      unchanged && !defaultsChanged && !packagesChanged && raw !== null
        ? raw
        : `${JSON.stringify(settings, null, 2)}\n`,
    owned,
    ownedDefaults,
    ownedPackages,
  };
}

export function mergePiMcp(
  raw: string | null,
  desiredUrl: string,
  previousUrl: string | null,
) {
  const config = z
    .record(z.string(), z.unknown())
    .parse(raw === null ? {} : JSON.parse(raw));
  const servers = z
    .record(z.string(), z.unknown())
    .parse(config.mcpServers ?? {});
  const actual = servers.reui;
  const desired = { url: desiredUrl };
  if (isDeepStrictEqual(actual, desired))
    return {
      text:
        raw ??
        `${JSON.stringify({ ...config, mcpServers: { ...servers, reui: desired } }, null, 2)}\n`,
      owned: previousUrl !== null,
    };
  if (previousUrl === null && actual !== undefined)
    throw new Error("Pi MCP reui conflicts with local content");
  if (previousUrl !== null && !isDeepStrictEqual(actual, { url: previousUrl }))
    throw new Error("Managed Pi MCP reui changed locally");
  servers.reui = desired;
  config.mcpServers = servers;
  return { text: `${JSON.stringify(config, null, 2)}\n`, owned: true };
}

// Only insert missing supported keys in an unambiguous [update] table. Existing
// values are not overwritten unless they match the previous managed value.
export function mergeHerdrConfig(
  raw: string | null,
  previous: Record<string, boolean>,
  desired: Record<"version_check" | "manifest_check", boolean> = {
    version_check: false,
    manifest_check: false,
  },
) {
  const source = raw ?? "";
  const value = parse(source);
  const update = value.update;
  if (
    update !== undefined &&
    (typeof update !== "object" || update === null || Array.isArray(update))
  )
    throw new Error("Herdr update is not a table");
  const table = (update ?? {}) as Record<string, unknown>;
  const keys = ["version_check", "manifest_check"] as const;
  const owned: Record<string, boolean> = {};
  const changes: Array<{
    key: (typeof keys)[number];
    old: boolean | undefined;
    next: boolean;
  }> = [];
  for (const key of keys) {
    const actual = table[key],
      next = desired[key],
      old = previous[key];
    if (actual === next) {
      if (old !== undefined) owned[key] = next;
      continue;
    }
    if (old === undefined && actual !== undefined)
      throw new Error(`Herdr update.${key} conflicts with desired value`);
    if (old !== undefined && actual !== old)
      throw new Error(`Managed Herdr update.${key} changed locally`);
    if (actual !== undefined && typeof actual !== "boolean")
      throw new Error(`Invalid Herdr update.${key}`);
    changes.push({ key, old: actual as boolean | undefined, next });
    owned[key] = next;
  }
  if (!changes.length) return { text: source, owned };
  const headers = [
    ...source.matchAll(/^[ \t]*\[[ \t]*update[ \t]*\][ \t]*(?:#.*)?$/gm),
  ];
  if (headers.length > 1 || (update !== undefined && headers.length === 0))
    throw new Error("Cannot safely edit Herdr update table");
  let text = source;
  if (!headers.length) {
    text = `${source}${source && !source.endsWith("\n") ? "\n" : ""}\n[update]\n${changes.map(({ key, next }) => `${key} = ${next}\n`).join("")}`;
  } else {
    const header = headers[0];
    if (!header || header.index === undefined)
      throw new Error("Invalid Herdr table");
    const start = header.index + header[0].length;
    const tail = source.slice(start).replace(/^\r?\n/, "");
    const nextHeader = /^[ \t]*\[/m.exec(tail);
    let section =
      nextHeader?.index === undefined ? tail : tail.slice(0, nextHeader.index);
    const remainder =
      nextHeader?.index === undefined ? "" : tail.slice(nextHeader.index);
    for (const change of changes) {
      if (change.old === undefined)
        section = `${change.key} = ${change.next}\n${section}`;
      else {
        const pattern = new RegExp(
          `^([ \t]*${change.key}[ \t]*=[ \t]*)${change.old}([ \t]*(?:#.*)?)$`,
          "gm",
        );
        const matches = [...section.matchAll(pattern)];
        if (matches.length !== 1)
          throw new Error("Cannot safely edit Herdr update table");
        section = section.replace(pattern, `$1${change.next}$2`);
      }
    }
    text = `${source.slice(0, start)}\n${section}${remainder}`;
  }
  const result = parse(text);
  const expected = structuredClone(value) as Record<string, unknown>;
  const expectedUpdate = (expected.update ?? {}) as Record<string, unknown>;
  for (const key of keys) expectedUpdate[key] = desired[key];
  expected.update = expectedUpdate;
  if (
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(result)),
      JSON.parse(JSON.stringify(expected)),
    )
  )
    throw new Error("Cannot safely edit Herdr update table");
  return { text, owned };
}
