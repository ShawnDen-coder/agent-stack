import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  readCodingContext,
  UnboundCodingError,
} from "../adapters/coding-context.js";
import {
  assertCodingPiArgs,
  launchCodingPi,
} from "../adapters/coding-launch.js";
import { inspectHerdrContext } from "../adapters/herdr-context.js";
import { LockReadError } from "../adapters/lock-reader.js";
import { shared } from "../adapters/options.js";
import { failure, progress } from "../adapters/presentation.js";
import { cliArgv, lockRecovery } from "../adapters/recovery.js";
import { findExecutable } from "../adapters/toolchain.js";
import { codingSkillNames } from "../core/coding-resources.js";

export type CodingLaunchContext = {
  node: string;
  pi: string;
  agent: string;
  skills: string[];
  blockers?: string[];
  readiness?: Awaited<ReturnType<typeof readCodingContext>>["readiness"];
  host?: Awaited<ReturnType<typeof inspectHerdrContext>>;
  recheck: () => Promise<void>;
};
export type ResolveCodingLaunch = (input: {
  repo?: string;
  signal: AbortSignal;
}) => Promise<CodingLaunchContext>;

const resolveCodingLaunch: ResolveCodingLaunch = async (input) => {
  const context = await readCodingContext(input);
  const blockers = context.readiness.ready
    ? []
    : [context.readiness.reason ?? "Coding setup is not ready"];
  const herdr = await findExecutable("herdr");
  const herdrVersion = context.lock.components.find(
    (component) => component.component === "herdr",
  )?.version;
  const host =
    context.readiness.ready && herdr && herdrVersion
      ? await inspectHerdrContext({
          herdr,
          version: herdrVersion,
          signal: input.signal,
        })
      : {
          ready: false,
          reason: "Coding installation is not ready for a host check",
          scope: "current local Herdr pane and protocol",
        };
  if (!host.ready) blockers.push(host.reason ?? "Herdr context is not ready");
  const proof = context.state.defaultBinding?.codingVerification?.inputHash;
  return {
    node: context.node.path,
    pi: join(context.home, ".agent-stack", "bin", "pi"),
    agent: join(context.repo, "stack", "agents", "coding.md"),
    skills: codingSkillNames.map((name) =>
      join(context.repo, "stack", "skills", name),
    ),
    blockers,
    readiness: context.readiness,
    host,
    recheck: async () => {
      const fresh = await readCodingContext(input);
      if (
        !fresh.readiness.ready ||
        fresh.state.defaultBinding?.codingVerification?.inputHash !== proof
      )
        throw Error("Coding inputs changed before launch; run setup");
      const current = await findExecutable("herdr");
      if (
        !current ||
        current !== herdr ||
        !herdrVersion ||
        !(
          await inspectHerdrContext({
            herdr: current,
            version: herdrVersion,
            signal: input.signal,
          })
        ).ready
      )
        throw Error("Herdr context changed before launch");
    },
  };
};

export function createRunCommand(
  resolveReady: ResolveCodingLaunch = resolveCodingLaunch,
): Command {
  let cwdSeen = false;
  return shared(
    new Command("run").description("Run coding in the current Herdr terminal"),
  )
    .argument("<profile>", "Only the implemented coding profile is supported")
    .argument("[args...]", "Native Pi arguments after --")
    .addOption(
      new Option("--cwd <directory>", "Working directory for Pi").argParser(
        (value) => {
          if (cwdSeen)
            throw new InvalidArgumentError("--cwd may only be specified once");
          cwdSeen = true;
          if (!value.trim())
            throw new InvalidArgumentError("--cwd must not be empty");
          return value;
        },
      ),
    )
    .option("--dry-run", "Print the launch plan without starting Pi")
    .action(
      async (
        profile: string,
        args: string[],
        _options: unknown,
        command: Command,
      ) => {
        const options = command.optsWithGlobals() as {
          repo?: string;
          json?: boolean;
          cwd?: string;
          dryRun?: boolean;
        };
        if (profile !== "coding")
          command.error("error: only the coding profile can be run");
        if (options.json && !options.dryRun)
          command.error(
            "error: --json is supported with --dry-run; Pi requires an interactive terminal",
          );
        const controller = new AbortController(),
          interrupt = () => controller.abort();
        process.once("SIGINT", interrupt);
        const stop = progress(
          "Checking coding installation and current Herdr context",
          Boolean(options.json),
        );
        let stopped = false;
        const finish = () => {
          if (!stopped) {
            stopped = true;
            stop(controller.signal.aborted);
          }
        };
        try {
          assertCodingPiArgs(args);
          const cwd = resolve(options.cwd ?? process.cwd());
          if (!(await stat(cwd)).isDirectory())
            throw Error("--cwd must be a directory");
          const ready = await resolveReady({
            ...(options.repo === undefined ? {} : { repo: options.repo }),
            signal: controller.signal,
          });
          if (controller.signal.aborted) throw Error("Cancelled");
          finish();
          const blockers = [...(ready.blockers ?? [])];
          const plan = {
            kind: "coding-run-plan",
            profile: "coding",
            cwd,
            node: ready.node,
            pi: ready.pi,
            agent: ready.agent,
            skills: ready.skills,
            args,
            readiness: ready.readiness,
            host: ready.host,
            blockers,
          };
          if (options.dryRun) {
            if (options.json) console.log(JSON.stringify(plan, null, 2));
            else console.log(JSON.stringify(plan, null, 2));
            if (blockers.length) process.exitCode = 1;
            return;
          }
          if (blockers.length) throw Error(blockers.join("; "));
          if (
            !process.stdin.isTTY ||
            !process.stdout.isTTY ||
            process.env.TERM === "dumb"
          )
            throw Error(
              "Run coding requires an interactive terminal; use --dry-run --json to inspect the plan",
            );
          await ready.recheck();
          if (controller.signal.aborted) throw Error("Cancelled");
          process.exitCode = await launchCodingPi({
            node: ready.node,
            pi: ready.pi,
            agent: ready.agent,
            skills: ready.skills,
            args,
            cwd,
            signal: controller.signal,
          });
        } catch (error) {
          finish();
          if (error instanceof Error && error.name === "CommanderError")
            throw error;
          if (controller.signal.aborted) {
            process.exitCode = 130;
            return;
          }
          failure(
            error instanceof Error ? error.message : String(error),
            Boolean(options.json),
            error instanceof UnboundCodingError
              ? (() => {
                  const argv = cliArgv(
                    "setup",
                    "--repo",
                    error.repo,
                    "--profile",
                    "coding",
                    "--dry-run",
                  );
                  return {
                    reason: error.reason,
                    path: error.repo,
                    next: {
                      message: "Preview setup.",
                      argv,
                    },
                  };
                })()
              : error instanceof LockReadError
                ? {
                    reason: error.reason,
                    path: error.path,
                    ...(error.repo ? { repo: error.repo } : {}),
                    next: lockRecovery(
                      error.repo ??
                        resolve(
                          options.repo ?? process.env.AGENT_STACK_REPO ?? ".",
                        ),
                      error.path,
                    ),
                  }
                : undefined,
          );
          process.exitCode = 1;
        } finally {
          finish();
          process.removeListener("SIGINT", interrupt);
        }
      },
    );
}
