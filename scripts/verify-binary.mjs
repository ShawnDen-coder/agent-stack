import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "agent-stack-binary-"));
try {
  const name = process.platform === "win32" ? "agent-stack.exe" : "agent-stack";
  const executable = join(temp, name);
  const binaryDirectory = process.argv[2]
    ? resolve(process.argv[2])
    : join(root, "binary");
  if (process.argv.length > 3)
    throw new Error("Expected at most one binary directory");
  cpSync(join(binaryDirectory, name), executable);
  assert.match(
    readFileSync(join(binaryDirectory, "licenses", "INDEX.txt"), "utf8"),
    /NODE-LICENSE/,
  );
  assert(
    readFileSync(join(binaryDirectory, "licenses", "NODE-LICENSE")).length > 0,
  );
  const repo = join(temp, "checkout");
  mkdirSync(repo);
  cpSync(join(root, "stack"), join(repo, "stack"), { recursive: true });
  const env = { ...process.env, PATH: temp, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const run = (...args) =>
    execFileSync(executable, args, { cwd: temp, env, encoding: "utf8" });
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(run("--version").trim(), manifest.version);
  assert.match(run("--help"), /agent-stack/);
  assert.equal(
    JSON.parse(run("validate", "--repo", repo, "--json")).valid,
    true,
  );
  console.log(`Verified standalone ${name} ${manifest.version}`);
} finally {
  rmSync(temp, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
