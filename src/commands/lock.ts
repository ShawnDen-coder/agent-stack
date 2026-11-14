import { resolve } from "node:path";
import { Command } from "commander";
import { readPackument } from "../adapters/npm-registry.js";
import { profileOption, shared } from "../adapters/options.js";
import {
  chooseProfile,
  failure,
  finish,
  progress,
  start,
} from "../adapters/presentation.js";
import { readRepository } from "../adapters/repository.js";
import { selectCandidate } from "../core/npm-candidate.js";
import { validateRepository } from "../core/validate.js";

export function createLockCommand(): Command {
  return shared(
    new Command("lock").description(
      "Report npm version candidates without writing a lock",
    ),
  )
    .addOption(profileOption())
    .option("--dry-run", "Report candidates without writing")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals() as {
        repo?: string;
        profile?: string;
        json?: boolean;
        dryRun?: boolean;
      };
      if (!options.dryRun)
        command.error(
          "error: --dry-run is required; lock writing is not implemented",
        );
      if (!options.profile && options.json)
        command.error("error: --profile is required in JSON mode");
      try {
        const repository = await readRepository(resolve(options.repo ?? "."));
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
        const stop = progress(
          "Resolving npm candidates",
          Boolean(options.json),
        );
        let components: Array<{
          component: string;
          package?: string;
          version?: string;
          tarball?: string;
          integrity?: string;
          requirement?: string;
          metadata?: string;
          error?: string;
        }>;
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
                return {
                  component: component.id,
                  package: candidate.name,
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
        const report = {
          kind: "resolution-report",
          profile: profile.id,
          node: process.versions.node,
          components,
          scope:
            "npm top-level candidates only; no lock, target assets, dependency closure, installation or runtime verification",
        };
        if (options.json) console.log(JSON.stringify(report, null, 2));
        else {
          start("Agent Stack · npm candidate report", false);
          console.log(`Profile: ${profile.id}\nNode: ${process.versions.node}`);
          for (const item of components)
            console.log(
              item.error
                ? `[BLOCKED] ${item.component}: ${item.error}`
                : `[CANDIDATE] ${item.component}: ${item.package}@${item.version}\n  Required: ${item.requirement}\n  Metadata: ${item.metadata}\n  Tarball: ${item.tarball}\n  Expected integrity: ${item.integrity}`,
            );
          finish(report.scope, false);
        }
        if (components.some((item) => item.error)) process.exitCode = 1;
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
