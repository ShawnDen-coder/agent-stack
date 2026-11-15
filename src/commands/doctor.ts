import { resolve } from "node:path";
import { Command } from "commander";
import { profileOption, shared } from "../adapters/options.js";
import { cliNodeRequirement } from "../adapters/package-metadata.js";
import {
  chooseProfile,
  doctor,
  failure,
  progress,
  start,
} from "../adapters/presentation.js";
import { readRepository } from "../adapters/repository.js";
import { observe } from "../adapters/toolchain.js";
import { readUvBinding } from "../adapters/uv-state.js";
import { assess } from "../core/doctor.js";
import { validateRepository } from "../core/validate.js";

export function createDoctorCommand(): Command {
  return shared(
    new Command("doctor").description(
      "Check the selected profile's toolchain without installing tools",
    ),
  )
    .addOption(profileOption())
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals() as {
        profile?: string;
        repo?: string;
        json?: boolean;
      };
      try {
        const binding = await readUvBinding(process.env.HOME);
        const repo = resolve(
          options.repo ?? process.env.AGENT_STACK_REPO ?? binding?.repo ?? ".",
        );
        const selectedProfile =
          options.profile ??
          process.env.AGENT_STACK_PROFILE ??
          (binding?.repo === repo ? binding.profile : undefined);
        if (!selectedProfile && options.json)
          command.error("error: --profile is required in JSON mode");
        const repository = await readRepository(repo);
        const validation = validateRepository(repository);
        if (!validation.valid)
          throw new Error(
            "Repository definitions are invalid; run validate for details",
          );
        const profileId =
          selectedProfile ?? (await chooseProfile(repository.profiles));
        if (!profileId) {
          if (process.exitCode === 130) return;
          command.error("error: --profile is required in non-interactive mode");
        }
        const profile = repository.profiles.find(
          (item) => item.id === profileId,
        );
        if (!profile) throw new Error(`Unknown profile: ${profileId}`);
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
          ["pnpm", "uv", "pi", "herdr"].includes(item.component),
        );
        start("Agent Stack · Doctor", Boolean(options.json));
        const stop = progress("Inspecting toolchain", Boolean(options.json));
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        process.once("SIGINT", interrupt);
        let checks: Array<
          ReturnType<typeof assess> & {
            name: string;
            channel: "stable" | "beta" | null;
          }
        > = [];
        try {
          checks = await Promise.all(
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
                  ? await observe(name, controller.signal)
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
              (item) => !["pnpm", "uv", "pi", "herdr"].includes(item.component),
            ),
            integrations: profile.integrations,
          },
          scope: "toolchain only; environment readiness is not assessed",
        };
        doctor(report, repo, Boolean(options.json));
        if (
          report.checks.some(
            (item) => item.status !== "ok" || item.channel !== null,
          )
        )
          process.exitCode = 1;
      } catch (error) {
        if (error instanceof Error && error.name === "CommanderError")
          throw error;
        const message = error instanceof Error ? error.message : String(error);
        failure(message, Boolean(options.json));
        process.exitCode = 1;
      }
    });
}
