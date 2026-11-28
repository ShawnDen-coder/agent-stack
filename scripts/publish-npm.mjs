import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registry, registryDecision } from "./lib/npm-release.mjs";

const [path, mode] = process.argv.slice(2);
if (
  !path ||
  (mode !== undefined && mode !== "--dry-run") ||
  process.argv.length > 4
)
  throw new Error("Usage: publish-npm.mjs TARBALL [--dry-run]");
const tarball = resolve(path);
const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
const dryRun = mode === "--dry-run";
const decision = dryRun
  ? "publish"
  : await registryDecision({
      name,
      version,
      tarball,
      token: process.env.NODE_AUTH_TOKEN,
    });
if (decision === "skip") {
  console.log(`${name}@${version} already exists with identical integrity`);
} else {
  execFileSync(
    "npm",
    [
      "publish",
      tarball,
      ...(dryRun ? ["--dry-run", "--offline"] : []),
      "--ignore-scripts",
      "--tag",
      version.includes("-") ? "next" : "latest",
      "--registry",
      registry,
    ],
    { stdio: "inherit" },
  );
}
