import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cmdShimVersion } from "../dist/adapters/package-metadata.js";

const head =
  "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
function nodeShim(target) {
  return `${head}\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
}
function directShim(target) {
  return `${head}"%dp0%\\${target}"   %*\r\n`;
}
async function setup(t, name, pkg, bin, kind = "node") {
  const root = await mkdtemp(join(tmpdir(), "cmd fixture & "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "node_modules", ...pkg.split("/"));
  const target = join(base, ...bin.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    kind === "direct"
      ? "# pnpm's native binary replaces this file during installation\n"
      : "#!/usr/bin/env node\nthrow Error('must not run')\n",
  );
  const manifest = join(base, "package.json");
  await writeFile(
    manifest,
    JSON.stringify({ name: pkg, version: "12.15.0", bin: { [name]: bin } }),
  );
  const wrapper = join(root, `${name}.cmd`);
  const ref = ["node_modules", ...pkg.split("/"), ...bin.split("/")].join("\\");
  const content = kind === "node" ? nodeShim(ref) : directShim(ref);
  await writeFile(wrapper, content);
  return { wrapper, target, manifest, content };
}
for (const [name, pkg, bin, kind] of [
  ["npm", "npm", "bin/npm-cli.js", "node"],
  ["pnpm", "pnpm", "bin/pnpm.cjs", "node"],
  ["pi", "@earendil-works/pi-coding-agent", "dist/bundle/cli.js", "node"],
  ["pnpm", "@pnpm/exe", "pnpm", "direct"],
])
  test(`matches standard ${pkg} ${kind} cmd-shim`, async (t) => {
    const f = await setup(t, name, pkg, bin, kind);
    assert.equal(await cmdShimVersion(f.wrapper, name), "12.15.0");
  });
test("rejects altered wrappers, wrong manifests and missing targets", async (t) => {
  const f = await setup(
    t,
    "pi",
    "@earendil-works/pi-coding-agent",
    "dist/bundle/cli.js",
  );
  for (const text of [
    `${f.content}echo modified\r\n`,
    f.content.replace('"_prog=node"', '"_prog=evil"'),
    "@ECHO OFF\r\nnode corepack.cjs %*\r\n",
  ]) {
    await writeFile(f.wrapper, text);
    assert.equal(await cmdShimVersion(f.wrapper, "pi"), null);
  }
  await writeFile(f.wrapper, f.content);
  const manifest = JSON.parse(await readFile(f.manifest, "utf8"));
  await writeFile(f.manifest, JSON.stringify({ ...manifest, name: "other" }));
  assert.equal(await cmdShimVersion(f.wrapper, "pi"), null);
  await writeFile(
    f.manifest,
    JSON.stringify({ ...manifest, bin: { pi: "other.js" } }),
  );
  assert.equal(await cmdShimVersion(f.wrapper, "pi"), null);
  await writeFile(f.manifest, JSON.stringify(manifest));
  await rm(f.target);
  assert.equal(await cmdShimVersion(f.wrapper, "pi"), null);
});

test("accepts the cmd-shim v8 node template", async (t) => {
  const f = await setup(t, "npm", "npm", "bin/npm-cli.js");
  const old = f.content
    .replace(
      '  SET "_prog=node"\r\n)',
      '  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)',
    )
    .replace(' & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"', ' & "%_prog%"');
  await writeFile(f.wrapper, old);
  assert.equal(await cmdShimVersion(f.wrapper, "npm"), "12.15.0");
});

test("Windows doctor consumes a standard npm wrapper without executing it", {
  skip: process.platform !== "win32",
}, async (t) => {
  const f = await setup(t, "npm", "npm", "bin/npm-cli.js");
  const home = dirname(f.wrapper);
  const repo = join(home, "repo");
  await cp(
    new URL("../stack/components/herdr.yaml", import.meta.url),
    join(repo, "stack/components/herdr.yaml"),
  );
  await cp(
    new URL("./fixtures/windows-profile/herdr-only.json", import.meta.url),
    join(repo, "stack/profiles/herdr-only.json"),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      "doctor",
      "--repo",
      repo,
      "--profile",
      "herdr-only",
      "--json",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: home,
        PATHEXT: ".CMD",
      },
    },
  );
  const report = JSON.parse(result.stdout);
  const npm = report.checks.find((item) => item.name === "npm");
  assert.equal(npm.version, "12.15.0");
  assert.equal(npm.evidence, "package_metadata");
  assert.equal(npm.source, "unknown");
});
