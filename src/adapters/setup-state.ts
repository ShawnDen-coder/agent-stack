import { isAbsolute, join } from "node:path";
import semver from "semver";
import { z } from "zod";
import {
  decodeState,
  hash,
  optional,
  optionalBytes,
} from "./managed-operation.js";

export const bindingSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    repo: z.string().refine(isAbsolute),
    profile: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    lock: z.string().refine(isAbsolute),
    uv: z.strictObject({
      version: z.string().refine((value) => semver.valid(value) === value),
      target: z.enum(["darwin-arm64", "darwin-x64"]),
      mode: z.enum(["managed", "external"]),
      directory: z.string().nullable(),
      uvHash: z.string().nullable(),
      uvxHash: z.string().nullable(),
      asset: z
        .strictObject({
          name: z.string(),
          url: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          releaseId: z.number().int().positive(),
          assetId: z.number().int().positive(),
        })
        .optional(),
    }),
  })
  .refine((binding) =>
    binding.uv.mode === "managed"
      ? Boolean(
          binding.uv.directory &&
            /^uv-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/.test(
              binding.uv.directory,
            ) &&
            binding.uv.uvHash &&
            /^[a-f0-9]{64}$/.test(binding.uv.uvHash) &&
            binding.uv.uvxHash &&
            /^[a-f0-9]{64}$/.test(binding.uv.uvxHash),
        )
      : binding.uv.directory === null &&
        binding.uv.uvHash === null &&
        binding.uv.uvxHash === null,
  );
export type UvBinding = z.infer<typeof bindingSchema>;
export async function readSetupState(
  home: string | undefined,
): Promise<UvBinding | null> {
  if (!home || !isAbsolute(home)) return null;
  const data = await optional(join(home, ".agent-stack", "binding.json"));
  return data === null ? null : decodeState(bindingSchema, data);
}
export async function setupStateFingerprint(
  home: string | undefined,
): Promise<string | null> {
  if (!home || !isAbsolute(home)) return null;
  const value = await optionalBytes(join(home, ".agent-stack", "binding.json"));
  return value === null ? null : hash(value);
}
export async function readDefaultBinding(home: string | undefined) {
  const state = await readSetupState(home);
  return state
    ? { repo: state.repo, profile: state.profile, lock: state.lock }
    : null;
}
