import { z } from "zod";

const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const platform = z.enum(["darwin", "win32", "linux"]);
const ids = z
  .array(id)
  .refine((values) => new Set(values).size === values.length, {
    message: "IDs must be unique",
  });
const platforms = z
  .array(platform)
  .min(1)
  .refine((values) => new Set(values).size === values.length, {
    message: "Platforms must be unique",
  });

export const componentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  description: z.string().min(1),
  kind: z.enum(["runtime", "cli", "workspace", "terminal"]),
  platforms,
  provides: ids.min(1),
  source: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("npm"), package: z.string().min(1) }),
    z.strictObject({ type: z.literal("release"), url: z.url() }),
    z.strictObject({ type: z.literal("application"), url: z.url() }),
  ]),
});

export const integrationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  description: z.string().min(1),
  components: ids.min(2),
  platforms,
  provides: ids.min(1),
  reference: z.url(),
});

const selection = z.union([
  z.strictObject({ component: id, version: z.string().min(1) }),
  z.strictObject({ component: id, channel: z.enum(["stable", "beta"]) }),
]);

export const profileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  description: z.string().min(1),
  platforms,
  components: z
    .array(selection)
    .min(1)
    .refine(
      (values) =>
        new Set(values.map((value) => value.component)).size === values.length,
      { message: "A component can be selected only once" },
    ),
  integrations: ids,
  requires: ids.min(1),
});

export type Component = z.infer<typeof componentSchema>;
export type Integration = z.infer<typeof integrationSchema>;
export type Profile = z.infer<typeof profileSchema>;

export interface Repository {
  components: Component[];
  integrations: Integration[];
  profiles: Profile[];
}

export interface Issue {
  file: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  checked: { components: number; integrations: number; profiles: number };
  issues: Issue[];
}
