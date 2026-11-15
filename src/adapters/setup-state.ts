import { isAbsolute, join } from "node:path";
import semver from "semver";
import { z } from "zod";
import { hash, optional, optionalBytes } from "./managed-operation.js";

export const uvReceiptSchema = z
  .strictObject({
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
  })
  .refine((uv) =>
    uv.mode === "managed"
      ? Boolean(
          uv.directory &&
            /^uv-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/.test(
              uv.directory,
            ) &&
            uv.uvHash &&
            /^[a-f0-9]{64}$/.test(uv.uvHash) &&
            uv.uvxHash &&
            /^[a-f0-9]{64}$/.test(uv.uvxHash),
        )
      : uv.directory === null && uv.uvHash === null && uv.uvxHash === null,
  );
export type UvReceipt = z.infer<typeof uvReceiptSchema>;
const defaultBindingSchema = z.strictObject({
  repo: z.string().refine(isAbsolute),
  profile: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  lock: z.string().refine(isAbsolute),
});
export const bindingSchema = defaultBindingSchema.extend({
  schemaVersion: z.literal(1),
  uv: uvReceiptSchema,
});
const herdrReceiptSchema = z.strictObject({
  mode: z.literal("external"),
  source: z.literal("unknown"),
  version: z.string().refine((value) => semver.valid(value) === value),
  target: z.enum(["darwin-arm64", "darwin-x64"]),
  path: z.string().refine(isAbsolute),
  fingerprint: z.string().min(1),
});
export const setupStateSchema = z.strictObject({
  schemaVersion: z.literal(2),
  defaultBinding: defaultBindingSchema.nullable(),
  installations: z.strictObject({
    uv: uvReceiptSchema.optional(),
    herdr: herdrReceiptSchema.optional(),
  }),
});
export type SetupState = z.infer<typeof setupStateSchema>;
export function decodeSetupState(raw: string): SetupState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid local setup state");
  }
  const v1 = bindingSchema.safeParse(value);
  if (v1.success) {
    const { repo, profile, lock, uv } = v1.data;
    return {
      schemaVersion: 2,
      defaultBinding: { repo, profile, lock },
      installations: { uv },
    };
  }
  const v2 = setupStateSchema.safeParse(value);
  if (!v2.success) throw new Error("Invalid local setup state");
  return v2.data;
}
export async function readSetupState(
  home: string | undefined,
): Promise<SetupState | null> {
  if (!home || !isAbsolute(home)) return null;
  const data = await optional(join(home, ".agent-stack", "binding.json"));
  return data === null ? null : decodeSetupState(data);
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
  return state?.defaultBinding ?? null;
}
