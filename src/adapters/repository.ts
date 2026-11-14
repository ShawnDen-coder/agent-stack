import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
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
): Promise<T[]> {
  const entries = await readdir(join(root, directory), {
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
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  if (filenames.length === 0 && directory !== "integrations")
    throw new Error(`${directory}: no definitions found`);

  return Promise.all(
    filenames.map(async (filename) => {
      const file = `${directory}/${filename}`;
      try {
        const value = schema.parse(
          JSON.parse(await readFile(join(root, file), "utf8")),
        );
        if (value.id !== basename(filename, ".json")) {
          throw new Error(
            `id must match filename: ${basename(filename, ".json")}`,
          );
        }
        return value;
      } catch (error) {
        throw new Error(
          `${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
}

export async function readRepository(root: string): Promise<Repository> {
  const [components, integrations, profiles] = await Promise.all([
    readDefinitions(root, "components", componentSchema),
    readDefinitions(root, "integrations", integrationSchema),
    readDefinitions(root, "profiles", profileSchema),
  ]);
  return { components, integrations, profiles };
}
