import { readFileSync } from "node:fs";
import { z } from "zod";

declare const SEA_PACKAGE_METADATA: unknown;

const schema = z.object({
  version: z.string().min(1),
  engines: z.object({ node: z.string().min(1) }),
});

export const cliPackage = schema.parse(
  typeof SEA_PACKAGE_METADATA === "undefined"
    ? JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
      )
    : SEA_PACKAGE_METADATA,
);
