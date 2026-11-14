import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repo, "dist/cli.js");
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const manifest = (version, extra = {}) => ({
  name: "fixture-package",
  version,
  dist: {
    tarball: `https://registry.npmjs.org/fixture-package/-/fixture-package-${version}.tgz`,
    integrity,
  },
  ...extra,
});
async function setup(t, data, body = null) {
  const dir = await mkdtemp(join(tmpdir(), "lock 测试 & "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(join(repo, "stack"), join(dir, "stack"), { recursive: true });
  await rm(join(dir, "stack/profiles"), { recursive: true });
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(join(dir, "stack/profiles")),
  );
  await writeFile(
    join(dir, "stack/components/fixture.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "fixture",
      description: "test",
      kind: "cli",
      platforms: ["darwin", "linux", "win32"],
      provides: ["fixture-capability"],
      source: { type: "npm", package: "fixture-package" },
    }),
  );
  await writeFile(
    join(dir, "stack/profiles/fixture.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "fixture",
      description: "test",
      platforms: ["darwin", "linux", "win32"],
      components: [{ component: "fixture", version: ">=1 <3" }],
      integrations: [],
      requires: ["fixture-capability"],
    }),
  );
  const preload = join(dir, "preload.mjs");
  await writeFile(
    preload,
    body ??
      `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(data))}, {status: 200});`,
  );
  return { dir, preload };
}
function run(
  dir,
  preload,
  args = ["--profile", "fixture", "--dry-run", "--json"],
) {
  return spawnSync(
    process.execPath,
    ["--import", preload, cli, "lock", "--repo", dir, ...args],
    { encoding: "utf8", timeout: 12000 },
  );
}
async function snapshot(dir) {
  const files = (await readdir(join(dir, "stack"), { recursive: true })).sort();
  return Promise.all(
    files
      .filter((x) => /\.(json|ya?ml)$/.test(x))
      .map(async (x) => [x, await readFile(join(dir, "stack", x), "utf8")]),
  );
}
const pack = (versions) => ({
  name: "fixture-package",
  versions: Object.fromEntries(versions.map((v) => [v.version, v])),
});
test("lock resolves npm candidates from the real CLI without writing", async (t) => {
  const { dir, preload } = await setup(
    t,
    pack([
      manifest("1.2.0"),
      manifest("1.8.0"),
      manifest("2.0.0-beta.1"),
      manifest("2.0.0", { deprecated: "old" }),
    ]),
  );
  const before = await snapshot(dir);
  const result = run(dir, preload);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.kind, "resolution-report");
  assert.equal(report.components[0].version, "1.8.0");
  assert.equal(report.components[0].package, "fixture-package");
  assert.equal(report.components[0].integrity, integrity);
  assert.match(report.components[0].tarball, /1\.8\.0/);
  assert.deepEqual(await snapshot(dir), before);
});

for (const [label, data, expected] of [
  ["range mismatch", pack([manifest("3.0.0")]), /No non-deprecated version/],
  [
    "prerelease only",
    pack([manifest("2.0.0-beta.1")]),
    /No non-deprecated version/,
  ],
  [
    "deprecated only",
    pack([manifest("1.0.0", { deprecated: "retired" })]),
    /No non-deprecated version/,
  ],
  [
    "node engine",
    pack([manifest("1.0.0", { engines: { node: ">=999" } })]),
    /does not satisfy engines/,
  ],
  [
    "wrong package",
    { ...pack([manifest("1.0.0")]), name: "other" },
    /Package name mismatch/,
  ],
  [
    "wrong version",
    { name: "fixture-package", versions: { "1.0.0": manifest("1.1.0") } },
    /Contradictory/,
  ],
  [
    "missing digest",
    pack([
      manifest("1.0.0", {
        dist: { tarball: "https://registry.npmjs.org/pkg.tgz" },
      }),
    ]),
    /integrity/,
  ],
  [
    "bad URL",
    pack([
      manifest("1.0.0", {
        dist: { tarball: "https://evil.test/pkg.tgz", integrity },
      }),
    ]),
    /Invalid tarball URL/,
  ],
])
  test(`lock rejects ${label}`, async (t) => {
    const { dir, preload } = await setup(t, data);
    await writeFile(join(dir, "stack/stack.lock.json"), "existing lock\n");
    const before = await snapshot(dir);
    const result = run(dir, preload);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(JSON.parse(result.stdout).components[0].error, expected);
    assert.deepEqual(await snapshot(dir), before);
  });
for (const [label, body, expected] of [
  [
    "HTTP error",
    "globalThis.fetch=async()=>new Response('',{status:429});",
    /HTTP 429/,
  ],
  [
    "invalid JSON",
    "globalThis.fetch=async()=>new Response('{');",
    /invalid JSON/,
  ],
  [
    "oversized response",
    "globalThis.fetch=async()=>new Response('x'.repeat(9*1024*1024));",
    /size limit/,
  ],
  [
    "timeout",
    "globalThis.fetch=async (_url,{signal})=>new Promise((_,reject)=>{const timer=setInterval(()=>{},1000);signal.addEventListener('abort',()=>{clearInterval(timer);reject(signal.reason);});});",
    /timed out/,
  ],
])
  test(`lock reports ${label}`, async (t) => {
    const { dir, preload } = await setup(t, null, body);
    const before = await snapshot(dir);
    const result = run(dir, preload);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(JSON.parse(result.stdout).components[0].error, expected);
    assert.deepEqual(await snapshot(dir), before);
  });
test("default coding reports unsupported sources without changing declarations", async (t) => {
  const body = `globalThis.fetch=async (url)=>{const name=decodeURIComponent(url.split('/').pop()); const version=name==='pnpm'?'12.15.0':'1.5.2'; return new Response(JSON.stringify({name,versions:{[version]:{name,version,dist:{tarball:'https://registry.npmjs.org/pkg.tgz',integrity:${JSON.stringify(integrity)}}}}}));};`;
  const { dir, preload } = await setup(t, null, body);
  await cp(
    join(repo, "stack/profiles/coding.yaml"),
    join(dir, "stack/profiles/coding.yaml"),
  );
  const before = await snapshot(dir);
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--json",
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.components.filter((x) => x.version).length, 2);
  assert.match(
    report.components.find((x) => x.component === "uv").error,
    /Unsupported source: release/,
  );
  assert.match(
    report.components.find((x) => x.component === "herdr").error,
    /Unsupported source: release/,
  );
  assert.deepEqual(await snapshot(dir), before);
});
test("lock rejects unavailable write options and requires profile in JSON", async (t) => {
  const { dir, preload } = await setup(t, pack([manifest("1.0.0")]));
  for (const args of [
    ["--profile", "fixture", "--json"],
    ["--dry-run", "--json"],
    ["--profile", "fixture", "--dry-run", "--json", "--out", "x"],
    ["--profile", "fixture", "--dry-run", "--json", "--offline"],
  ]) {
    const result = run(dir, preload, args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error.kind, "usage");
  }
  const result = run(dir, preload, [
    "--profile",
    "missing",
    "--dry-run",
    "--json",
  ]);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /Unknown profile/);
});
