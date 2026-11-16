import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codingMetadataPreload } from "./lib/coding-metadata.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1])
  throw Error(
    "Usage: node scripts/refresh-coding-fixture.mjs --out <new-candidate.json>",
  );
const project = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(args[1]);
try {
  await lstat(output);
  throw Error("Candidate output already exists");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const root = await mkdtemp(join(tmpdir(), "coding-lock-refresh-"));
const token = process.env.AGENT_STACK_TEST_GITHUB_TOKEN;
const env = { ...process.env };
delete env.AGENT_STACK_TEST_GITHUB_TOKEN;
delete env.GITHUB_TOKEN;
try {
  await cp(join(project, "stack"), join(root, "stack"), { recursive: true });
  await rm(join(root, "stack/profiles/coding.yaml"));
  await rm(join(root, "stack/stack.lock.json"), { force: true });
  await copyFile(
    join(project, "test/fixtures/coding-lock/profile.json"),
    join(root, "stack/profiles/coding.json"),
    constants.COPYFILE_EXCL,
  );
  const manifest = JSON.parse(
    await readFile(
      join(project, "test/fixtures/herdr-release/v0.9.5.json"),
      "utf8",
    ),
  );
  if (
    manifest.source !== "https://herdr.dev/latest.json" ||
    manifest.version !== "0.9.5"
  )
    throw Error("Expected the fixed Herdr 0.9.5 manifest snapshot");
  console.log(
    "Metadata inputs: live npm registry and uv GitHub releases; Herdr 0.9.5 manifest snapshot",
  );
  const preload = join(root, "metadata.mjs");
  await writeFile(preload, codingMetadataPreload(manifest));
  const cli = join(project, "dist/cli.js");
  execFileSync(
    process.execPath,
    [
      "--import",
      preload,
      cli,
      "lock",
      "--repo",
      root,
      "--profile",
      "coding",
      "--target",
      "darwin-arm64",
      "--target",
      "darwin-x64",
      "--json",
    ],
    {
      env: {
        ...env,
        ...(token ? { AGENT_STACK_TEST_GITHUB_TOKEN: token } : {}),
      },
      stdio: "inherit",
    },
  );
  execFileSync(
    process.execPath,
    [cli, "validate", "--repo", root, "--lock", "--json"],
    { env, stdio: "inherit" },
  );
  await copyFile(
    join(root, "stack/stack.lock.json"),
    output,
    constants.COPYFILE_EXCL,
  );
  console.log(`Validated candidate written without overwrite: ${output}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
