import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
if (process.platform === "win32") {
  throw new Error("Package verification currently requires macOS or Linux");
}
const npm = "npm";
const temp = mkdtempSync(join(tmpdir(), "agent-stack-pack-"));
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
try {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const supplied = process.argv[2];
  if (process.argv.length > 3)
    throw new Error("Expected at most one tarball path");
  let tarball;
  if (supplied) tarball = resolve(supplied);
  else {
    const packed = JSON.parse(
      run(npm, ["pack", "--json", "--pack-destination", temp], root),
    );
    assert.equal(packed.length, 1);
    tarball = join(temp, packed[0].filename);
  }
  const files = [];
  await tar.list({ file: tarball, onentry: (entry) => files.push(entry.path) });
  assert(files.includes("package/dist/cli.js"));
  assert(
    !files.some((file) => file.startsWith("package/stack/")),
    "checkout resources must not be bundled",
  );
  const install = join(temp, "install");
  mkdirSync(install);
  writeFileSync(join(install, "package.json"), '{"private":true}\n');
  run(
    npm,
    [
      "install",
      "--global=false",
      "--prefix",
      install,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    install,
  );
  const cli = join(install, "node_modules", manifest.name, "dist", "cli.js");
  assert.equal(
    run(process.execPath, [cli, "--version"], install).trim(),
    manifest.version,
  );
  const bin = join(install, "node_modules", ".bin", "agent-stack");
  assert.equal(run(bin, ["--version"], install).trim(), manifest.version);
  assert.match(run(bin, ["--help"], install), /agent-stack/);
  const validation = JSON.parse(
    run(bin, ["validate", "--repo", root, "--json"], install),
  );
  assert.equal(validation.valid, true);
  assert(
    readdirSync(join(install, "node_modules", manifest.name)).includes("dist"),
  );
  console.log(
    `Verified ${tarball}: isolated install, version ${manifest.version}, and help`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
