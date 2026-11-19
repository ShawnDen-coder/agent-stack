import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { registryDecision } from "./lib/npm-release.mjs";

const [tarball] = process.argv.slice(2);
if (!tarball || process.argv.length !== 3)
  throw new Error("Expected the verified npm tarball path");
const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
const decision = await registryDecision({
  registry: "https://registry.npmjs.org/",
  name,
  version,
  tarball,
});
if (decision === "publish") {
  execFileSync(
    "npm",
    [
      "publish",
      tarball,
      "--ignore-scripts",
      "--tag",
      version.includes("-") ? "next" : "latest",
      "--access",
      "public",
      "--registry",
      "https://registry.npmjs.org/",
    ],
    { stdio: "inherit" },
  );
} else
  console.log(`${name}@${version} already exists with identical integrity`);
