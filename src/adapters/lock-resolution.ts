import { herdrAsset } from "../core/herdr-assets.js";
import { npmAsset, pnpmNative } from "../core/npm-assets.js";
import { type Candidate, selectCandidate } from "../core/npm-candidate.js";
import {
  selectHerdr,
  selectUv,
  type UvRelease,
} from "../core/release-candidate.js";
import type { AssetItem, ResolutionItem } from "../core/resolution-report.js";
import type { Profile, Repository } from "../core/schema.js";
import { uvAsset } from "../core/uv-assets.js";
import { readPackument } from "./npm-registry.js";
import { herdrManifest, herdrUrl, uvReleases, uvUrl } from "./releases.js";

type VersionResult = {
  item: ResolutionItem;
  npm?: Candidate;
  uv?: UvRelease;
  herdr?: unknown;
};
async function resolveComponent(
  repository: Repository,
  selection: Profile["components"][number],
  signal: AbortSignal,
): Promise<VersionResult> {
  const component = repository.components.find(
    (item) => item.id === selection.component,
  );
  if (!component)
    return {
      item: { component: selection.component, error: "Unknown component" },
    };
  try {
    if (component.source.type === "release") {
      if (
        component.id === "uv" &&
        component.source.url ===
          "https://docs.astral.sh/uv/getting-started/installation/" &&
        "version" in selection
      ) {
        const candidate = selectUv(await uvReleases(signal), selection.version);
        return {
          uv: candidate,
          item: {
            component: component.id,
            version: candidate.version,
            requirement: selection.version,
            metadata: uvUrl,
            identity: `release ${candidate.id} ${candidate.tag_name}`,
            evidence: "release",
            source: {
              type: "github-release",
              owner: "astral-sh",
              repo: "uv",
              releaseId: candidate.id,
              tag: candidate.tag_name,
            },
          },
        };
      }
      if (
        component.id === "herdr" &&
        component.source.url === "https://github.com/herdrdev/herdr/releases" &&
        "channel" in selection
      ) {
        if (selection.channel !== "stable")
          throw new Error(`Unsupported herdr channel: ${selection.channel}`);
        const herdr = await herdrManifest(signal);
        const version = selectHerdr(herdr, selection.channel);
        return {
          herdr,
          item: {
            component: component.id,
            version,
            requirement: `channel ${selection.channel}`,
            metadata: herdrUrl,
            identity: `stable manifest version ${version}`,
            evidence: "channel",
            source: {
              type: "channel-manifest",
              manifest: herdrUrl,
              channel: "stable",
              version,
            },
          },
        };
      }
      throw new Error("Unsupported release source or selector");
    }
    if (component.source.type !== "npm")
      throw new Error(`Unsupported source: ${component.source.type}`);
    if (!("version" in selection))
      throw new Error(`Unsupported channel: ${selection.channel}`);
    const data = await readPackument(component.source.package, signal);
    const candidate = selectCandidate(
      data,
      component.source.package,
      selection.version,
      process.versions.node,
    );
    return {
      npm: candidate,
      item: {
        component: component.id,
        package: candidate.name,
        source: {
          type: "npm",
          registry: "https://registry.npmjs.org",
          package: candidate.name,
        },
        version: candidate.version,
        requirement: selection.version,
        metadata: `https://registry.npmjs.org/${encodeURIComponent(component.source.package)}`,
        tarball: candidate.dist.tarball,
        integrity: candidate.dist.integrity,
      },
    };
  } catch (error) {
    return {
      item: {
        component: component.id,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
export async function resolveVersions(
  repository: Repository,
  profile: Profile,
  signal: AbortSignal,
) {
  const results = await Promise.all(
    profile.components.map((selection) =>
      resolveComponent(repository, selection, signal),
    ),
  );
  const snapshots = {
    npmSnapshots: new Map<string, Candidate>(),
    nativeCache: new Map<string, Promise<Candidate>>(),
    uvSnapshot: undefined as UvRelease | undefined,
    herdrSnapshot: undefined as unknown,
  };
  for (const result of results) {
    if (result.npm)
      snapshots.npmSnapshots.set(result.item.component, result.npm);
    if (result.uv) snapshots.uvSnapshot = result.uv;
    if (result.herdr !== undefined) snapshots.herdrSnapshot = result.herdr;
  }
  return { components: results.map((result) => result.item), snapshots };
}
export type ResolutionSnapshots = Awaited<
  ReturnType<typeof resolveVersions>
>["snapshots"];
export async function resolveAssets(
  repository: Repository,
  profile: Profile,
  targets: string[],
  versions: Awaited<ReturnType<typeof resolveVersions>>,
  signal: AbortSignal,
) {
  const { components, snapshots } = versions;
  async function collect(
    selection: Profile["components"][number],
    target: string,
  ): Promise<AssetItem[]> {
    const items: AssetItem[] = [];
    try {
      const component = repository.components.find(
        (item) => item.id === selection.component,
      );
      const platform = target.split("-")[0];
      if (
        !profile.platforms.includes(platform as never) ||
        !component?.platforms.includes(platform as never)
      )
        throw new Error(
          "Target platform not supported by profile or component",
        );
      if (selection.component === "pi" || selection.component === "pnpm") {
        const top = snapshots.npmSnapshots.get(selection.component);
        if (!top) throw new Error("npm version metadata unavailable");
        const expected =
          selection.component === "pnpm"
            ? "pnpm"
            : "@earendil-works/pi-coding-agent";
        if (top.name !== expected)
          throw new Error("Unsupported npm source for target asset preview");
        items.push(npmAsset(selection.component, target, top, "top-level"));
        if (selection.component === "pnpm") {
          const dependency = pnpmNative(top, target);
          let pending = snapshots.nativeCache.get(dependency.name);
          if (!pending) {
            pending = readPackument(dependency.name, signal).then((data) =>
              selectCandidate(
                data,
                dependency.name,
                dependency.version,
                process.versions.node,
              ),
            );
            snapshots.nativeCache.set(dependency.name, pending);
          }
          const native = await pending;
          if (
            native.name !== dependency.name ||
            native.version !== dependency.version
          )
            throw new Error("Native package identity mismatch");
          items.push(npmAsset(selection.component, target, native, "native"));
        }
      } else if (selection.component === "uv") {
        if (!snapshots.uvSnapshot)
          throw new Error("uv version metadata unavailable");
        items.push({
          component: selection.component,
          ...uvAsset(snapshots.uvSnapshot, target),
        });
      } else if (selection.component === "herdr") {
        const herdr = components.find((item) => item.component === "herdr");
        if (!herdr || "error" in herdr)
          throw new Error("Herdr version metadata unavailable");
        items.push({
          component: selection.component,
          ...herdrAsset(snapshots.herdrSnapshot, herdr.version, target),
        });
      } else {
        throw new Error("Target asset not covered by this preview");
      }
    } catch (error) {
      items.push({
        component: selection.component,
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return items;
  }
  const assets: AssetItem[] = [];
  for (const target of targets)
    for (const selection of profile.components)
      assets.push(...(await collect(selection, target)));
  return assets;
}
