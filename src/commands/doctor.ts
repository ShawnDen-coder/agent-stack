import { resolve } from "node:path";
import { Command } from "commander";
import { cliNodeRequirement } from "../adapters/package-metadata.js";
import { readRepository } from "../adapters/repository.js";
import { observe } from "../adapters/toolchain.js";
import { assess } from "../core/doctor.js";
import { validateRepository } from "../core/validate.js";

export function createDoctorCommand(): Command {
  return new Command("doctor")
    .description(
      "Check the selected profile's toolchain without installing tools",
    )
    .requiredOption("--profile <id>", "Profile ID to check")
    .option("--repo <directory>", "Configuration repository directory", ".")
    .option("--json", "Print a machine-readable report")
    .action(
      async (options: { profile: string; repo: string; json?: boolean }) => {
        try {
          const repository = await readRepository(resolve(options.repo));
          const validation = validateRepository(repository);
          if (!validation.valid)
            throw new Error(
              "Repository definitions are invalid; run validate for details",
            );
          const profile = repository.profiles.find(
            (item) => item.id === options.profile,
          );
          if (!profile) throw new Error(`Unknown profile: ${options.profile}`);
          const engine = await cliNodeRequirement();
          const node = assess(
            {
              path: process.execPath,
              version: process.versions.node,
              failure: null,
              evidence: "running_process",
            },
            engine,
          );
          const selected = profile.components.filter((item) =>
            ["pnpm", "uv", "pi"].includes(item.component),
          );
          const checks = await Promise.all(
            ["npm", "git", ...selected.map((item) => item.component)].map(
              async (name) => {
                const selection = selected.find(
                  (item) => item.component === name,
                );
                const requirement =
                  selection && "version" in selection
                    ? selection.version
                    : null;
                const component = repository.components.find(
                  (item) => item.id === name,
                );
                const platformSupported =
                  profile.platforms.includes(process.platform as never) &&
                  (!component ||
                    component.platforms.includes(process.platform as never));
                const observation = platformSupported
                  ? await observe(name)
                  : {
                      path: null,
                      version: null,
                      failure: "platform_not_applicable",
                      evidence: null,
                    };
                return {
                  name,
                  ...assess(observation, requirement),
                  channel:
                    selection && "channel" in selection
                      ? selection.channel
                      : null,
                };
              },
            ),
          );
          const report = {
            profile: profile.id,
            platform: process.platform,
            checks: [
              {
                name: "node",
                ...node,
                channel: null,
              },
              ...checks,
            ],
            unchecked: {
              components: profile.components.filter(
                (item) => !["pnpm", "uv", "pi"].includes(item.component),
              ),
              integrations: profile.integrations,
            },
            scope: "toolchain only; environment readiness is not assessed",
          };
          if (options.json) console.log(JSON.stringify(report, null, 2));
          else {
            console.log(`Profile: ${report.profile} (${report.platform})`);
            for (const item of report.checks)
              console.log(
                `${item.name}: ${item.status}; version=${item.version ?? "unknown"}; requirement=${item.requirement ?? item.channel ?? "none"}; path=${item.path ?? "unknown"}; source=${item.source}; evidence=${item.evidence}${item.channel ? "; channel not assessed" : ""}`,
              );
            console.log(
              `Unchecked components: ${report.unchecked.components.map((item) => item.component).join(", ") || "none"}; integrations: ${report.unchecked.integrations.join(", ") || "none"}`,
            );
            console.log(report.scope);
          }
          if (
            report.checks.some(
              (item) => item.status !== "ok" || item.channel !== null,
            )
          )
            process.exitCode = 1;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (options.json) console.log(JSON.stringify({ error: message }));
          else console.error(message);
          process.exitCode = 1;
        }
      },
    );
}
