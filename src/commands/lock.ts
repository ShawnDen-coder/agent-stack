import { join, resolve } from "node:path";
import { Command } from "commander";
import { publishNewLock, requireAbsent } from "../adapters/fresh-lock-file.js";
import { resolveAssets, resolveVersions } from "../adapters/lock-resolution.js";
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
import { readRepository } from "../adapters/repository.js";
import { definitionDigests } from "../core/definition-digests.js";
import { buildFreshLock } from "../core/fresh-lock.js";
import { validTarget } from "../core/herdr-assets.js";
import { resolutionReportSchema } from "../core/resolution-report.js";
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
      if (options.out !== undefined && !options.out.trim())
        command.error("error: --out must not be empty or whitespace");
      if (options.dryRun && options.out !== undefined)
        command.error("error: --dry-run and --out cannot be combined");
      if (!options.dryRun && !options.target.length)
        command.error("error: --target is required when creating a lock");
      if (!options.profile && options.json)
        command.error("error: --profile is required in JSON mode");
      try {
        const root = resolve(options.repo ?? ".");
        const inputPath = join(root, "stack", "stack.lock.json");
        const outputPath =
          options.out !== undefined ? resolve(options.out) : inputPath;
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
        let published = false;
        process.once("SIGINT", interrupt);
        try {
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
          let result: Awaited<ReturnType<typeof resolveVersions>>;
          try {
            result = await resolveVersions(
              repository,
              profile,
              controller.signal,
            );
          } finally {
            stop(controller.signal.aborted);
          }
          if (controller.signal.aborted) throw new Error("Cancelled");
          const targets = [...options.target].sort();
          const assets = await resolveAssets(
            repository,
            profile,
            targets,
            result,
            controller.signal,
          );
          if (controller.signal.aborted) throw new Error("Cancelled");
          const report = resolutionReportSchema.parse({
            kind: "resolution-report",
            profile: profile.id,
            definitionDigests: definitionDigests(repository, profile),
            node: process.versions.node,
            components: result.components,
            ...(targets.length ? { targets, assets } : {}),
            scope: targets.length
              ? "npm, uv and herdr asset metadata only; expected digests are not downloaded-byte verification or signatures; dependency closure, lifecycle scripts, installation, runtime compatibility and complete lock are not checked"
              : "version metadata only; no lock, target assets, digests for releases, dependency closure, installation or runtime verification",
          });
          if (
            options.dryRun ||
            result.components.some((item) => "error" in item) ||
            assets.some((item) => "error" in item)
          ) {
            resolution(report, Boolean(options.json));
            if (
              result.components.some((item) => "error" in item) ||
              assets.some((item) => "error" in item)
            )
              process.exitCode = 1;
            return;
          }
          const lock = buildFreshLock(profile, report);
          const stopRecheck = progress(
            "Rechecking selected metadata",
            Boolean(options.json),
          );
          try {
            await recheckSources(
              profile,
              report,
              result.snapshots,
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
            published = true;
          } finally {
            stopRecheck(controller.signal.aborted && !published);
          }
          createdLock(outputPath, lock, Boolean(options.json));
        } catch (error) {
          if (controller.signal.aborted && !published) {
            process.exitCode = 130;
            failure("Cancelled.", Boolean(options.json));
            return;
          }
          throw error;
        } finally {
          process.removeListener("SIGINT", interrupt);
        }
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
