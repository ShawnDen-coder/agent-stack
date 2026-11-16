import { isAbsolute } from "node:path";
import semver from "semver";
import { z } from "zod";
import {
  fileIdentitySchema,
  managedTreeReceiptSchema,
} from "./managed-tree.js";

const version = z.string().refine((value) => semver.valid(value) === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const npmStageName = z
  .string()
  .regex(/^(?:pi|pnpm)-\d+\.\d+\.\d+-darwin-(?:arm64|x64)-[a-f0-9]{32}$/);
export const npmAssetReceiptSchema = z.strictObject({
  name: z.string().min(1),
  version,
  url: z.url(),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
  role: z.enum(["top-level", "native"]),
});
export const npmEntrySchema = fileIdentitySchema
  .extend({
    type: z.enum(["file", "link"]),
    target: z.string().nullable(),
  })
  .refine((entry) =>
    entry.type === "link" ? Boolean(entry.target) : entry.target === null,
  );
export const managedNpmReceiptSchema = z
  .strictObject({
    mode: z.literal("managed"),
    component: z.enum(["pi", "pnpm"]),
    version,
    target: z.enum(["darwin-arm64", "darwin-x64"]),
    directory: npmStageName,
    entry: npmEntrySchema,
    tree: managedTreeReceiptSchema,
    assets: z.array(npmAssetReceiptSchema).min(1).max(2),
    npmVersion: version.nullable(),
    lockHash: digest.nullable(),
  })
  .refine((receipt) => {
    const top = receipt.assets.filter((asset) => asset.role === "top-level");
    const native = receipt.assets.filter((asset) => asset.role === "native");
    return (
      receipt.directory.startsWith(
        `${receipt.component}-${receipt.version}-${receipt.target}-`,
      ) &&
      receipt.assets.every((asset) => asset.version === receipt.version) &&
      top.length === 1 &&
      (receipt.component === "pi"
        ? receipt.entry.type === "link" &&
          receipt.npmVersion !== null &&
          receipt.lockHash !== null &&
          receipt.assets.length === 1 &&
          top[0]?.name === "@earendil-works/pi-coding-agent"
        : receipt.entry.type === "file" &&
          receipt.npmVersion === null &&
          receipt.lockHash === null &&
          receipt.assets.length === 2 &&
          top[0]?.name === "pnpm" &&
          native.length === 1 &&
          native[0]?.name === `@pnpm/exe.${receipt.target}`)
    );
  });
export const externalNpmReceiptSchema = z.strictObject({
  mode: z.literal("external"),
  source: z.literal("unknown"),
  component: z.enum(["pi", "pnpm"]),
  version,
  target: z.enum(["darwin-arm64", "darwin-x64"]),
  path: z.string().refine(isAbsolute),
  fingerprint: z.string().min(1),
});
export const npmReceiptSchema = z.union([
  managedNpmReceiptSchema,
  externalNpmReceiptSchema,
]);
export type ManagedNpmReceipt = z.infer<typeof managedNpmReceiptSchema>;
export type NpmReceipt = z.infer<typeof npmReceiptSchema>;
export const npmPendingSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    kind: z.literal("npm-install"),
    component: z.enum(["pi", "pnpm"]),
    stage: npmStageName,
    tree: managedTreeReceiptSchema,
    entry: npmEntrySchema.nullable(),
    beforeHash: digest.nullable(),
    beforeIdentity: fileIdentitySchema.nullable(),
    afterHash: digest.nullable(),
  })
  .refine(
    (pending) =>
      pending.stage.startsWith(`${pending.component}-`) &&
      (pending.beforeHash === null) === (pending.beforeIdentity === null) &&
      (pending.afterHash === null) === (pending.entry === null) &&
      (pending.entry === null ||
        pending.entry.type === (pending.component === "pi" ? "link" : "file")),
  );
export type NpmPending = z.infer<typeof npmPendingSchema>;
