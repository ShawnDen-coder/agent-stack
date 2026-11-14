import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseAllDocuments } from "yaml";
import type { z } from "zod";
import {
  componentSchema,
  integrationSchema,
  profileSchema,
  type Repository,
} from "../core/schema.js";

async function readDefinitions<T extends { id: string }>(
  root: string,
  directory: string,
  schema: z.ZodType<T>,
): Promise<{ values: T[]; locations: Record<string, string> }> {
  const entries = await readdir(join(root, "stack", directory), {
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (
      directory === "integrations" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  });
  const filenames = entries
    .filter((entry) => entry.isFile() && /\.(json|yaml|yml)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (filenames.length === 0 && directory !== "integrations")
    throw new Error(`stack/${directory}: no definitions found`);

  const locations: Record<string, string> = {};
  for (const filename of filenames) {
    const id = filename.replace(/\.(json|yaml|yml)$/, "");
    const key = `${directory}/${id}`;
    if (locations[key])
      throw new Error(
        `stack/${directory}: duplicate definition for ${id}: ${locations[key]}, stack/${directory}/${filename}`,
      );
    locations[key] = `stack/${directory}/${filename}`;
  }
  const values = await Promise.all(
    filenames.map(async (filename) => {
      const file = `stack/${directory}/${filename}`;
      try {
        const text = await readFile(join(root, file), "utf8");
        let parsed: unknown;
        if (filename.endsWith(".json")) parsed = JSON.parse(text);
        else {
          const documents = parseAllDocuments(text, {
            version: "1.2",
            uniqueKeys: true,
          });
          if (documents.length !== 1)
            throw new Error("YAML must contain exactly one document");
          const document = documents[0];
          if (!document || document.errors.length || document.warnings.length)
            throw new Error(
              [...(document?.errors ?? []), ...(document?.warnings ?? [])]
                .map((issue) => issue.message)
                .join("; "),
            );
          parsed = document.toJS({ maxAliasCount: 100 });
        }
        const value = schema.parse(parsed);
        const name = basename(filename).replace(/\.(json|yaml|yml)$/, "");
        if (value.id !== name)
          throw new Error(`id must match filename: ${name}`);
        return value;
      } catch (error) {
        throw new Error(
          `${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
  return { values, locations };
}

export async function readRepository(root: string): Promise<Repository> {
  const stack = await stat(join(root, "stack")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (!stack?.isDirectory())
    throw new Error(
      "stack/: directory not found; pass the repository root with --repo and ensure it contains stack/",
    );
  const [components, integrations, profiles] = await Promise.all([
    readDefinitions(root, "components", componentSchema),
    readDefinitions(root, "integrations", integrationSchema),
    readDefinitions(root, "profiles", profileSchema),
  ]);
  return {
    components: components.values,
    integrations: integrations.values,
    profiles: profiles.values,
    locations: {
      ...components.locations,
      ...integrations.locations,
      ...profiles.locations,
    },
  };
}
