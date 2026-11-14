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
test("default coding reports malformed release metadata without changing declarations", async (t) => {
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
    /Invalid release page/,
  );
  assert.match(
    report.components.find((x) => x.component === "herdr").error,
    /Invalid input/,
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

test("ignores missing integrity in excluded historical versions", async (t) => {
  const old = manifest("0.1.0", {
    dist: { tarball: "https://registry.npmjs.org/old.tgz", shasum: "old" },
  });
  const { dir, preload } = await setup(t, pack([old, manifest("1.8.0")]));
  const result = run(dir, preload);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).components[0].version, "1.8.0");
});
test("chooses highest Node-compatible candidate", async (t) => {
  const { dir, preload } = await setup(
    t,
    pack([
      manifest("1.7.0"),
      manifest("1.8.0", { engines: { node: ">=999" } }),
    ]),
  );
  const result = run(dir, preload);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).components[0].version, "1.7.0");
});
test("human errors strip untrusted terminal control sequences", async (t) => {
  const body = `globalThis.fetch=async()=>{throw new Error(${JSON.stringify("failure\u001b]0;OWNED\u0007\u001b[31mred\u001b[0m\nnext")})}`;
  const { dir, preload } = await setup(t, null, body);
  const result = run(dir, preload, ["--profile", "fixture", "--dry-run"]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, new RegExp(String.fromCharCode(27)));
  assert.match(result.stdout, /failure/);
});

const ptyDriver = join(repo, "test/lock_pty_driver.py");
for (const [columns, color, blocked] of [
  [40, "color", false],
  [80, "color", false],
  [40, "no-color", false],
  [80, "no-color", false],
  [40, "no-color", true],
  [80, "color", true],
]) {
  test(`lock PTY report ${columns} ${color} ${blocked ? "blocked" : "candidate"}`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const body = blocked
      ? `globalThis.fetch=async()=>{throw new Error(${JSON.stringify("network\u001b]0;OWNED\u0007\u001b[31mred\u001b[0m\nnext")})}`
      : null;
    const { dir, preload } = await setup(t, pack([manifest("1.8.0")]), body);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "tmp"));
    const result = spawnSync(
      "python3",
      [
        ptyDriver,
        process.execPath,
        cli,
        dir,
        dir,
        "report",
        String(columns),
        color,
        preload,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, blocked ? 1 : 0, output.stderr);
    const { stripVTControlCharacters } = await import("node:util");
    const width = (await import("fast-string-width")).default;
    const plain = stripVTControlCharacters(output.stdout);
    for (const line of plain.split(/\r?\n/))
      assert.ok(width(line) <= columns, JSON.stringify(line));
    assert.doesNotMatch(output.stdout, /OWNED/);
    if (blocked) {
      assert.match(plain, /\[BLOCKED\]/);
      assert.match(plain, /networkred next/);
    } else {
      const compact = plain.replace(/\s/g, "");
      assert.ok(compact.includes(integrity));
      assert.ok(
        compact.includes(
          "https://registry.npmjs.org/fixture-package/-/fixture-package-1.8.0.tgz",
        ),
      );
    }
  });
}
for (const mode of [
  "select",
  "cancel",
  "interrupt",
  "redirect-out",
  "redirect-err",
  "ci",
  "dumb",
]) {
  test(`lock PTY ${mode}`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const body =
      mode === "interrupt"
        ? `import {writeFileSync} from 'node:fs'; globalThis.fetch=async (_u,{signal})=>new Promise((_,reject)=>{writeFileSync(${JSON.stringify(join("PLACEHOLDER", "probe.pid"))},'start');const timer=setInterval(()=>{},1000);signal.addEventListener('abort',()=>{clearInterval(timer);writeFileSync(${JSON.stringify(join("PLACEHOLDER", "aborted"))},'yes');reject(signal.reason)});});`
        : null;
    const { dir, preload } = await setup(t, pack([manifest("1.8.0")]), body);
    if (mode === "interrupt") {
      let text = await readFile(preload, "utf8");
      text = text.replaceAll("PLACEHOLDER", dir);
      await writeFile(preload, text);
    }
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "tmp"));
    const result = spawnSync(
      "python3",
      [
        ptyDriver,
        process.execPath,
        cli,
        dir,
        dir,
        mode,
        "80",
        "no-color",
        preload,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(
      out.status,
      mode === "cancel" || mode === "interrupt"
        ? 130
        : mode === "select"
          ? 0
          : 2,
      out.stderr,
    );
    if (mode === "select" || mode === "cancel" || mode === "interrupt")
      assert.equal(out.sent, true);
    else assert.doesNotMatch(out.stderr, /Choose a profile/);
    if (mode === "interrupt")
      assert.equal(await readFile(join(dir, "aborted"), "utf8"), "yes");
  });
}

test("selected version without digest fails instead of falling back", async (t) => {
  const { dir, preload } = await setup(
    t,
    pack([
      manifest("1.7.0"),
      manifest("1.8.0", {
        dist: { tarball: "https://registry.npmjs.org/pkg.tgz" },
      }),
    ]),
  );
  const before = await snapshot(dir);
  const result = run(dir, preload);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).components[0].error, /integrity/);
  assert.deepEqual(await snapshot(dir), before);
});
test("JSON preserves untrusted data as escaped text without UI", async (t) => {
  const message = "network\u001b]0;OWNED\u0007\u001b[31mred\u001b[0m\nnext";
  const { dir, preload } = await setup(
    t,
    null,
    `globalThis.fetch=async()=>{throw new Error(${JSON.stringify(message)})}`,
  );
  const result = run(dir, preload);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).components[0].error, message);
  assert.doesNotMatch(result.stdout, new RegExp(String.fromCharCode(27)));
});
test("lock accepts root shared options and requires profile when stdin is not a TTY", async (t) => {
  const { dir, preload } = await setup(t, pack([manifest("1.8.0")]));
  const rootOptions = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      cli,
      "--repo",
      dir,
      "--json",
      "lock",
      "--profile",
      "fixture",
      "--dry-run",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(rootOptions.status, 0, rootOptions.stdout);
  assert.equal(JSON.parse(rootOptions.stdout).components[0].version, "1.8.0");
  const missing = run(dir, preload, ["--dry-run"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--profile/);
  assert.doesNotMatch(missing.stderr, /Choose a profile/);
});

const uvRelease = (version, id, extra = {}) => ({
  id,
  tag_name: version,
  html_url: `https://github.com/astral-sh/uv/releases/tag/${version}`,
  draft: false,
  prerelease: false,
  ...extra,
});
function mixedPreload(first, second, manifestData, firstStatus = 200) {
  return `globalThis.fetch=async (url)=>{url=String(url);if(url.startsWith('https://api.github.com/')){if(url.includes('page=2'))return new Response(${JSON.stringify(JSON.stringify(second))});return new Response(${JSON.stringify(JSON.stringify(first))},{status:${firstStatus},headers:${JSON.stringify(second ? { link: '<https://api.github.com/repos/astral-sh/uv/releases?per_page=100&page=2>; rel="next"' } : {})}})}if(url==='https://herdr.dev/latest.json')return new Response(${JSON.stringify(JSON.stringify(manifestData))});const name=decodeURIComponent(url.split('/').pop());const version=name==='pnpm'?'12.15.0':'1.5.2';return new Response(JSON.stringify({name,versions:{[version]:{name,version,dist:{tarball:'https://registry.npmjs.org/pkg.tgz',integrity:${JSON.stringify(integrity)}}}}}));};`;
}
test("coding resolves four version candidates across pages without writing", async (t) => {
  const { dir, preload } = await setup(
    t,
    null,
    mixedPreload(
      [
        uvRelease("0.13.8", 1),
        uvRelease("0.13.99-beta.1", 2, { prerelease: true }),
      ],
      [uvRelease("0.13.9", 3)],
      { version: "0.9.5" },
    ),
  );
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
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.components.length, 4);
  assert.equal(
    report.components.find((x) => x.component === "uv").version,
    "0.13.9",
  );
  assert.equal(
    report.components.find((x) => x.component === "herdr").version,
    "0.9.5",
  );
  assert.equal(
    report.components.find((x) => x.component === "herdr").evidence,
    "channel",
  );
  assert.deepEqual(await snapshot(dir), before);
});
for (const [label, first, manifestData, pattern, status] of [
  [
    "no uv version",
    [uvRelease("0.14.0", 1)],
    { version: "0.9.5" },
    /No official uv release/,
    200,
  ],
  [
    "bad stable version",
    [uvRelease("0.13.8", 1)],
    { version: "v0.9.5" },
    /Invalid herdr stable/,
    200,
  ],
  [
    "duplicate uv identity",
    [uvRelease("0.13.8", 1), uvRelease("0.13.9", 1)],
    { version: "0.9.5" },
    /Duplicate release/,
    200,
  ],
  ["uv limit", [], { version: "0.9.5" }, /HTTP 429/, 429],
])
  test(`coding release metadata fails: ${label}`, async (t) => {
    const { dir, preload } = await setup(
      t,
      null,
      mixedPreload(first, null, manifestData, status),
    );
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
    assert.equal(result.status, 1, result.stdout);
    assert.match(JSON.stringify(JSON.parse(result.stdout)), pattern);
    assert.deepEqual(await snapshot(dir), before);
  });

for (const [label, uvResponse, pattern] of [
  ["invalid JSON", "new Response('{')", /invalid JSON/],
  ["oversized metadata", "new Response('x'.repeat(5*1024*1024))", /size limit/],
  [
    "untrusted next",
    "new Response('[]',{headers:{link:'<https://evil.test/?page=2>; rel=\"next\"'}})",
    /Untrusted release pagination/,
  ],
  [
    "timeout",
    "await new Promise((_,reject)=>{const timer=setInterval(()=>{},1000);signal.addEventListener('abort',()=>{clearInterval(timer);reject(signal.reason)})})",
    /timed out/,
  ],
])
  test(`uv rejects ${label}`, async (t) => {
    const body = `globalThis.fetch=async (url,{signal})=>{if(String(url).startsWith('https://api.github.com/'))return ${uvResponse};if(String(url)==='https://herdr.dev/latest.json')return new Response('{"version":"0.9.5"}');const name=decodeURIComponent(String(url).split('/').pop());const version=name==='pnpm'?'12.15.0':'1.5.2';return new Response(JSON.stringify({name,versions:{[version]:{name,version,dist:{tarball:'https://registry.npmjs.org/pkg.tgz',integrity:${JSON.stringify(integrity)}}}}}));};`;
    const { dir, preload } = await setup(t, null, body);
    await cp(
      join(repo, "stack/profiles/coding.yaml"),
      join(dir, "stack/profiles/coding.yaml"),
    );
    const result = run(dir, preload, [
      "--profile",
      "coding",
      "--dry-run",
      "--json",
    ]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(JSON.stringify(JSON.parse(result.stdout)), pattern);
  });
test("herdr beta channel is rejected without requesting manifest", async (t) => {
  const { dir, preload } = await setup(
    t,
    null,
    mixedPreload([uvRelease("0.13.8", 1)], null, { version: "0.9.5" }),
  );
  let profile = await readFile(
    join(repo, "stack/profiles/coding.yaml"),
    "utf8",
  );
  profile = profile.replace("channel: stable", "channel: beta");
  await writeFile(join(dir, "stack/profiles/coding.yaml"), profile);
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--json",
  ]);
  assert.equal(result.status, 1);
  assert.match(
    JSON.parse(result.stdout).components.find((x) => x.component === "herdr")
      .error,
    /Unsupported herdr channel/,
  );
});

test("mixed coding release report uses bounded PTY layout", {
  skip: process.platform === "win32",
}, async (t) => {
  const { dir, preload } = await setup(
    t,
    null,
    mixedPreload([uvRelease("0.13.8", 1)], null, { version: "0.9.5" }),
  );
  const { parse } = await import("yaml");
  const profile = parse(
    await readFile(join(repo, "stack/profiles/coding.yaml"), "utf8"),
  );
  profile.id = "fixture";
  await writeFile(
    join(dir, "stack/profiles/fixture.json"),
    JSON.stringify(profile),
  );
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "tmp"));
  const result = spawnSync(
    "python3",
    [
      ptyDriver,
      process.execPath,
      cli,
      dir,
      dir,
      "report",
      "40",
      "no-color",
      preload,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /channel/);
  assert.match(out.stdout, /release/);
  const { stripVTControlCharacters } = await import("node:util");
  const width = (await import("fast-string-width")).default;
  for (const row of stripVTControlCharacters(out.stdout).split(/\r?\n/))
    assert.ok(width(row) <= 40, row);
});
