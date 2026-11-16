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
const externalHerdrReceiptSchema = z.strictObject({
  mode: z.literal("external"),
  source: z.literal("unknown"),
  version: z.string().refine((value) => semver.valid(value) === value),
  target: z.enum(["darwin-arm64", "darwin-x64", "win32-x64"]),
  path: z.string().refine(isAbsolute),
  fingerprint: z.string().min(1),
});
const managedHerdrReceiptSchema = z.strictObject({
  mode: z.literal("managed"),
  version: z.string().refine((value) => semver.valid(value) === value),
  target: z.enum(["darwin-arm64", "darwin-x64"]),
  directory: z
    .string()
    .regex(/^herdr-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/),
  entryHash: z.string().regex(/^[a-f0-9]{64}$/),
  asset: z.strictObject({
    assetKey: z.enum(["macos-aarch64", "macos-x86_64"]),
    name: z.string(),
    url: z.url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    digestSource: z.url(),
  }),
});
export const windowsHerdrFileSchema = z.strictObject({
  dev: z.string().min(1),
  ino: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const windowsHerdrDirs = [
  "conpty",
  "conpty/arm64",
  "conpty/x64",
  "THIRD-PARTY-NOTICES",
] as const;
export const windowsHerdrDirectorySchema = z.strictObject({
  name: z.enum(windowsHerdrDirs),
  dev: z.string().min(1),
  ino: z.string().min(1),
});
const windowsHerdrReceiptSchema = z
  .strictObject({
    mode: z.literal("managed"),
    version: z.string().refine((value) => semver.valid(value) === value),
    target: z.literal("win32-x64"),
    directory: z.string().regex(/^herdr-\d+\.\d+\.\d+-win32-x64-[a-f0-9]{32}$/),
    entryHash: z.string().regex(/^[a-f0-9]{64}$/),
    stageIdentity: z.strictObject({
      dev: z.string().min(1),
      ino: z.string().min(1),
    }),
    files: z.array(windowsHerdrFileSchema).length(7),
    directories: z
      .array(windowsHerdrDirectorySchema)
      .length(4)
      .refine((dirs) =>
        dirs.every((dir, index) => dir.name === windowsHerdrDirs[index]),
      ),
    asset: z.strictObject({
      assetKey: z.literal("windows-x86_64"),
      name: z.string(),
      url: z.url(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      digestSource: z.url(),
    }),
  })
  .refine((receipt) => receipt.files[4]?.sha256 === receipt.entryHash);
const herdrReceiptSchema = z.union([
  externalHerdrReceiptSchema,
  managedHerdrReceiptSchema,
  windowsHerdrReceiptSchema,
]);
export type HerdrReceipt = z.infer<typeof herdrReceiptSchema>;
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
export function localSetupHome() {
  return (
    process.env.HOME ??
    (process.platform === "win32" ? process.env.USERPROFILE : undefined)
  );
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
