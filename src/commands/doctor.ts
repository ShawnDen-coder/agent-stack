import { resolve } from "node:path";
import { isSea } from "node:sea";
import { Command } from "commander";
import { readCodingContext } from "../adapters/coding-context.js";
import { observeInstalledNpm } from "../adapters/npm-state.js";
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
import {
  localSetupHome,
  readDefaultBinding,
  readSetupState,
} from "../adapters/setup-state.js";
import { findExecutable, observe } from "../adapters/toolchain.js";
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
      if (options.repo !== undefined && !options.repo.trim())
        command.error("error: --repo must not be empty or whitespace");
      if (options.profile !== undefined && !options.profile.trim())
        command.error("error: --profile must not be empty or whitespace");
      try {
        const requestedRepo = options.repo ?? process.env.AGENT_STACK_REPO;
        const requestedProfile =
          options.profile ?? process.env.AGENT_STACK_PROFILE;
        const binding =
          requestedRepo !== undefined && requestedProfile !== undefined
            ? null
            : await readDefaultBinding(localSetupHome());
        const repo = resolve(requestedRepo ?? binding?.repo ?? ".");
        const selectedProfile =
          requestedProfile ??
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
        let localState: Awaited<ReturnType<typeof readSetupState>> = null;
        try {
          localState = await readSetupState(localSetupHome());
        } catch (error) {
          if (requestedRepo === undefined || requestedProfile === undefined)
            throw error;
        }
        if (
          profile.id === "coding" &&
          process.platform === "darwin" &&
          localState?.defaultBinding?.codingVerification &&
          localState.defaultBinding.repo === repo
        ) {
          await doctorCoding(repo, Boolean(options.json));
          return;
        }
        const engine = await cliNodeRequirement();
        const node = assess(
          isSea()
            ? await observe("node")
            : {
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
                const installation =
                  platformSupported &&
                  (name === "pi" || name === "pnpm") &&
                  localState &&
                  localSetupHome()
                    ? await observeInstalledNpm(
                        localSetupHome() as string,
                        name,
                      )
                    : null;
                const observation = platformSupported
                  ? (installation ?? (await observe(name, controller.signal)))
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

async function doctorCoding(repo: string, json: boolean) {
  const controller = new AbortController(),
    interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  start("Agent Stack · Doctor", json);
  const stop = progress(
    "Checking locked coding installation and resources",
    json,
  );
  try {
    const context = await readCodingContext({
      repo,
      signal: controller.signal,
    });
    const prerequisites = await Promise.all(
      ["npm", "git"].map(async (name) => ({
        name,
        ...assess(await observe(name, controller.signal), null),
        channel: null,
      })),
    );
    const components = await Promise.all(
      context.lock.components.map(async (component) => ({
        name: component.component,
        ...assess(
          {
            path: await findExecutable(component.component),
            version: context.readiness.ready
              ? (context.state.installations[
                  component.component as "pi" | "pnpm" | "uv" | "herdr"
                ]?.version ?? null)
              : null,
            failure: context.readiness.ready ? null : "not_checked",
            evidence: context.readiness.ready ? "installation_receipt" : null,
          },
          `=${component.version}`,
        ),
        channel: null,
      })),
    );
    if (controller.signal.aborted) throw Error("Cancelled");
    const report = {
      profile: "coding",
      platform: process.platform,
      checks: [
        { name: "node", ...context.nodeCheck, channel: null },
        ...prerequisites,
        ...components,
      ],
      unchecked: {
        components: [],
        integrations: context.readiness.ready ? [] : context.lock.integrations,
      },
      readiness: context.readiness,
      scope: context.readiness.scope,
    };
    doctor(report, repo, json);
    if (
      !context.readiness.ready ||
      report.checks.some((check) => check.status !== "ok")
    )
      process.exitCode = 1;
  } catch (error) {
    if (controller.signal.aborted) {
      process.exitCode = 130;
      failure("Cancelled.", json);
      return;
    }
    throw error;
  } finally {
    stop(controller.signal.aborted);
    process.removeListener("SIGINT", interrupt);
  }
}
