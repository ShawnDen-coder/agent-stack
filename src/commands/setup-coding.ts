import { join, resolve } from "node:path";
import { codingInputHash } from "../adapters/coding-readiness.js";
import { recoverCodingResources } from "../adapters/coding-resource-transaction.js";
import {
  applyCodingResources,
  inspectCodingResources,
  planCodingResources,
} from "../adapters/coding-resources.js";
import { verifyCodingRuntime } from "../adapters/coding-runtime.js";
import { hash, optional } from "../adapters/managed-operation.js";
import {
  applyNpmComponent,
  matchesManagedNpm,
  type NpmInstallationInput,
  observeInstalledNpm,
} from "../adapters/npm-state.js";
import { cliNodeRequirement } from "../adapters/package-metadata.js";
import {
  confirmSetup,
  progress,
  setup,
  start,
} from "../adapters/presentation.js";
import {
  recheckSetupBaseline,
  setupBaseline,
} from "../adapters/setup-baseline.js";
import {
  readSetupState,
  type SetupState,
  setupStateFingerprint,
} from "../adapters/setup-state.js";
import { findExecutable, observe } from "../adapters/toolchain.js";
import {
  applyHerdr,
  applyUv,
  bindExternalHerdr,
  bindExternalUv,
  hasPendingUv,
  inspectUvPath,
  matchesManagedHerdr,
  matchesManagedUv,
  recoverPendingUv,
  uvEntryAbsent,
  uvEntryFingerprint,
  uvRootIdentity,
  withSetupOperation,
} from "../adapters/uv-state.js";
import { verifyObservedUv } from "../adapters/uv-version.js";
import { assess } from "../core/doctor.js";
import type { FreshLock } from "../core/fresh-lock.js";
import type { Repository } from "../core/schema.js";
import {
  componentAction,
  type SetupPlan,
  setupPlanSchema,
} from "../core/setup-plan.js";

const ids = ["pi", "pnpm", "uv", "herdr"] as const;
type Id = (typeof ids)[number];
type Mode = "install" | "managed" | "reuse";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export async function setupCoding(input: {
  repo: string;
  lockPath: string;
  lock: FreshLock;
  repository: Repository;
  home: string | null | undefined;
  state: SetupState | null;
  host: SetupPlan["host"];
  signal: AbortSignal;
  json: boolean;
  dryRun: boolean;
  yes: boolean;
  repoSelectedBy: SetupPlan["repo"]["selectedBy"];
  profileSelectedBy: SetupPlan["profile"]["selectedBy"];
  lockSelectedBy: SetupPlan["lock"]["selectedBy"];
}) {
  const { repo, lockPath, lock, repository, signal, json } = input;
  const home = input.home;
  const profile = repository.profiles.find((p) => p.id === "coding");
  if (
    !profile ||
    !same(profile.components.map((c) => c.component).sort(), [...ids].sort()) ||
    !same(profile.integrations, ["pi-herdr"]) ||
    !profile.requires.includes("agent-status")
  )
    throw Error(
      "This coding setup requires Pi, pnpm, uv, Herdr and the pi-herdr agent-status integration",
    );
  if (
    !home ||
    process.platform !== "darwin" ||
    !["darwin-arm64", "darwin-x64"].includes(input.host.target)
  )
    throw Error("Complete coding setup is supported on native macOS only");
  const target = input.host.target as "darwin-arm64" | "darwin-x64";
  const baseline = await setupBaseline(
    repo,
    lockPath,
    repository,
    "coding",
    [...ids],
    profile.integrations,
  );
  let state = input.state,
    expectedBinding = await setupStateFingerprint(home);
  if (!same(await readSetupState(home), state))
    throw Error("Setup state changed during planning");
  const version = (id: Id) => {
    const value = lock.components.find((c) => c.component === id)?.version;
    if (!value) throw Error(`Missing locked ${id}`);
    return value;
  };
  start(
    input.dryRun
      ? "Agent Stack · Setup preview · coding"
      : "Agent Stack · Setup · coding",
    json,
  );
  const stop = progress("Inspecting coding toolchain and resources", json);
  const node = {
    name: "node",
    ...assess(await observe("node", signal), await cliNodeRequirement()),
  };
  const checks = await Promise.all(
    ["npm", "git", ...ids, "uvx"].map(async (name) => ({
      name,
      ...assess(
        (name === "pi" || name === "pnpm"
          ? await observeInstalledNpm(home, name)
          : null) ?? (await observe(name, signal)),
        name === "uvx"
          ? `=${version("uv")}`
          : ids.includes(name as Id)
            ? `=${version(name as Id)}`
            : null,
      ),
    })),
  );
  if (signal.aborted) {
    stop(true);
    throw Error("Cancelled");
  }
  const check = (name: string) => {
    const value = checks.find((c) => c.name === name);
    if (!value) throw Error(`Missing ${name} observation`);
    return value;
  };
  const pending = await hasPendingUv(home);
  const pendingRaw = pending
    ? await optional(join(resolve(home), ".agent-stack", "pending.json"))
    : null;
  const journal = pendingRaw === null ? null : JSON.parse(pendingRaw);
  const pendingComponent = journal
    ? journal.kind === "npm-install"
      ? journal.component
      : journal.stage?.startsWith("herdr-")
        ? "herdr"
        : "uv"
    : null;
  const directoryBlockers: string[] = [];
  let paths = {
    root: join(resolve(home), ".agent-stack"),
    bin: join(resolve(home), ".agent-stack", "bin"),
    identity: "unverified",
  };
  try {
    paths = await inspectUvPath(home, process.env.PATH ?? "");
  } catch (error) {
    directoryBlockers.push(
      error instanceof Error ? error.message : String(error),
    );
  }
  const rootIdentity = await uvRootIdentity(home);
  const uvAsset = lock.assets.find(
    (a) => a.component === "uv" && a.target === target,
  );
  if (
    uvAsset?.artifact.type !== "uv" ||
    uvAsset.digest.algorithm !== "sha256" ||
    uvAsset.format !== "tar.gz"
  )
    throw Error("Missing validated macOS uv archive");
  const uvSource = {
    name: uvAsset.artifact.assetName,
    url: uvAsset.url,
    sha256: uvAsset.digest.value,
    releaseId: uvAsset.artifact.releaseId,
    assetId: uvAsset.artifact.assetId,
  };
  const herdrAsset = lock.assets.find(
    (a) => a.component === "herdr" && a.target === target,
  );
  if (
    herdrAsset?.artifact.type !== "herdr" ||
    herdrAsset.digest.algorithm !== "sha256" ||
    herdrAsset.format !== "binary"
  )
    throw Error("Missing validated macOS Herdr binary");
  const herdrSource = {
    assetKey: herdrAsset.artifact.assetKey,
    name: herdrAsset.artifact.assetName,
    url: herdrAsset.url,
    sha256: herdrAsset.digest.value,
    digestSource: herdrAsset.digestSource,
  };
  const npmAssets = (
    component: "pi" | "pnpm",
  ): NpmInstallationInput["assets"] =>
    lock.assets
      .filter((a) => a.component === component && a.target === target)
      .map((a) => {
        if (a.artifact.type !== "npm" || a.digest.algorithm !== "sha512-sri")
          throw Error("Missing validated npm asset");
        return {
          name: a.artifact.packageName,
          version: a.artifact.packageVersion,
          url: a.url,
          integrity: a.digest.value,
          role: a.artifact.role,
        };
      });
  const modes = {} as Record<Id, Mode>;
  const blockers = [
    ...directoryBlockers,
    ...[node, ...checks.filter((c) => c.name === "npm" || c.name === "git")]
      .filter((c) => c.status !== "ok")
      .map((c) => `${c.name}: ${c.status}`),
  ];
  const fingerprints: Record<string, string> = {};
  for (const id of ids) {
    const receipt = state?.installations[id];
    const observed = check(id);
    let managed = false;
    if (receipt?.mode === "managed") {
      if (id === "pi" || id === "pnpm")
        managed = await matchesManagedNpm(
          home,
          state?.installations[id] as NonNullable<
            SetupState["installations"]["pi"]
          >,
          version(id),
          target,
          npmAssets(id),
        );
      else if (id === "uv" && state?.installations.uv)
        managed = await matchesManagedUv(
          home,
          state.installations.uv,
          version(id),
          target,
          uvSource,
        );
      else if (id === "herdr" && state?.installations.herdr?.mode === "managed")
        managed = await matchesManagedHerdr(
          home,
          state.installations.herdr,
          version(id),
          target,
          herdrSource,
        );
      if (
        !managed ||
        observed.status !== "ok" ||
        observed.path !== join(paths.bin, id)
      )
        blockers.push(
          `Managed ${id} changed or is not the first locked PATH entry`,
        );
      modes[id] = "managed";
    } else if (
      observed.status === "not_found" ||
      (pendingComponent === id && !receipt)
    )
      modes[id] = "install";
    else if (
      (id === "uv" || id === "herdr") &&
      observed.status === "ok" &&
      observed.path
    )
      modes[id] = "reuse";
    else {
      modes[id] = "install";
      blockers.push(
        `Existing ${id} entry conflicts with the lock or has unknown ownership; retain its native installation`,
      );
    }
    if (modes[id] === "install" && pendingComponent !== id) {
      for (const name of id === "uv" ? ["uv", "uvx"] : [id])
        if (!(await uvEntryAbsent(join(paths.bin, name))))
          blockers.push(`Unowned managed ${name} entry already exists`);
    }
    if (modes[id] !== "install" && observed.path)
      fingerprints[id] = await uvEntryFingerprint(observed.path);
  }
  if (modes.uv !== "install") {
    const uv = check("uv"),
      uvx = check("uvx");
    if (!uv.path || !uvx.path || uvx.status !== "ok")
      blockers.push("Existing uvx does not match the lock");
    else {
      await verifyObservedUv(uv.path, "uv", version("uv"), signal);
      await verifyObservedUv(uvx.path, "uvx", version("uv"), signal);
      fingerprints.uvx = await uvEntryFingerprint(uvx.path);
    }
  }
  if (modes.pi === "install" && check("npm").version !== "11.12.1")
    blockers.push("Pi staging currently supports npm 11.12.1");
  for (const c of [node, check("npm"), check("git")])
    if (c.path)
      fingerprints[c.name] = await uvEntryFingerprint(
        c.path,
        c.name === "node" ? 512 * 1024 * 1024 : undefined,
      );
  const resourceInput = {
    repo,
    home,
    profile: "coding",
    target,
    piVersion: version("pi"),
    herdrVersion: version("herdr"),
    env: process.env,
  };
  const resources = await planCodingResources(resourceInput);
  if (signal.aborted) {
    stop(true);
    throw Error("Cancelled");
  }
  blockers.push(...resources.blockers);
  const plan = setupPlanSchema.parse({
    kind: "setup-plan",
    repo: { path: repo, selectedBy: input.repoSelectedBy },
    profile: { id: "coding", selectedBy: input.profileSelectedBy },
    lock: { path: lockPath, selectedBy: input.lockSelectedBy, node: lock.node },
    host: input.host,
    prerequisites: [node, check("npm"), check("git")],
    components: ids.map((id) => ({
      component: id,
      lockedVersion: version(id),
      observation: check(id),
      ownership: modes[id] === "managed" ? "managed" : "unknown",
      action: componentAction(check(id).status),
      ...(id === "uv" || id === "herdr"
        ? {
            lockedAsset: {
              target,
              name: id === "uv" ? uvSource.name : herdrSource.name,
              url: id === "uv" ? uvSource.url : herdrSource.url,
              format: id === "uv" ? "tar.gz" : "binary",
              sha256: id === "uv" ? uvSource.sha256 : herdrSource.sha256,
              digestSource:
                id === "uv" ? uvAsset.digestSource : herdrAsset.digestSource,
            },
          }
        : {}),
    })),
    uvInstallation: {
      mode: modes.uv,
      bin: paths.bin,
      uvx: check("uvx"),
      recovery: pending,
    },
    herdrInstallation: { mode: modes.herdr, recovery: pending },
    npmInstallations: (["pi", "pnpm"] as const).map((component) => ({
      component,
      mode: modes[component],
      assets: npmAssets(component),
      recovery: pending,
    })),
    codingResources: resources,
    integrations: profile.integrations,
    resources: resources.files.map((f) => `${f.action}: ${f.target}`),
    blockers,
    scope:
      "Locked digest is expected metadata until downloaded and checked. Components and resources are prepared before isolated Pi TUI verification; default binding is committed last. User sessions and model calls are not tested.",
  });
  stop(signal.aborted);
  if (signal.aborted) throw Error("Cancelled");
  if (input.dryRun || !json) setup(plan, json);
  const resourceRecoveryOnly =
    resources.blockers.length === 1 &&
    resources.blockers[0] === "Pending resource operation requires recovery";
  if (blockers.length && !(resourceRecoveryOnly && blockers.length === 1)) {
    if (json && !input.dryRun) setup(plan, true);
    process.exitCode = 1;
    return;
  }
  if (input.dryRun) {
    if (blockers.length) process.exitCode = 1;
    return;
  }
  if (!input.yes) {
    const confirmed = await confirmSetup();
    if (confirmed === null)
      throw Error("--yes is required in non-interactive mode");
    if (!confirmed) {
      process.exitCode = 130;
      return;
    }
  }
  if (!node.path || !node.version || !check("npm").path)
    throw Error("Incomplete coding prerequisites");
  const nodeRuntime = { path: node.path, version: node.version },
    npm = check("npm").path as string;
  const recheck = async () => {
    if (signal.aborted) throw Error("Cancelled");
    await recheckSetupBaseline(
      baseline,
      repo,
      lockPath,
      "coding",
      [...ids],
      profile.integrations,
      { binding: expectedBinding },
    );
    if (
      (await inspectUvPath(home, process.env.PATH ?? "")).identity !==
      paths.identity
    )
      throw Error("Managed coding directories changed after planning");
    for (const c of [node, check("npm"), check("git")])
      if (
        !c.path ||
        (await uvEntryFingerprint(
          c.path,
          c.name === "node" ? 512 * 1024 * 1024 : undefined,
        )) !== fingerprints[c.name]
      )
        throw Error(`${c.name} changed after planning`);
  };
  const advance = async (next: SetupState) => {
    const fingerprint = await setupStateFingerprint(home);
    if (
      !same(await readSetupState(home), next) ||
      (fingerprint !== expectedBinding &&
        fingerprint !== hash(Buffer.from(JSON.stringify(next))))
    )
      throw Error("Unexpected setup state after a coding step");
    state = next;
    expectedBinding = fingerprint;
    await recheck();
  };
  const reachable = async (id: Id) => {
    for (const name of id === "uv" ? ["uv", "uvx"] : [id])
      if ((await findExecutable(name)) !== join(paths.bin, name))
        throw Error(`Managed ${name} is not the first PATH entry`);
  };
  const existing = async (id: "uv" | "herdr") => {
    await recheck();
    for (const name of id === "uv" ? ["uv", "uvx"] : [id]) {
      const c = check(name);
      if (
        !c.path ||
        (await findExecutable(name)) !== c.path ||
        (await uvEntryFingerprint(c.path)) !== fingerprints[name]
      )
        throw Error(`Existing ${name} changed after planning`);
      if (id === "uv")
        await verifyObservedUv(
          c.path,
          name as "uv" | "uvx",
          version("uv"),
          signal,
        );
      else if (
        assess(await observe("herdr", signal), `=${version("herdr")}`)
          .status !== "ok"
      )
        throw Error("Herdr version changed after planning");
    }
  };
  await withSetupOperation(paths.root, async () => {
    await recheck();
    if (resourceRecoveryOnly) {
      await recoverCodingResources(home, [
        ...resources.files.slice(0, 3).map((f) => f.target),
        ...resources.files.slice(7, 8).map((f) => f.target),
        join(resolve(home), ".agent-stack", "coding-resources.json"),
      ]);
      throw Error(
        "Previous resources recovered; rerun setup to review a fresh plan",
      );
    }
    if (pending)
      await recoverPendingUv(home, process.env.PATH ?? "", signal, recheck);
    for (const id of ids) {
      const common = {
        home,
        repo,
        profile: "coding",
        lock: lockPath,
        version: version(id),
        target,
        signal,
        deferBinding: true,
        recheck,
      };
      let result: SetupState;
      if (id === "pi" || id === "pnpm")
        result = await applyNpmComponent({
          ...common,
          path: process.env.PATH ?? "",
          component: id,
          node: nodeRuntime,
          npm,
          assets: npmAssets(id),
          checkReachable: () => reachable(id),
        });
      else if (id === "uv") {
        if (modes.uv === "install")
          result = await applyUv({
            ...common,
            path: process.env.PATH ?? "",
            asset: uvSource,
            checkReachable: () => reachable("uv"),
          });
        else {
          await existing("uv");
          const receipt = state?.installations.uv;
          result = await bindExternalUv({
            ...common,
            rootIdentity,
            ...(modes.uv === "managed" && receipt ? { managed: receipt } : {}),
            recheck: () => existing("uv"),
          });
        }
      } else if (modes.herdr === "install")
        result = await applyHerdr({
          ...common,
          path: process.env.PATH ?? "",
          asset: herdrSource,
          checkReachable: () => reachable("herdr"),
        });
      else {
        await existing("herdr");
        const entry = check("herdr").path;
        if (!entry || !fingerprints.herdr) throw Error("Missing Herdr entry");
        result = await bindExternalHerdr({
          ...common,
          path: entry,
          fingerprint: fingerprints.herdr,
          rootIdentity,
          ...(modes.herdr === "managed" &&
          state?.installations.herdr?.mode === "managed"
            ? { managed: state.installations.herdr }
            : {}),
          recheck: () => existing("herdr"),
        });
      }
      await advance(result);
    }
    await applyCodingResources(resources, { signal, recheck });
    const applied = await inspectCodingResources(resourceInput);
    if (
      !applied.ready ||
      !same(
        applied.plan.files.map((f) => f.sourceHash),
        resources.files.map((f) => f.sourceHash),
      )
    )
      throw Error("Coding resources were not applied as planned");
    if (!state?.installations.uv)
      throw Error("Missing prepared coding installations");
    const signatureInput = {
      repo,
      home,
      lockPath,
      lock,
      state,
      node: nodeRuntime,
      allowActiveOperation: true,
      signal,
    };
    const inputHash = await codingInputHash(signatureInput);
    let verification: {
      scope: "isolated-pi-tui-herdr-socket-v1";
      inputHash: string;
    };
    if (
      state.defaultBinding?.repo === repo &&
      state.defaultBinding.profile === "coding" &&
      state.defaultBinding.lock === lockPath &&
      state.defaultBinding.codingVerification?.inputHash === inputHash
    )
      verification = state.defaultBinding.codingVerification;
    else {
      const extension = resources.files[2]?.target;
      if (!extension) throw Error("Missing installed Pi extension");
      await verifyCodingRuntime({
        node: nodeRuntime.path,
        pi: join(paths.bin, "pi"),
        agent: join(repo, "stack", "agents", "coding.md"),
        skills: ["shape", "implement", "verify"].map((n) =>
          join(repo, "stack", "skills", n),
        ),
        extension,
        signal,
      });
      await recheck();
      if ((await codingInputHash(signatureInput)) !== inputHash)
        throw Error("Coding inputs changed during TUI verification");
      verification = { scope: "isolated-pi-tui-herdr-socket-v1", inputHash };
    }
    const uvReceipt = state.installations.uv;
    await existingFinalNative();
    const final = await bindExternalUv({
      home,
      repo,
      profile: "coding",
      lock: lockPath,
      version: version("uv"),
      target,
      rootIdentity,
      ...(uvReceipt.mode === "managed" ? { managed: uvReceipt } : {}),
      codingVerification: verification,
      signal,
      recheck: async () => {
        await recheck();
        if ((await codingInputHash(signatureInput)) !== inputHash)
          throw Error("Coding readiness changed before binding");
      },
    });
    await advance(final);
    if (json)
      console.log(
        JSON.stringify(
          {
            kind: "setup-complete",
            profile: "coding",
            mode: "coding",
            plan,
            binding: final,
            verification,
          },
          null,
          2,
        ),
      );
    else
      console.log(
        "[OK] Coding tools, resources and isolated Pi TUI integration verified.",
      );
  });
  async function existingFinalNative() {
    for (const name of ["uv", "uvx", "herdr"]) {
      const path = await findExecutable(name);
      if (!path) throw Error(`Missing ${name} before coding binding`);
      if (name === "herdr") {
        if (
          assess(await observe(name, signal), `=${version("herdr")}`).status !==
          "ok"
        )
          throw Error("Herdr readiness changed");
      } else
        await verifyObservedUv(
          path,
          name as "uv" | "uvx",
          version("uv"),
          signal,
        );
    }
  }
}
