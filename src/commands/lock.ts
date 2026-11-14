import { join, resolve } from "node:path";
import { Command } from "commander";
import { publishNewLock, requireAbsent } from "../adapters/fresh-lock-file.js";
import { readPackument } from "../adapters/npm-registry.js";
import { profileOption, shared } from "../adapters/options.js";
import {
  chooseProfile,
  createdLock,
  failure,
  progress,
  resolution,
  start,
} from "../adapters/presentation.js";
import { recheckSources } from "../adapters/recheck-sources.js";
import {
  herdrManifest,
  herdrUrl,
  uvReleases,
  uvUrl,
} from "../adapters/releases.js";
import { readRepository } from "../adapters/repository.js";
import { definitionDigests } from "../core/definition-digests.js";
import { buildFreshLock } from "../core/fresh-lock.js";
import { herdrAsset, validTarget } from "../core/herdr-assets.js";
import { npmAsset, pnpmNative } from "../core/npm-assets.js";
import { type Candidate, selectCandidate } from "../core/npm-candidate.js";
import {
  selectHerdr,
  selectUv,
  type UvRelease,
} from "../core/release-candidate.js";
import {
  type AssetItem,
  type ResolutionItem,
  resolutionReportSchema,
} from "../core/resolution-report.js";
import { uvAsset } from "../core/uv-assets.js";
import { validateRepository } from "../core/validate.js";

export function createLockCommand(): Command {
  return shared(
    new Command("lock").description(
      "Preview candidates or create a new shared lock",
    ),
  )
    .addOption(profileOption())
    .option("--dry-run", "Report candidates without writing")
    .option("--out <file>", "Write a new shared candidate lock")
    .option(
      "--target <target>",
      "Preview assets for an execution target (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals() as {
        repo?: string;
        profile?: string;
        json?: boolean;
        dryRun?: boolean;
        out?: string;
        target: string[];
      };
      for (const target of options.target) {
        if (!validTarget(target))
          command.error(`error: invalid target syntax: ${target}`);
      }
      if (new Set(options.target).size !== options.target.length)
        command.error("error: duplicate --target");
      if (options.dryRun && options.out)
        command.error("error: --dry-run and --out cannot be combined");
      if (!options.dryRun && !options.target.length)
        command.error("error: --target is required when creating a lock");
      if (!options.profile && options.json)
        command.error("error: --profile is required in JSON mode");
      try {
        const root = resolve(options.repo ?? ".");
        const inputPath = join(root, "stack", "stack.lock.json");
        const outputPath = options.out ? resolve(options.out) : inputPath;
        if (!options.dryRun) {
          await requireAbsent(inputPath);
          if (outputPath !== inputPath) await requireAbsent(outputPath);
        }
        const repository = await readRepository(root);
        if (!validateRepository(repository).valid)
          throw new Error(
            "Repository definitions are invalid; run validate for details",
          );
        const profileId =
          options.profile ?? (await chooseProfile(repository.profiles));
        if (!profileId) {
          if (process.exitCode === 130) return;
          command.error("error: --profile is required in non-interactive mode");
        }
        const profile = repository.profiles.find(
          (item) => item.id === profileId,
        );
        if (!profile) throw new Error(`Unknown profile: ${profileId}`);
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        process.once("SIGINT", interrupt);
        start(
          options.dryRun
            ? "Agent Stack · version candidate report"
            : "Agent Stack · create shared lock",
          Boolean(options.json),
        );
        const stop = progress(
          "Resolving version candidates",
          Boolean(options.json),
        );
        let components: ResolutionItem[];
        let herdrSnapshot: unknown;
        let uvSnapshot: UvRelease | undefined;
        const npmSnapshots = new Map<string, Candidate>();
        try {
          components = await Promise.all(
            profile.components.map(async (selection) => {
              const component = repository.components.find(
                (item) => item.id === selection.component,
              );
              if (!component)
                return {
                  component: selection.component,
                  error: "Unknown component",
                };
              if (component.source.type === "release") {
                try {
                  if (
                    component.id === "uv" &&
                    component.source.url ===
                      "https://docs.astral.sh/uv/getting-started/installation/" &&
                    "version" in selection
                  ) {
                    const candidate = selectUv(
                      await uvReleases(controller.signal),
                      selection.version,
                    );
                    uvSnapshot = candidate;
                    return {
                      component: component.id,
                      version: candidate.version,
                      requirement: selection.version,
                      metadata: uvUrl,
                      identity: `release ${candidate.id} ${candidate.tag_name}`,
                      evidence: "release" as const,
                      source: {
                        type: "github-release" as const,
                        owner: "astral-sh" as const,
                        repo: "uv" as const,
                        releaseId: candidate.id,
                        tag: candidate.tag_name,
                      },
                    };
                  }
                  if (
                    component.id === "herdr" &&
                    component.source.url ===
                      "https://github.com/herdrdev/herdr/releases" &&
                    "channel" in selection
                  ) {
                    if (selection.channel !== "stable")
                      throw new Error(
                        `Unsupported herdr channel: ${selection.channel}`,
                      );
                    herdrSnapshot = await herdrManifest(controller.signal);
                    const version = selectHerdr(
                      herdrSnapshot,
                      selection.channel,
                    );
                    return {
                      component: component.id,
                      version,
                      requirement: `channel ${selection.channel}`,
                      metadata: herdrUrl,
                      identity: `stable manifest version ${version}`,
                      evidence: "channel" as const,
                      source: {
                        type: "channel-manifest" as const,
                        manifest: herdrUrl,
                        channel: "stable" as const,
                        version,
                      },
                    };
                  }
                  throw new Error("Unsupported release source or selector");
                } catch (error) {
                  return {
                    component: component.id,
                    error:
                      error instanceof Error ? error.message : String(error),
                  };
                }
              }
              if (component.source.type !== "npm")
                return {
                  component: component.id,
                  error: `Unsupported source: ${component.source.type}`,
                };
              if (!("version" in selection))
                return {
                  component: component.id,
                  error: `Unsupported channel: ${selection.channel}`,
                };
              try {
                const data = await readPackument(
                  component.source.package,
                  controller.signal,
                );
                const candidate = selectCandidate(
                  data,
                  component.source.package,
                  selection.version,
                  process.versions.node,
                );
                npmSnapshots.set(component.id, candidate);
                return {
                  component: component.id,
                  package: candidate.name,
                  source: {
                    type: "npm" as const,
                    registry: "https://registry.npmjs.org" as const,
                    package: candidate.name,
                  },
                  version: candidate.version,
                  requirement: selection.version,
                  metadata: `https://registry.npmjs.org/${encodeURIComponent(component.source.package)}`,
                  tarball: candidate.dist.tarball,
                  integrity: candidate.dist.integrity,
                };
              } catch (error) {
                return {
                  component: component.id,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }),
          );
        } finally {
          process.removeListener("SIGINT", interrupt);
          stop(controller.signal.aborted);
        }
        if (controller.signal.aborted) {
          process.exitCode = 130;
          failure("Cancelled.", Boolean(options.json));
          return;
        }
        const targets = [...options.target].sort();
        const assets: AssetItem[] = [];
        process.once("SIGINT", interrupt);
        const nativeCache = new Map<string, Promise<Candidate>>();
        for (const target of targets) {
          const platform = target.split("-")[0];
          for (const selection of profile.components) {
            const component = repository.components.find(
              (item) => item.id === selection.component,
            );
            if (
              !profile.platforms.includes(platform as never) ||
              !component?.platforms.includes(platform as never)
            ) {
              assets.push({
                component: selection.component,
                target,
                error: "Target platform not supported by profile or component",
              });
              continue;
            }
            if (
              selection.component === "pi" ||
              selection.component === "pnpm"
            ) {
              try {
                const top = npmSnapshots.get(selection.component);
                if (!top) throw new Error("npm version metadata unavailable");
                const expected =
                  selection.component === "pnpm"
                    ? "pnpm"
                    : "@earendil-works/pi-coding-agent";
                if (top.name !== expected)
                  throw new Error(
                    "Unsupported npm source for target asset preview",
                  );
                const topAsset = npmAsset(
                  selection.component,
                  target,
                  top,
                  "top-level",
                );
                assets.push(topAsset);
                if (selection.component === "pnpm") {
                  const dependency = pnpmNative(top, target);
                  let pending = nativeCache.get(dependency.name);
                  if (!pending) {
                    pending = readPackument(
                      dependency.name,
                      controller.signal,
                    ).then((data) =>
                      selectCandidate(
                        data,
                        dependency.name,
                        dependency.version,
                        process.versions.node,
                      ),
                    );
                    nativeCache.set(dependency.name, pending);
                  }
                  const native = await pending;
                  if (
                    native.name !== dependency.name ||
                    native.version !== dependency.version
                  )
                    throw new Error("Native package identity mismatch");
                  const nativeAsset = npmAsset(
                    selection.component,
                    target,
                    native,
                    "native",
                  );
                  assets.push(nativeAsset);
                }
              } catch (error) {
                assets.push({
                  component: selection.component,
                  target,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              continue;
            }
            if (selection.component === "uv") {
              try {
                if (!uvSnapshot)
                  throw new Error("uv version metadata unavailable");
                assets.push({
                  component: selection.component,
                  ...uvAsset(uvSnapshot, target),
                });
              } catch (error) {
                assets.push({
                  component: selection.component,
                  target,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              continue;
            }
            if (selection.component !== "herdr") {
              assets.push({
                component: selection.component,
                target,
                error: "Target asset not covered by this preview",
              });
              continue;
            }
            const herdr = components.find((item) => item.component === "herdr");
            if (!herdr || "error" in herdr) {
              assets.push({
                component: selection.component,
                target,
                error: "Herdr version metadata unavailable",
              });
              continue;
            }
            try {
              assets.push({
                component: selection.component,
                ...herdrAsset(herdrSnapshot, herdr.version, target),
              });
            } catch (error) {
              assets.push({
                component: selection.component,
                target,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
        process.removeListener("SIGINT", interrupt);
        if (controller.signal.aborted) {
          process.exitCode = 130;
          failure("Cancelled.", Boolean(options.json));
          return;
        }
        const report = resolutionReportSchema.parse({
          kind: "resolution-report",
          profile: profile.id,
          definitionDigests: definitionDigests(repository, profile),
          node: process.versions.node,
          components,
          ...(targets.length ? { targets, assets } : {}),
          scope: targets.length
            ? "npm, uv and herdr asset metadata only; expected digests are not downloaded-byte verification or signatures; dependency closure, lifecycle scripts, installation, runtime compatibility and complete lock are not checked"
            : "version metadata only; no lock, target assets, digests for releases, dependency closure, installation or runtime verification",
        });
        if (
          options.dryRun ||
          components.some((item) => "error" in item) ||
          assets.some((item) => "error" in item)
        ) {
          resolution(report, Boolean(options.json));
          if (
            components.some((item) => "error" in item) ||
            assets.some((item) => "error" in item)
          )
            process.exitCode = 1;
          return;
        }
        const lock = buildFreshLock(profile, report);
        process.once("SIGINT", interrupt);
        const stopRecheck = progress(
          "Rechecking selected metadata",
          Boolean(options.json),
        );
        try {
          await recheckSources(
            profile,
            report,
            npmSnapshots,
            nativeCache,
            uvSnapshot,
            herdrSnapshot,
            controller.signal,
          );
          const current = await readRepository(root);
          const currentProfile = current.profiles.find(
            (item) => item.id === profile.id,
          );
          if (
            !validateRepository(current).valid ||
            !currentProfile ||
            JSON.stringify(definitionDigests(current, currentProfile)) !==
              JSON.stringify(report.definitionDigests)
          )
            throw new Error("Selected definitions changed during resolution");
          await publishNewLock(
            outputPath,
            inputPath,
            `${JSON.stringify(lock, null, 2)}\n`,
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) {
            process.exitCode = 130;
            failure("Cancelled.", Boolean(options.json));
            return;
          }
          throw error;
        } finally {
          process.removeListener("SIGINT", interrupt);
          stopRecheck(controller.signal.aborted);
        }
        createdLock(outputPath, lock, Boolean(options.json));
      } catch (error) {
        if (error instanceof Error && error.name === "CommanderError")
          throw error;
        failure(
          error instanceof Error ? error.message : String(error),
          Boolean(options.json),
        );
        process.exitCode = 1;
      }
    });
}
