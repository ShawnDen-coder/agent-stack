import { join, resolve } from "node:path";
import { isSea } from "node:sea";
import { Command, InvalidArgumentError, Option } from "commander";
import { verifyWindowsHerdrEntry } from "../adapters/herdr-windows-archive.js";
import { observeHost } from "../adapters/host.js";
import { readLock } from "../adapters/lock-reader.js";
import { profileOption, shared } from "../adapters/options.js";
import { cliNodeRequirement } from "../adapters/package-metadata.js";
import {
  chooseProfile,
  confirmSetup,
  failure,
  progress,
  setup,
  start,
} from "../adapters/presentation.js";
import { readRepository } from "../adapters/repository.js";
import {
  recheckSetupBaseline,
  setupBaseline,
} from "../adapters/setup-baseline.js";
import {
  localSetupHome,
  readSetupState,
  type SetupState,
} from "../adapters/setup-state.js";
import { findExecutable, observe } from "../adapters/toolchain.js";
import {
  applyHerdr,
  applyUv,
  applyWindowsHerdr,
  bindExternalHerdr,
  bindExternalUv,
  hasPendingUv,
  inspectUvPath,
  matchesManagedHerdr,
  matchesManagedUv,
  recoverPendingUv,
  UvCommittedError,
  uvEntryAbsent,
  uvEntryFingerprint,
  uvRootIdentity,
} from "../adapters/uv-state.js";
import { verifyObservedUv } from "../adapters/uv-version.js";
import { assess } from "../core/doctor.js";
import { freshLockSchema } from "../core/fresh-lock.js";
import { componentAction, setupPlanSchema } from "../core/setup-plan.js";
import { validateRepository } from "../core/validate.js";
import { validateLock } from "../core/validate-lock.js";

export function createSetupCommand(): Command {
  let lockSeen = false;
  return shared(
    new Command("setup").description(
      "Preview or apply locked macOS uv or macOS/Windows Herdr setup",
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
    .option("--yes", "Confirm the displayed plan")
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals() as {
        repo?: string;
        profile?: string;
        lock?: string;
        dryRun?: boolean;
        yes?: boolean;
        json?: boolean;
      };
      if (options.repo !== undefined && !options.repo.trim())
        command.error("error: --repo must not be empty or whitespace");
      if (options.profile !== undefined && !options.profile.trim())
        command.error("error: --profile must not be empty or whitespace");
      const json = Boolean(options.json);
      if (!options.dryRun && !options.yes && json)
        command.error("error: --yes is required in JSON mode");
      const home = localSetupHome();
      let state: SetupState | null;
      try {
        state = await readSetupState(home);
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error), json);
        process.exitCode = 1;
        return;
      }
      const context = state?.defaultBinding ?? null;
      const binding = state?.installations.uv ?? null;
      const repo = resolve(
        options.repo ?? process.env.AGENT_STACK_REPO ?? context?.repo ?? ".",
      );
      const bound = context?.repo === repo ? context : null;
      const selectedProfile =
        options.profile ?? process.env.AGENT_STACK_PROFILE ?? bound?.profile;
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
        const boundLock = bound?.profile === profileId ? bound.lock : undefined;
        const path =
          options.lock !== undefined
            ? resolve(options.lock)
            : (boundLock ?? join(repo, "stack", "stack.lock.json"));
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
        const uvOnly =
          profile.components.length === 1 &&
          profile.components[0]?.component === "uv" &&
          profile.integrations.length === 0;
        const herdrOnly =
          profile.components.length === 1 &&
          profile.components[0]?.component === "herdr" &&
          profile.integrations.length === 0 &&
          profile.requires.includes("workspace");
        const componentIds = profile.components.map((item) => item.component);
        const baseline = await setupBaseline(
          repo,
          path,
          repository,
          profileId,
          componentIds,
          profile.integrations,
        );
        const recheck = () =>
          recheckSetupBaseline(
            baseline,
            repo,
            path,
            profileId,
            componentIds,
            profile.integrations,
          );
        if (
          JSON.stringify(await readLock(path)) !== JSON.stringify(raw) ||
          JSON.stringify(await readSetupState(home)) !== JSON.stringify(state)
        )
          throw new Error("Setup inputs changed during planning");
        await recheck();
        const engine = await cliNodeRequirement();
        const node = {
          name: "node",
          ...assess(
            isSea()
              ? await observe("node", controller.signal)
              : {
                  path: process.execPath,
                  version: process.versions.node,
                  failure: null,
                  evidence: "running_process",
                },
            engine,
          ),
        };
        start(
          options.dryRun
            ? "Agent Stack · Setup preview"
            : "Agent Stack · Setup",
          json,
        );
        const stop = progress("Inspecting toolchain", json);
        let checks: Array<{ name: string } & ReturnType<typeof assess>>;
        try {
          checks = await Promise.all(
            [
              "npm",
              "git",
              ...lock.components.map((item) => item.component),
              ...(uvOnly ? ["uvx"] : []),
            ].map(async (name) => {
              const component = lock.components.find(
                (item) => item.component === name,
              );
              return {
                name,
                ...assess(
                  ["npm", "git", "pi", "pnpm", "uv", "uvx", "herdr"].includes(
                    name,
                  )
                    ? await observe(name, controller.signal)
                    : {
                        path: null,
                        version: null,
                        failure: "not_checked",
                        evidence: null,
                      },
                  component
                    ? `=${component.version}`
                    : name === "uvx"
                      ? `=${lock.components.find((item) => item.component === "uv")?.version}`
                      : null,
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
        const uvVersion = lock.components.find(
          (item) => item.component === "uv",
        )?.version;
        const lockedUvAsset = lock.assets.find(
          (asset) =>
            asset.component === "uv" &&
            asset.target === target &&
            asset.artifact.type === "uv",
        );
        const managedAsset =
          lockedUvAsset?.artifact.type === "uv" &&
          lockedUvAsset.digest.algorithm === "sha256"
            ? {
                name: lockedUvAsset.artifact.assetName,
                url: lockedUvAsset.url,
                sha256: lockedUvAsset.digest.value,
                releaseId: lockedUvAsset.artifact.releaseId,
                assetId: lockedUvAsset.artifact.assetId,
              }
            : undefined;
        const uv = checks.find((item) => item.name === "uv"),
          uvx = checks.find((item) => item.name === "uvx");
        let uvMode: "install" | "reuse" | "managed" | undefined;
        let uvBin: string | null = null;
        let uvPathIdentity: string | undefined;
        const pendingUv = uvOnly && home ? await hasPendingUv(home) : false;
        const uvBlockers: string[] = [];
        if (uvOnly) {
          if (process.platform !== "darwin")
            uvBlockers.push(
              "uv installation is only supported on native macOS",
            );
          if (!home) uvBlockers.push("HOME is required for uv setup");
          if (binding?.mode === "managed" && home && uvVersion) {
            if (
              managedAsset &&
              (await matchesManagedUv(
                home,
                binding,
                uvVersion,
                target,
                managedAsset,
              ))
            ) {
              const expectedBin = join(resolve(home), ".agent-stack", "bin");
              if (
                uv?.path === join(expectedBin, "uv") &&
                uvx?.path === join(expectedBin, "uvx") &&
                uv.status === "ok" &&
                uvx.status === "ok"
              ) {
                uvMode = "managed";
                uvBin = expectedBin;
              } else
                uvBlockers.push(
                  "Managed uv entries are not the first matching PATH entries",
                );
            } else
              uvBlockers.push(
                "Managed uv entries changed or do not match the lock",
              );
          } else if (pendingUv && home && !binding) {
            try {
              const paths = await inspectUvPath(home, process.env.PATH ?? "");
              uvBin = paths.bin;
              uvPathIdentity = paths.identity;
              uvMode = "install";
            } catch (error) {
              uvBlockers.push(
                error instanceof Error ? error.message : String(error),
              );
            }
          } else if (
            uv?.status === "ok" &&
            uvx?.status === "ok" &&
            uv.path &&
            uvx.path &&
            uvVersion
          ) {
            try {
              await Promise.all([
                verifyObservedUv(uv.path, "uv", uvVersion, controller.signal),
                verifyObservedUv(uvx.path, "uvx", uvVersion, controller.signal),
              ]);
              uvMode = "reuse";
            } catch {
              if (controller.signal.aborted) throw new Error("Cancelled");
              uvBlockers.push(
                "Cannot verify existing uv and uvx entry behavior",
              );
            }
          } else if (
            uv?.status === "not_found" &&
            uvx?.status === "not_found" &&
            home
          ) {
            try {
              const paths = await inspectUvPath(home, process.env.PATH ?? "");
              uvBin = paths.bin;
              uvPathIdentity = paths.identity;
              if (
                !(await uvEntryAbsent(join(paths.bin, "uv"))) ||
                !(await uvEntryAbsent(join(paths.bin, "uvx")))
              )
                throw new Error("Managed uv entries already exist");
              uvMode = "install";
            } catch (error) {
              uvBlockers.push(
                error instanceof Error ? error.message : String(error),
              );
            }
          } else
            uvBlockers.push(
              "Existing uv or uvx entry is missing, unverified, or conflicts with the lock",
            );
        }
        const herdr = checks.find((item) => item.name === "herdr");
        const herdrVersion = lock.components.find(
          (item) => item.component === "herdr",
        )?.version;
        const lockedHerdr = lock.assets.find(
          (asset) =>
            asset.component === "herdr" &&
            asset.target === target &&
            asset.artifact.type === "herdr",
        );
        const herdrAsset =
          lockedHerdr?.artifact.type === "herdr" &&
          lockedHerdr.digest.algorithm === "sha256" &&
          lockedHerdr.format === (target === "win32-x64" ? "zip" : "binary")
            ? {
                assetKey: lockedHerdr.artifact.assetKey,
                name: lockedHerdr.artifact.assetName,
                url: lockedHerdr.url,
                sha256: lockedHerdr.digest.value,
                digestSource: lockedHerdr.digestSource,
              }
            : undefined;
        let herdrFingerprint: string | undefined,
          herdrPathIdentity: string | undefined;
        let herdrMode: "install" | "reuse" | "managed" | undefined;
        const herdrPending =
          herdrOnly && home ? await hasPendingUv(home) : false;
        if (herdrOnly) {
          if (process.platform !== "darwin" && target !== "win32-x64")
            uvBlockers.push(
              "Herdr setup is only supported on native macOS or Windows x64",
            );
          if (!home) uvBlockers.push("HOME is required for Herdr setup");
          const receipt = state?.installations.herdr;
          if (
            receipt?.mode === "managed" &&
            home &&
            herdrVersion &&
            herdrAsset
          ) {
            if (
              (await matchesManagedHerdr(
                home,
                receipt,
                herdrVersion,
                target,
                herdrAsset,
              )) &&
              herdr?.path &&
              (target === "win32-x64"
                ? herdr.path.toLowerCase() ===
                  join(
                    resolve(home),
                    ".agent-stack",
                    "bin",
                    "herdr.exe",
                  ).toLowerCase()
                : herdr.path ===
                  join(resolve(home), ".agent-stack", "bin", "herdr")) &&
              herdr.status === "ok"
            )
              herdrMode = "managed";
            else
              uvBlockers.push(
                "Managed Herdr entry changed or does not match the lock",
              );
          } else if (
            home &&
            !receipt &&
            (herdrPending || herdr?.status === "not_found")
          ) {
            try {
              const paths = await inspectUvPath(home, process.env.PATH ?? "");
              herdrPathIdentity = paths.identity;
              if (!herdrPending) {
                const names =
                  target === "win32-x64"
                    ? ["herdr.exe", "conpty", "THIRD-PARTY-NOTICES"]
                    : ["herdr"];
                for (const name of names)
                  if (!(await uvEntryAbsent(join(paths.bin, name))))
                    throw new Error(
                      "Managed Herdr entry or runtime already exists",
                    );
              }
              herdrMode = "install";
            } catch (error) {
              uvBlockers.push(
                error instanceof Error ? error.message : String(error),
              );
            }
          } else if (herdr?.path && herdr.status === "ok" && herdrVersion)
            herdrMode = "reuse";
          else
            uvBlockers.push(
              "Existing Herdr entry is missing, unverified, or conflicts with the lock",
            );
          if (
            (herdrMode === "managed" || herdrMode === "reuse") &&
            herdr?.path
          ) {
            try {
              herdrFingerprint = await uvEntryFingerprint(herdr.path);
              if (target === "win32-x64")
                await verifyWindowsHerdrEntry(herdr.path);
            } catch {
              uvBlockers.push("Cannot verify existing Herdr entry identity");
            }
          }
          if (herdrPending && receipt?.mode === "external")
            uvBlockers.push(
              "Pending operation conflicts with external Herdr binding",
            );
        }
        let rootIdentity: string | null = null;
        if ((uvOnly || herdrOnly) && home) {
          try {
            rootIdentity = await uvRootIdentity(home);
          } catch {
            uvBlockers.push("Cannot verify setup state directory");
          }
        }
        let uvFingerprint: string | undefined,
          uvxFingerprint: string | undefined;
        if (uvMode === "reuse" || uvMode === "managed") {
          try {
            if (!uv?.path || !uvx?.path)
              throw new Error("Missing uv entry path");
            [uvFingerprint, uvxFingerprint] = await Promise.all([
              uvEntryFingerprint(uv.path),
              uvEntryFingerprint(uvx.path),
            ]);
          } catch {
            uvBlockers.push("Cannot verify existing uv entry identities");
          }
        }
        if (uvOnly && pendingUv && binding?.mode === "external")
          uvBlockers.push(
            "Pending uv operation conflicts with the existing external binding; inspect it before retrying",
          );
        if (uvOnly && binding && uvMode === "install")
          uvBlockers.push(
            "Existing setup binding is stale; refusing to replace it",
          );
        const plan = setupPlanSchema.parse({
          kind: "setup-plan",
          repo: {
            path: repo,
            selectedBy:
              options.repo !== undefined
                ? "option"
                : process.env.AGENT_STACK_REPO !== undefined
                  ? "environment"
                  : bound
                    ? "binding"
                    : "cwd",
          },
          profile: {
            id: profileId,
            selectedBy:
              options.profile !== undefined
                ? "option"
                : process.env.AGENT_STACK_PROFILE !== undefined
                  ? "environment"
                  : bound
                    ? "binding"
                    : "interactive",
          },
          lock: {
            path,
            selectedBy:
              options.lock !== undefined
                ? "option"
                : boundLock
                  ? "binding"
                  : "default",
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
            const uvAsset =
              item.component === "uv"
                ? lock.assets.find(
                    (asset) =>
                      asset.component === "uv" &&
                      asset.target === target &&
                      asset.artifact.type === "uv",
                  )
                : undefined;
            if (
              item.component === "uv" &&
              (uvAsset?.artifact.type !== "uv" ||
                uvAsset.digest.algorithm !== "sha256" ||
                (uvAsset.format !== "tar.gz" && uvAsset.format !== "zip"))
            )
              throw new Error("Missing validated uv asset for this target");
            const herdrAsset =
              item.component === "herdr"
                ? lock.assets.find(
                    (asset) =>
                      asset.component === "herdr" &&
                      asset.target === target &&
                      asset.artifact.type === "herdr",
                  )
                : undefined;
            if (
              item.component === "herdr" &&
              (herdrAsset?.artifact.type !== "herdr" ||
                herdrAsset.digest.algorithm !== "sha256" ||
                herdrAsset.format !==
                  (target === "win32-x64" ? "zip" : "binary"))
            )
              throw new Error("Missing validated herdr asset for this target");
            const selectedAsset = uvAsset ?? herdrAsset;
            return {
              component: item.component,
              lockedVersion: item.version,
              observation,
              ownership:
                (item.component === "uv" && uvMode === "managed") ||
                (item.component === "herdr" && herdrMode === "managed")
                  ? "managed"
                  : "unknown",
              ...(selectedAsset &&
              (selectedAsset.artifact.type === "uv" ||
                selectedAsset.artifact.type === "herdr")
                ? {
                    lockedAsset: {
                      target: selectedAsset.target,
                      name: selectedAsset.artifact.assetName,
                      url: selectedAsset.url,
                      format: selectedAsset.format,
                      sha256: selectedAsset.digest.value,
                      digestSource: selectedAsset.digestSource,
                    },
                  }
                : {}),
              action: componentAction(observation.status),
            };
          }),
          ...(uvMode
            ? {
                uvInstallation: {
                  mode: uvMode,
                  bin: uvBin,
                  uvx,
                  recovery: pendingUv,
                },
              }
            : {}),
          ...(herdrMode
            ? { herdrInstallation: { mode: herdrMode, recovery: herdrPending } }
            : {}),
          integrations: profile.integrations,
          resources:
            !herdrOnly &&
            profile.components.some(
              (item) => item.component === "pi" || item.component === "herdr",
            )
              ? ["configuration", "skills", "agent resources"]
              : [],
          blockers: [
            ...[
              node,
              ...checks.filter(
                (item) => item.name === "npm" || item.name === "git",
              ),
            ]
              .filter((item) => item.status !== "ok")
              .map((item) => `${item.name}: ${item.status}`),
            ...uvBlockers,
            ...(!uvOnly && !herdrOnly
              ? [
                  "Installation adapters are not implemented for the complete profile",
                ]
              : []),
            ...(lock.components.some((item) => item.source.type === "npm")
              ? ["Package-level Node engines are not checked"]
              : []),
            ...((!herdrOnly &&
              profile.components.some(
                (item) => item.component === "pi" || item.component === "herdr",
              )) ||
            profile.integrations.length
              ? ["Required resources and integrations are not applied"]
              : []),
          ],
          scope:
            "Plan only; locked digest is expected metadata until downloaded and checked.",
        });
        if (options.dryRun || !json) setup(plan, json);
        if (plan.blockers.length) {
          if (json && !options.dryRun) setup(plan, true);
          process.exitCode = 1;
          return;
        }
        if (options.dryRun) return;
        if (!options.yes) {
          const confirmed = await confirmSetup();
          if (confirmed === null)
            command.error("error: --yes is required in non-interactive mode");
          if (!confirmed) {
            process.exitCode = 130;
            return;
          }
        }
        if (herdrOnly) {
          if (!home || !herdrVersion || !herdrMode || !herdrAsset)
            throw new Error("Incomplete Herdr setup plan");
          const verifyInput = async () => {
            await recheck();
            if (controller.signal.aborted) throw new Error("Cancelled");
            if (
              herdrMode === "install" &&
              (await inspectUvPath(home, process.env.PATH ?? "")).identity !==
                herdrPathIdentity
            )
              throw new Error("Managed entry directory changed after planning");
          };
          let result: SetupState | null;
          if (herdrMode === "install") {
            const apply =
              target === "win32-x64" ? applyWindowsHerdr : applyHerdr;
            result = await apply({
              home,
              path: process.env.PATH ?? "",
              repo,
              profile: profileId,
              lock: path,
              version: herdrVersion,
              target,
              asset: herdrAsset,
              signal: controller.signal,
              recheck: verifyInput,
              checkReachable: async () => {
                const actual = await findExecutable("herdr");
                const expected = join(
                  resolve(home),
                  ".agent-stack",
                  "bin",
                  target === "win32-x64" ? "herdr.exe" : "herdr",
                );
                if (
                  !actual ||
                  (target === "win32-x64"
                    ? actual.toLowerCase() !== expected.toLowerCase()
                    : actual !== expected)
                )
                  throw new Error(
                    "Published Herdr entry is not the first PATH candidate",
                  );
              },
            });
          } else {
            if (!herdr?.path || !herdrFingerprint)
              throw new Error("Incomplete Herdr observation");
            const entry = herdr.path,
              fingerprint = herdrFingerprint;
            const verifyHerdr = async () => {
              await verifyInput();
              if (target === "win32-x64") await verifyWindowsHerdrEntry(entry);
              if (
                (await findExecutable("herdr")) !== entry ||
                (await uvEntryFingerprint(entry)) !== fingerprint
              )
                throw new Error("Existing Herdr entry changed after planning");
              const observation = assess(
                await observe("herdr", controller.signal),
                `=${herdrVersion}`,
              );
              if (
                observation.status !== "ok" ||
                observation.path !== entry ||
                (await uvEntryFingerprint(entry)) !== fingerprint
              )
                throw new Error("Existing Herdr entry changed after planning");
              const receipt = state?.installations.herdr;
              if (
                herdrMode === "managed" &&
                (receipt?.mode !== "managed" ||
                  !(await matchesManagedHerdr(
                    home,
                    receipt,
                    herdrVersion,
                    target,
                    herdrAsset,
                  )))
              )
                throw new Error("Managed Herdr entry changed after planning");
            };
            await verifyHerdr();
            if (herdrMode === "managed") {
              if (herdrPending)
                await recoverPendingUv(
                  home,
                  process.env.PATH ?? "",
                  controller.signal,
                  verifyInput,
                );
              const receipt = state?.installations.herdr;
              if (receipt?.mode !== "managed")
                throw new Error("Missing managed Herdr receipt");
              if (
                context?.repo !== repo ||
                context?.profile !== profileId ||
                context?.lock !== path
              )
                result = await bindExternalHerdr({
                  home,
                  repo,
                  profile: profileId,
                  lock: path,
                  version: herdrVersion,
                  target,
                  path: entry,
                  fingerprint,
                  managed: receipt,
                  rootIdentity,
                  signal: controller.signal,
                  recheck: verifyHerdr,
                });
              else result = state;
            } else
              result = await bindExternalHerdr({
                home,
                repo,
                profile: profileId,
                lock: path,
                version: herdrVersion,
                target,
                path: entry,
                fingerprint,
                rootIdentity,
                signal: controller.signal,
                recheck: verifyHerdr,
              });
          }
          if (json)
            console.log(
              JSON.stringify(
                {
                  kind: "setup-complete",
                  profile: profileId,
                  mode: herdrMode,
                  plan,
                  binding: result,
                },
                null,
                2,
              ),
            );
          else
            console.log(
              herdrMode === "reuse"
                ? "[OK] Existing Herdr was reused; ownership remains unknown."
                : "[OK] Managed Herdr setup completed.",
            );
          return;
        }
        if (!home || !uvMode || !uvVersion || !uv || !uvx)
          throw new Error("Incomplete uv setup plan");
        const selected = plan.components.find(
          (item) => item.component === "uv",
        )?.lockedAsset;
        if (selected?.format !== "tar.gz" || !managedAsset)
          throw new Error("Unsupported uv target asset");
        const verifyInput = async () => {
          await recheck();
          if (
            uvMode !== "install" &&
            rootIdentity !== null &&
            (await uvRootIdentity(home)) !== rootIdentity
          )
            throw new Error("Setup state directory changed after planning");
          if (
            uvMode === "install" &&
            (await inspectUvPath(home, process.env.PATH ?? "")).identity !==
              uvPathIdentity
          )
            throw new Error("Managed entry directory changed after planning");
          if (controller.signal.aborted) throw new Error("Cancelled");
        };
        const verifyExternal = async () => {
          await verifyInput();
          if (!uv.path || !uvx.path) throw new Error("Missing uv entry path");
          if (
            (await findExecutable("uv")) !== uv.path ||
            (await findExecutable("uvx")) !== uvx.path
          )
            throw new Error("Existing uv entries changed after planning");
          if (
            (await uvEntryFingerprint(uv.path)) !== uvFingerprint ||
            (await uvEntryFingerprint(uvx.path)) !== uvxFingerprint
          )
            throw new Error("Existing uv entries changed after planning");
          await Promise.all([
            verifyObservedUv(uv.path, "uv", uvVersion, controller.signal),
            verifyObservedUv(uvx.path, "uvx", uvVersion, controller.signal),
          ]);
          const currentUv = await findExecutable("uv"),
            currentUvx = await findExecutable("uvx");
          if (
            currentUv !== uv.path ||
            currentUvx !== uvx.path ||
            (await uvEntryFingerprint(uv.path)) !== uvFingerprint ||
            (await uvEntryFingerprint(uvx.path)) !== uvxFingerprint ||
            (uvMode === "managed" &&
              binding &&
              (!managedAsset ||
                !(await matchesManagedUv(
                  home,
                  binding,
                  uvVersion,
                  target,
                  managedAsset,
                ))))
          )
            throw new Error("Existing uv entries changed after planning");
        };
        let result: SetupState | null;
        if (uvMode === "managed") {
          await verifyExternal();
          if (pendingUv)
            await recoverPendingUv(
              home,
              process.env.PATH ?? "",
              controller.signal,
              verifyInput,
            );
          if (
            binding &&
            (context?.repo !== repo ||
              context?.profile !== profileId ||
              context?.lock !== path)
          )
            result = await bindExternalUv({
              home,
              repo,
              profile: profileId,
              lock: path,
              version: uvVersion,
              target,
              managed: binding,
              rootIdentity,
              signal: controller.signal,
              recheck: verifyExternal,
            });
          else result = state;
        } else if (uvMode === "reuse")
          result = await bindExternalUv({
            home,
            repo,
            profile: profileId,
            lock: path,
            version: uvVersion,
            target,
            rootIdentity,
            signal: controller.signal,
            recheck: verifyExternal,
          });
        else
          result = await applyUv({
            checkReachable: async () => {
              if (
                (await findExecutable("uv")) !== join(uvBin ?? "", "uv") ||
                (await findExecutable("uvx")) !== join(uvBin ?? "", "uvx")
              )
                throw new Error(
                  "Published uv entries are not the first matching PATH entries",
                );
            },
            home,
            path: process.env.PATH ?? "",
            repo,
            profile: profileId,
            lock: path,
            version: uvVersion,
            target,
            asset: managedAsset,
            signal: controller.signal,
            recheck: verifyInput,
          });
        if (json)
          console.log(
            JSON.stringify(
              {
                kind: "setup-complete",
                profile: profileId,
                mode: uvMode,
                plan,
                binding: result,
              },
              null,
              2,
            ),
          );
        else
          console.log(
            uvMode === "reuse"
              ? "[OK] Existing uv was reused; retain its native PATH in future shells."
              : `[OK] uv profile setup completed. Ensure future shells include ${uvBin} in PATH.`,
          );
      } catch (error) {
        if (error instanceof Error && error.name === "CommanderError")
          throw error;
        if (error instanceof UvCommittedError) {
          failure(error.message, json);
          process.exitCode = 1;
          return;
        }
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
