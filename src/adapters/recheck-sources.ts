import { z } from "zod";
import { herdrAsset } from "../core/herdr-assets.js";
import { npmAsset, pnpmNative } from "../core/npm-assets.js";
import { type Candidate, selectCandidate } from "../core/npm-candidate.js";
import {
  selectHerdr,
  selectUv,
  type UvRelease,
} from "../core/release-candidate.js";
import type { ResolutionReport } from "../core/resolution-report.js";
import type { Profile } from "../core/schema.js";
import { uvAsset } from "../core/uv-assets.js";
import { readPackument } from "./npm-registry.js";
import { herdrManifest, uvReleases } from "./releases.js";

const packument = z.object({
  name: z.string(),
  versions: z.record(z.string(), z.unknown()),
});
async function exactNpm(
  name: string,
  version: string,
  signal: AbortSignal,
): Promise<Candidate> {
  const data = packument.parse(await readPackument(name, signal));
  if (!(version in data.versions))
    throw new Error(`Selected npm version disappeared: ${name}@${version}`);
  return selectCandidate(
    { name: data.name, versions: { [version]: data.versions[version] } },
    name,
    version,
    process.versions.node,
  );
}
function same(a: unknown, b: unknown, message: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(message);
}
function selectionFields(value: Candidate) {
  return {
    name: value.name,
    version: value.version,
    deprecated: value.deprecated,
    engines: value.engines,
    os: value.os,
    cpu: value.cpu,
    libc: value.libc,
  };
}
export async function recheckSources(
  profile: Profile,
  report: ResolutionReport,
  npmSnapshots: Map<string, Candidate>,
  nativeCache: Map<string, Promise<Candidate>>,
  uvSnapshot: UvRelease | undefined,
  herdrSnapshot: unknown,
  signal: AbortSignal,
) {
  const targets = report.targets ?? [];
  for (const selection of profile.components) {
    const item = report.components.find(
      (x) => x.component === selection.component,
    );
    if (!item || "error" in item)
      throw new Error(`Missing selected version: ${selection.component}`);
    if ("package" in item) {
      const first = npmSnapshots.get(selection.component);
      if (!first) throw new Error("Missing npm snapshot");
      const now = await exactNpm(item.package, item.version, signal);
      same(
        selectionFields(first),
        selectionFields(now),
        `Selected npm metadata changed: ${item.package}`,
      );
      for (const target of targets) {
        same(
          npmAsset(selection.component, target, first, "top-level"),
          npmAsset(selection.component, target, now, "top-level"),
          `Selected npm asset changed: ${item.package}`,
        );
        if (selection.component === "pnpm") {
          const oldDep = pnpmNative(first, target),
            newDep = pnpmNative(now, target);
          same(oldDep, newDep, "Selected pnpm native dependency changed");
          const previous = await nativeCache.get(oldDep.name);
          if (!previous) throw new Error("Missing native snapshot");
          const current = await exactNpm(newDep.name, newDep.version, signal);
          same(
            selectionFields(previous),
            selectionFields(current),
            `Selected native metadata changed: ${newDep.name}`,
          );
          same(
            npmAsset(selection.component, target, previous, "native"),
            npmAsset(selection.component, target, current, "native"),
            `Selected native asset changed: ${newDep.name}`,
          );
        }
      }
    } else if (item.source.type === "github-release") {
      if (!uvSnapshot) throw new Error("Missing uv snapshot");
      const releases = await uvReleases(signal);
      const selected = releases.filter(
        (x) =>
          typeof x === "object" &&
          x !== null &&
          "tag_name" in x &&
          x.tag_name === uvSnapshot.tag_name,
      );
      const current = selectUv(selected, `=${uvSnapshot.tag_name}`);
      if (
        current.id !== uvSnapshot.id ||
        current.tag_name !== uvSnapshot.tag_name
      )
        throw new Error("Selected uv release identity changed");
      for (const target of targets)
        same(
          uvAsset(uvSnapshot, target),
          uvAsset(current, target),
          `Selected uv asset changed: ${target}`,
        );
    } else {
      const current = await herdrManifest(signal);
      const oldVersion = selectHerdr(herdrSnapshot, "stable"),
        newVersion = selectHerdr(current, "stable");
      if (oldVersion !== newVersion || oldVersion !== item.version)
        throw new Error("Selected herdr stable version changed");
      for (const target of targets)
        same(
          herdrAsset(herdrSnapshot, oldVersion, target),
          herdrAsset(current, newVersion, target),
          `Selected herdr asset changed: ${target}`,
        );
    }
  }
}
