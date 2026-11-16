import { readFileSync, writeFileSync } from "node:fs";
import { valid } from "semver";

const version = process.argv[2];
if (!version || valid(version) !== version || process.argv.length !== 3) {
  throw new Error("Expected one canonical SemVer version");
}
const path = "package.json";
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.version = version;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
