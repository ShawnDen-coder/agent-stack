import { join, resolve } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { observeHost } from "../adapters/host.js";
import { readLock } from "../adapters/lock-reader.js";
import { profileOption, shared } from "../adapters/options.js";
import { cliNodeRequirement } from "../adapters/package-metadata.js";
import {
  chooseProfile,
  failure,
  progress,
  setup,
  start,
} from "../adapters/presentation.js";
import { readRepository } from "../adapters/repository.js";
import { observe } from "../adapters/toolchain.js";
import { assess } from "../core/doctor.js";
import { freshLockSchema } from "../core/fresh-lock.js";
import { componentAction, setupPlanSchema } from "../core/setup-plan.js";
import { validateRepository } from "../core/validate.js";
import { validateLock } from "../core/validate-lock.js";

export function createSetupCommand(): Command {
  let lockSeen = false;
  return shared(
    new Command("setup").description(
      "Preview a read-only setup plan from a shared lock",
    ),
  )
    .addOption(profileOption())
    .addOption(
      new Option("--lock <file>", "Shared lock file").argParser(
        (value: string) => {
          if (lockSeen)
            throw new InvalidArgumentError("--lock may only be specified once");
          lockSeen = true;
          if (!value.trim())
            throw new InvalidArgumentError(
              "--lock path must not be empty or whitespace",
            );
          return value;
        },
      ),
    )
    .option("--dry-run", "Preview only; no changes are made")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals() as {
        repo?: string;
        profile?: string;
        lock?: string;
        dryRun?: boolean;
        json?: boolean;
      };
      if (!options.dryRun)
        command.error("error: setup currently only supports --dry-run");
      if (options.repo !== undefined && !options.repo.trim())
        command.error("error: --repo must not be empty or whitespace");
      if (options.profile !== undefined && !options.profile.trim())
        command.error("error: --profile must not be empty or whitespace");
      const json = Boolean(options.json);
      const repo = resolve(options.repo ?? process.env.AGENT_STACK_REPO ?? ".");
      const selectedProfile =
        options.profile ?? process.env.AGENT_STACK_PROFILE;
      if (!selectedProfile && json)
        command.error("error: --profile is required in JSON mode");
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once("SIGINT", interrupt);
      try {
        const repository = await readRepository(repo);
        if (!validateRepository(repository).valid)
          throw new Error(
            "Repository definitions are invalid; run validate for details",
          );
        const profileId =
          selectedProfile ?? (await chooseProfile(repository.profiles));
        if (!profileId) {
          if (process.exitCode === 130 || controller.signal.aborted) {
            process.exitCode = 130;
            return;
          }
          command.error("error: --profile is required in non-interactive mode");
        }
        const profile = repository.profiles.find(
          (item) => item.id === profileId,
        );
        if (!profile) throw new Error(`Unknown profile: ${profileId}`);
        const path =
          options.lock === undefined
            ? join(repo, "stack", "stack.lock.json")
            : resolve(options.lock);
        const raw = await readLock(path);
        validateLock(raw, repository);
        const lock = freshLockSchema.parse(raw);
        if (lock.profile !== profileId)
          throw new Error("Selected profile does not match the lock");
        const target = `${process.platform}-${process.arch}`;
        if (!lock.targets.some((item) => item.id === target))
          throw new Error(
            `Lock does not cover the current execution target: ${target}`,
          );
        const host = await observeHost(controller.signal);
        if (controller.signal.aborted) throw new Error("Cancelled.");
        if (!host.native)
          throw new Error(
            `Cannot establish a supported native host for ${target}: ${host.evidence}`,
          );
        const engine = await cliNodeRequirement();
        const node = {
          name: "node",
          ...assess(
            {
              path: process.execPath,
              version: process.versions.node,
              failure: null,
              evidence: "running_process",
            },
            engine,
          ),
        };
        start("Agent Stack · Setup preview", json);
        const stop = progress("Inspecting toolchain", json);
        let checks: Array<{ name: string } & ReturnType<typeof assess>>;
        try {
          checks = await Promise.all(
            [
              "npm",
              "git",
              ...lock.components.map((item) => item.component),
            ].map(async (name) => {
              const component = lock.components.find(
                (item) => item.component === name,
              );
              return {
                name,
                ...assess(
                  ["npm", "git", "pi", "pnpm", "uv", "herdr"].includes(name)
                    ? await observe(name, controller.signal)
                    : {
                        path: null,
                        version: null,
                        failure: "not_checked",
                        evidence: null,
                      },
                  component ? `=${component.version}` : null,
                ),
              };
            }),
          );
        } finally {
          stop(controller.signal.aborted);
        }
        if (controller.signal.aborted) {
          process.exitCode = 130;
          failure("Cancelled.", json);
          return;
        }
        const plan = setupPlanSchema.parse({
          kind: "setup-plan",
          repo: {
            path: repo,
            selectedBy:
              options.repo !== undefined
                ? "option"
                : process.env.AGENT_STACK_REPO !== undefined
                  ? "environment"
                  : "cwd",
          },
          profile: {
            id: profileId,
            selectedBy:
              options.profile !== undefined
                ? "option"
                : process.env.AGENT_STACK_PROFILE !== undefined
                  ? "environment"
                  : "interactive",
          },
          lock: {
            path,
            selectedBy: options.lock === undefined ? "default" : "option",
            node: lock.node,
          },
          host,
          prerequisites: [
            node,
            ...checks.filter(
              (item) => item.name === "npm" || item.name === "git",
            ),
          ],
          components: lock.components.map((item) => {
            const observation = checks.find(
              (check) => check.name === item.component,
            );
            if (!observation) throw new Error("Missing component observation");
            return {
              component: item.component,
              lockedVersion: item.version,
              observation,
              ownership: "unknown",
              action: componentAction(observation.status),
            };
          }),
          integrations: profile.integrations,
          resources: ["configuration", "skills", "agent resources"],
          blockers: [
            ...[node, ...checks]
              .filter((item) => item.status !== "ok")
              .map((item) => `${item.name}: ${item.status}`),
            "Package-level Node engines are not checked",
            "Installation and configuration adapters are not implemented",
            "Required resources and integrations are not applied",
          ],
          scope:
            "Read-only preview; metadata does not prove executability or ownership; environment readiness is not assessed.",
        });
        setup(plan, json);
        process.exitCode = 1;
      } catch (error) {
        if (error instanceof Error && error.name === "CommanderError")
          throw error;
        if (controller.signal.aborted) {
          process.exitCode = 130;
          failure("Cancelled.", json);
          return;
        }
        failure(error instanceof Error ? error.message : String(error), json);
        process.exitCode = 1;
      } finally {
        process.removeListener("SIGINT", interrupt);
      }
    });
}
