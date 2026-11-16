import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { writeBinaryLicenses } from "./lib/binary-licenses.mjs";

if (Number(process.versions.node.split(".")[0]) < 26) {
  throw new Error(
    "Building the standalone executable requires Node 26 or newer",
  );
}
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "agent-stack-sea-"));
const output = resolve(
  root,
  "binary",
  process.platform === "win32" ? "agent-stack.exe" : "agent-stack",
);
try {
  const main = join(temp, "main.mjs");
  const result = await build({
    metafile: true,
    entryPoints: [join(root, "src/cli.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    outfile: main,
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    define: {
      SEA_PACKAGE_METADATA: JSON.stringify({
        version: manifest.version,
        engines: manifest.engines,
      }),
    },
  });
  mkdirSync(resolve(root, "binary"), { recursive: true });
  const licenses = resolve(root, "binary", "licenses");
  rmSync(licenses, { recursive: true, force: true });
  writeBinaryLicenses({
    inputs: result.metafile.inputs,
    root,
    nodeExecutable: process.execPath,
    destination: licenses,
  });
  const config = join(temp, "sea.json");
  writeFileSync(
    config,
    JSON.stringify({
      main,
      output,
      mainFormat: "module",
      disableExperimentalSEAWarning: true,
    }),
  );
  execFileSync(process.execPath, ["--build-sea", config], { stdio: "inherit" });
  if (process.platform === "darwin")
    execFileSync("codesign", ["--sign", "-", "--force", output], {
      stdio: "inherit",
    });
  console.log(output);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
