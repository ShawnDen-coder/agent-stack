import { z } from "zod";

export const fileIdentitySchema = z.strictObject({
  dev: z.string().regex(/^\d+$/),
  ino: z.string().regex(/^[1-9]\d*$/),
});
export const ownedFileSchema = fileIdentitySchema.extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const relativePath = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value === "" ||
      value
        .split("/")
        .every(
          (part) =>
            part && part !== "." && part !== ".." && !/[\\\0]/.test(part),
        ),
    "Invalid managed tree path",
  );
const entry = fileIdentitySchema.extend({
  path: relativePath,
  mode: z.number().int().min(0).max(0o7777),
});
export const managedTreeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    entries: z
      .array(
        z.discriminatedUnion("type", [
          entry.extend({ type: z.literal("directory") }),
          entry.extend({
            type: z.literal("file"),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          }),
          entry.extend({
            type: z.literal("link"),
            target: z.string().max(4096),
          }),
        ]),
      )
      .min(1)
      .max(50000),
  })
  .superRefine((tree, context) => {
    const entries = new Map(tree.entries.map((item) => [item.path, item]));
    if (
      entries.size !== tree.entries.length ||
      entries.get("")?.type !== "directory"
    )
      context.addIssue({
        code: "custom",
        message: "Invalid tree root or duplicates",
      });
    for (const item of tree.entries) {
      if (!item.path) continue;
      const parent = item.path.split("/").slice(0, -1).join("/");
      if (entries.get(parent)?.type !== "directory")
        context.addIssue({ code: "custom", message: "Missing managed parent" });
    }
  });
export const managedTreeReceiptSchema = z.strictObject({
  root: fileIdentitySchema,
  manifest: ownedFileSchema,
});
export type ManagedTree = z.infer<typeof managedTreeSchema>;
export type ManagedTreeReceipt = z.infer<typeof managedTreeReceiptSchema>;
