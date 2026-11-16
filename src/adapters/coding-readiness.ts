import { join, resolve } from "node:path";
import type { FreshLock } from "../core/fresh-lock.js";
import { inspectCodingResources } from "./coding-resources.js";
import { assertNodeTarget } from "./external-node.js";
import { hash, optional } from "./managed-operation.js";
import { matchesManagedNpm } from "./npm-state.js";
import type { SetupState } from "./setup-state.js";
import { findExecutable } from "./toolchain.js";
import {
  matchesManagedHerdr,
  matchesManagedUv,
  uvEntryFingerprint,
} from "./uv-state.js";

// A signature over currently verified installation bytes, checkout resources,
// native destinations and external Node. Computing it never starts Pi or Herdr.
export async function codingInputHash(input: {
  repo: string;
  home: string;
  lockPath: string;
  lock: FreshLock;
  state: SetupState;
  node: { path: string; version: string };
  allowActiveOperation?: boolean;
  signal?: AbortSignal;
}) {
  const { repo, home, lock, state, node } = input;
  const target = `${process.platform}-${process.arch}`;
  if (process.platform !== "darwin" || lock.profile !== "coding")
    throw Error("Coding readiness requires the native macOS coding profile");
  await assertNodeTarget(
    node,
    target,
    input.signal ?? new AbortController().signal,
  );
  const version = (name: string) => {
    const value = lock.components.find((c) => c.component === name)?.version;
    if (!value) throw Error(`Missing locked ${name}`);
    return value;
  };
  const resources = await inspectCodingResources({
    repo,
    home,
    profile: "coding",
    target,
    piVersion: version("pi"),
    herdrVersion: version("herdr"),
    env: process.env,
  });
  if (!resources.ready)
    throw Error(
      "Coding resources are missing, changed or awaiting recovery; run setup",
    );
  if (
    !input.allowActiveOperation &&
    ((await optional(join(resolve(home), ".agent-stack", "pending.json"))) !==
      null ||
      (await optional(
        join(resolve(home), ".agent-stack", "operation.lock"),
      )) !== null)
  )
    throw Error(
      "Coding setup or recovery is pending; run setup before starting coding",
    );
  for (const component of ["pi", "pnpm"] as const) {
    const receipt = state.installations[component];
    const assets = lock.assets
      .filter((a) => a.component === component && a.target === target)
      .map((a) => {
        if (a.artifact.type !== "npm" || a.digest.algorithm !== "sha512-sri")
          throw Error("Missing locked npm asset");
        return {
          name: a.artifact.packageName,
          version: a.artifact.packageVersion,
          url: a.url,
          integrity: a.digest.value,
          role: a.artifact.role,
        };
      });
    if (
      !receipt ||
      !(await matchesManagedNpm(
        home,
        receipt,
        version(component),
        target,
        assets,
      )) ||
      (await findExecutable(component)) !==
        join(resolve(home), ".agent-stack", "bin", component)
    )
      throw Error(`Coding ${component} installation is not ready`);
  }
  const uv = state.installations.uv,
    herdr = state.installations.herdr;
  if (
    !uv ||
    !herdr ||
    uv.version !== version("uv") ||
    herdr.version !== version("herdr") ||
    uv.target !== target ||
    herdr.target !== target
  )
    throw Error("Coding native tool receipts do not match the lock");
  const uvAsset = lock.assets.find(
    (a) => a.component === "uv" && a.target === target,
  );
  if (uvAsset?.artifact.type !== "uv" || uvAsset.digest.algorithm !== "sha256")
    throw Error("Missing locked uv asset");
  if (
    uv.mode === "managed" &&
    !(await matchesManagedUv(home, uv, uv.version, target, {
      name: uvAsset.artifact.assetName,
      url: uvAsset.url,
      sha256: uvAsset.digest.value,
      releaseId: uvAsset.artifact.releaseId,
      assetId: uvAsset.artifact.assetId,
    }))
  )
    throw Error("Coding uv installation changed");
  const herdrAsset = lock.assets.find(
    (a) => a.component === "herdr" && a.target === target,
  );
  if (
    herdrAsset?.artifact.type !== "herdr" ||
    herdrAsset.digest.algorithm !== "sha256"
  )
    throw Error("Missing locked Herdr asset");
  if (
    herdr.mode === "managed" &&
    !(await matchesManagedHerdr(home, herdr, herdr.version, target, {
      assetKey: herdrAsset.artifact.assetKey,
      name: herdrAsset.artifact.assetName,
      url: herdrAsset.url,
      sha256: herdrAsset.digest.value,
      digestSource: herdrAsset.digestSource,
    }))
  )
    throw Error("Coding Herdr installation changed");
  const entries: Record<string, string> = {};
  for (const name of ["uv", "uvx", "herdr"]) {
    const path = await findExecutable(name);
    if (!path) throw Error(`Missing coding ${name} entry`);
    if (
      (name === "herdr" ? herdr.mode : uv.mode) === "managed" &&
      path !== join(resolve(home), ".agent-stack", "bin", name)
    )
      throw Error(`Coding ${name} is not the first managed PATH entry`);
    const fingerprint = await uvEntryFingerprint(path);
    if (
      name === "herdr" &&
      herdr.mode === "external" &&
      (path !== herdr.path || fingerprint !== herdr.fingerprint)
    )
      throw Error("External Herdr entry changed");
    entries[name] = fingerprint;
  }
  return hash(
    Buffer.from(
      JSON.stringify({
        repo,
        lockPath: input.lockPath,
        lock,
        node: { ...node, fingerprint: await uvEntryFingerprint(node.path) },
        installations: state.installations,
        entries,
        resources: resources.plan,
      }),
    ),
  );
}

export async function inspectCodingReadiness(
  input: Parameters<typeof codingInputHash>[0],
) {
  const binding = input.state.defaultBinding;
  const scope =
    "Current inputs against the previous isolated Pi TUI and local Herdr socket verification; live user Herdr context and model access are not checked.";
  if (
    binding?.repo !== input.repo ||
    binding.profile !== "coding" ||
    binding.lock !== input.lockPath ||
    !binding.codingVerification
  )
    return {
      ready: false,
      scope,
      reason: "No matching completed coding setup; run setup",
    };
  try {
    const current = await codingInputHash({
      ...input,
      allowActiveOperation: false,
    });
    return current === binding.codingVerification.inputHash
      ? { ready: true, scope, reason: null }
      : {
          ready: false,
          scope,
          reason: "Coding inputs changed since TUI verification; run setup",
        };
  } catch (error) {
    return {
      ready: false,
      scope,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
