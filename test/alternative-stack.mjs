import { cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function addAlternativeStack(repo) {
  const fixture = fileURLToPath(
    new URL("./fixtures/alternative-stack/", import.meta.url),
  );
  return cp(fixture, join(repo, "stack"), { recursive: true });
}
