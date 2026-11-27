import { resolve } from "node:path";
import type { Command } from "commander";
import { chooseProfile } from "../adapters/presentation.js";
import { readRepository } from "../adapters/repository.js";
import type { SetupState } from "../adapters/setup-state.js";
import { validateRepository } from "../core/validate.js";

// State acquisition remains with each command: doctor may ignore damaged
// state when both inputs are explicit, whereas setup must never do so.
export function resolveProfileContext(
  requestedRepo: string | undefined,
  requestedProfile: string | undefined,
  binding: SetupState["defaultBinding"] | null,
) {
  const repo = resolve(requestedRepo ?? binding?.repo ?? ".");
  const bound = binding?.repo === repo ? binding : null;
  return { repo, bound, selectedProfile: requestedProfile ?? bound?.profile };
}

export async function selectProfile(input: {
  command: Command;
  repo: string;
  selectedProfile: string | undefined;
  json: boolean;
  signal?: AbortSignal;
}) {
  const { command, repo, selectedProfile, json, signal } = input;
  if (!selectedProfile && json)
    command.error("error: --profile is required in JSON mode");
  const repository = await readRepository(repo);
  if (!validateRepository(repository).valid)
    throw new Error(
      "Repository definitions are invalid; run validate for details",
    );
  const profileId =
    selectedProfile ?? (await chooseProfile(repository.profiles));
  if (!profileId) {
    if (process.exitCode === 130 || signal?.aborted) {
      if (signal?.aborted) process.exitCode = 130;
      return null;
    }
    command.error("error: --profile is required in non-interactive mode");
  }
  const profile = repository.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Unknown profile: ${profileId}`);
  return { repository, profile, profileId };
}
