import { join, resolve } from "node:path";
import { assess } from "../core/doctor.js";
import { freshLockSchema } from "../core/fresh-lock.js";
import { validateRepository } from "../core/validate.js";
import { validateLock } from "../core/validate-lock.js";
import { inspectCodingReadiness } from "./coding-readiness.js";
import { readLock } from "./lock-reader.js";
import { cliNodeRequirement } from "./package-metadata.js";
import { readRepository } from "./repository.js";
import { localSetupHome, readSetupState } from "./setup-state.js";
import { observe } from "./toolchain.js";

export async function readCodingContext(input: {
  repo?: string;
  signal: AbortSignal;
}) {
  const home = localSetupHome();
  if (!home) throw Error("HOME is required for coding");
  const state = await readSetupState(home);
  if (!state)
    throw Error(
      "No completed coding setup; run agent-stack setup --profile coding",
    );
  const binding = state.defaultBinding;
  const repo = resolve(
    input.repo ?? process.env.AGENT_STACK_REPO ?? binding?.repo ?? ".",
  );
  const lockPath =
    binding?.repo === repo && binding.profile === "coding"
      ? binding.lock
      : join(repo, "stack", "stack.lock.json");
  const repository = await readRepository(repo);
  if (!validateRepository(repository).valid)
    throw Error("Invalid coding repository; run validate");
  const raw = await readLock(lockPath);
  validateLock(raw, repository);
  const lock = freshLockSchema.parse(raw);
  if (
    lock.profile !== "coding" ||
    !lock.targets.some(
      (target) => target.id === `${process.platform}-${process.arch}`,
    )
  )
    throw Error("The coding lock does not cover this native target");
  const nodeCheck = assess(
    await observe("node", input.signal),
    await cliNodeRequirement(),
  );
  if (nodeCheck.status !== "ok" || !nodeCheck.path || !nodeCheck.version)
    throw Error(
      `External Node: ${nodeCheck.status}; coding requires a native Node runtime`,
    );
  const node = { path: nodeCheck.path, version: nodeCheck.version };
  const readiness = await inspectCodingReadiness({
    repo,
    home,
    lockPath,
    lock,
    state,
    node,
    signal: input.signal,
  });
  if (input.signal.aborted) throw Error("Cancelled");
  return { repo, home, lockPath, lock, state, node, nodeCheck, readiness };
}
