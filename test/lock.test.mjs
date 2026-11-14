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

for (const [label, flags] of [
  ["draft", { draft: true, prerelease: false }],
  ["prerelease", { draft: false, prerelease: true }],
]) {
  test(`uv ignores non-semver ${label} when selecting an official release`, async (t) => {
    const pending = {
      id: 2,
      tag_name: "work-in-progress",
      html_url: "https://github.com/astral-sh/uv/releases/tag/work-in-progress",
      ...flags,
    };
    const { dir, preload } = await setup(
      t,
      null,
      mixedPreload([uvRelease("0.13.8", 1), pending], null, {
        version: "0.9.5",
      }),
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
    assert.equal(
      JSON.parse(result.stdout).components.find((x) => x.component === "uv")
        .version,
      "0.13.8",
    );
    assert.deepEqual(await snapshot(dir), before);
  });
}

test("uv rejects malformed identity in a formal release", async (t) => {
  const bad = {
    id: 2,
    tag_name: "work-in-progress",
    html_url: "https://github.com/astral-sh/uv/releases/tag/work-in-progress",
    draft: false,
    prerelease: false,
  };
  const { dir, preload } = await setup(
    t,
    null,
    mixedPreload([uvRelease("0.13.8", 1), bad], null, { version: "0.9.5" }),
  );
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
  assert.match(
    JSON.parse(result.stdout).components.find((x) => x.component === "uv")
      .error,
    /Invalid uv release identity/,
  );
});

const assetHash = "a".repeat(64);
function herdrAssetManifest() {
  const version = "0.9.5";
  const keys = ["macos-x86_64", "macos-aarch64", "windows-x86_64"];
  return {
    version,
    assets: Object.fromEntries(
      keys.map((k) => [
        k,
        `https://github.com/herdrdev/herdr/releases/download/v${version}/herdr-${k}${k.startsWith("windows") ? ".zip" : ""}`,
      ]),
    ),
    sha256: Object.fromEntries(keys.map((k) => [k, assetHash])),
  };
}
async function herdrFixture(t, manifest) {
  const body = `import {writeFileSync,readFileSync,existsSync} from 'node:fs';let calls=0;globalThis.fetch=async()=>{calls++;writeFileSync(new URL('./count',import.meta.url),String(calls));return new Response(${JSON.stringify(JSON.stringify(manifest))});};`;
  const f = await setup(t, null, body);
  await writeFile(
    join(f.dir, "stack/profiles/fixture.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "fixture",
      description: "herdr only",
      platforms: ["darwin", "win32", "linux"],
      components: [{ component: "herdr", channel: "stable" }],
      integrations: [],
      requires: ["workspace"],
    }),
  );
  return f;
}
test("herdr target preview uses one snapshot, preserves files and sorts targets", async (t) => {
  const { dir, preload } = await herdrFixture(t, herdrAssetManifest());
  await writeFile(join(dir, "stack/stack.lock.json"), "keep\n");
  const before = await snapshot(dir);
  const result = run(dir, preload, [
    "--profile",
    "fixture",
    "--dry-run",
    "--json",
    "--target",
    "win32-x64",
    "--target",
    "darwin-x64",
    "--target",
    "darwin-arm64",
  ]);
  assert.equal(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.targets, ["darwin-arm64", "darwin-x64", "win32-x64"]);
  assert.equal(report.assets.length, 3);
  assert.equal(report.assets[2].format, "zip");
  assert.match(report.assets[2].url, /windows-x86_64\.zip$/);
  const manifest = herdrAssetManifest();
  for (const [index, key] of [
    "macos-aarch64",
    "macos-x86_64",
    "windows-x86_64",
  ].entries()) {
    assert.equal(report.assets[index].url, manifest.assets[key]);
    assert.equal(report.assets[index].sha256, assetHash);
    assert.equal(
      report.assets[index].digestSource,
      "https://herdr.dev/latest.json",
    );
  }
  assert.equal(await readFile(join(dir, "count"), "utf8"), "1");
  assert.deepEqual(await snapshot(dir), before);
});
for (const [label, change, target, pattern] of [
  [
    "missing asset",
    (m) => delete m.assets["macos-aarch64"],
    "darwin-arm64",
    /Missing asset/,
  ],
  [
    "missing hash",
    (m) => delete m.sha256["macos-aarch64"],
    "darwin-arm64",
    /SHA-256/,
  ],
  [
    "bad hash",
    (m) => (m.sha256["macos-aarch64"] = "xyz"),
    "darwin-arm64",
    /SHA-256/,
  ],
  [
    "foreign host",
    (m) => (m.assets["macos-aarch64"] = "https://evil.test/herdr"),
    "darwin-arm64",
    /Untrusted/,
  ],
  [
    "wrong version",
    (m) =>
      (m.assets["macos-aarch64"] = m.assets["macos-aarch64"].replace(
        "v0.9.5",
        "v0.9.4",
      )),
    "darwin-arm64",
    /version-mismatched/,
  ],
  ["linux ABI", () => {}, "linux-x64-gnu", /not supported/],
  ["unknown arch", () => {}, "darwin-riscv64", /not supported/],
  ["unknown OS", () => {}, "freebsd-x64", /not supported/],
])
  test(`herdr asset blocks ${label}`, async (t) => {
    const m = herdrAssetManifest();
    change(m);
    const { dir, preload } = await herdrFixture(t, m);
    const before = await snapshot(dir);
    const r = run(dir, preload, [
      "--profile",
      "fixture",
      "--dry-run",
      "--json",
      "--target",
      target,
    ]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(JSON.parse(r.stdout).assets[0].error, pattern);
    assert.deepEqual(await snapshot(dir), before);
  });
test("target usage rejects duplicates and malformed syntax", async (t) => {
  const { dir, preload } = await herdrFixture(t, herdrAssetManifest());
  for (const targets of [
    ["--target", "bad!"],
    ["--target", "darwin-x64", "--target", "darwin-x64"],
  ]) {
    const r = run(dir, preload, [
      "--profile",
      "fixture",
      "--dry-run",
      "--json",
      ...targets,
    ]);
    assert.equal(r.status, 2, r.stdout);
    assert.equal(JSON.parse(r.stdout).error.kind, "usage");
  }
});
test("coding target preview blocks uncovered assets", async (t) => {
  const source = mixedPreload(
    [uvRelease("0.13.8", 1)],
    null,
    herdrAssetManifest(),
  );
  const { dir, preload } = await setup(t, null, source);
  await cp(
    join(repo, "stack/profiles/coding.yaml"),
    join(dir, "stack/profiles/coding.yaml"),
  );
  const r = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--json",
    "--target",
    "darwin-arm64",
  ]);
  assert.equal(r.status, 1, r.stdout);
  const assets = JSON.parse(r.stdout).assets;
  assert.equal(assets.filter((x) => x.error).length, 2);
  assert.ok(assets.some((x) => x.component === "pi" && x.role === "top-level"));
  assert.equal(assets.find((x) => x.component === "herdr").sha256, assetHash);
});
for (const columns of [40, 80])
  test(`herdr target preview fits ${columns} column PTY`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const { dir, preload } = await herdrFixture(t, herdrAssetManifest());
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "tmp"));
    const r = spawnSync(
      "python3",
      [
        ptyDriver,
        process.execPath,
        cli,
        dir,
        dir,
        "report",
        String(columns),
        "no-color",
        preload,
        "darwin-arm64",
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(r.status, 0, r.stderr);
    const output = JSON.parse(r.stdout);
    assert.equal(output.status, 0, output.stderr);
    const { stripVTControlCharacters } = await import("node:util");
    const width = (await import("fast-string-width")).default;
    const plain = stripVTControlCharacters(output.stdout);
    for (const line of plain.split(/\r?\n/))
      assert.ok(width(line) <= columns, line);
    const flat = plain.replace(/\s/g, "");
    assert.ok(flat.includes(assetHash));
    assert.ok(flat.includes(herdrAssetManifest().assets["macos-aarch64"]));
  });

test("herdr target network failure reports blocked assets", async (t) => {
  const { dir, preload } = await herdrFixture(t, herdrAssetManifest());
  await writeFile(
    preload,
    'globalThis.fetch=async()=>{throw new Error("offline")};',
  );
  const r = run(dir, preload, [
    "--profile",
    "fixture",
    "--dry-run",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout);
  assert.match(report.components[0].error, /offline/);
  assert.match(report.assets[0].error, /unavailable/);
});
test("herdr target request aborts on PTY interrupt", {
  skip: process.platform === "win32",
}, async (t) => {
  const { dir, preload } = await herdrFixture(t, herdrAssetManifest());
  const marker = join(dir, "probe.pid");
  const aborted = join(dir, "aborted");
  await writeFile(
    preload,
    `import {writeFileSync} from 'node:fs';globalThis.fetch=async (_u,{signal})=>new Promise((_,reject)=>{writeFileSync(${JSON.stringify(marker)},'start');const timer=setInterval(()=>{},1000);signal.addEventListener('abort',()=>{clearInterval(timer);writeFileSync(${JSON.stringify(aborted)},'yes');reject(signal.reason)})});`,
  );
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "tmp"));
  const r = spawnSync(
    "python3",
    [
      ptyDriver,
      process.execPath,
      cli,
      dir,
      dir,
      "interrupt",
      "80",
      "no-color",
      preload,
      "darwin-arm64",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(r.status, 0, r.stderr);
  const output = JSON.parse(r.stdout);
  assert.equal(output.status, 130, output.stderr);
  assert.equal(await readFile(aborted, "utf8"), "yes");
});

function npmAssetPreload(overrides = {}) {
  const data = { ...herdrAssetManifest() };
  return `const opts=${JSON.stringify(overrides)};const hashes=${JSON.stringify(integrity)};globalThis.fetch=async u=>{u=String(u);if(u.startsWith('https://api.github.com/'))return new Response(JSON.stringify([{id:1,tag_name:'0.13.8',html_url:'https://github.com/astral-sh/uv/releases/tag/0.13.8',draft:false,prerelease:false}]));if(u==='https://herdr.dev/latest.json')return new Response(${JSON.stringify(JSON.stringify(data))});const name=decodeURIComponent(u.split('/').pop()),version=name.startsWith('@pnpm/exe.')||name==='pnpm'?'12.15.0':'1.5.2';const deps={'@pnpm/exe.darwin-arm64':'12.15.0','@pnpm/exe.darwin-x64':'12.15.0','@pnpm/exe.win32-x64':'12.15.0'};let entry={name,version,dist:{tarball:'https://registry.npmjs.org/pkg.tgz',integrity:hashes}};if(name==='pnpm')entry.optionalDependencies={...deps,...(opts.dependencies||{})};if(name.startsWith('@pnpm/exe.')){const parts=name.split('.').pop().split('-');entry.os=[parts[0]];entry.cpu=[parts[1]];Object.assign(entry,opts.native||{});}if(name==='@earendil-works/pi-coding-agent')Object.assign(entry,opts.pi||{});return new Response(JSON.stringify({name,versions:{[version]:entry}}));};`;
}
async function codingNpmFixture(t, overrides = {}) {
  const { dir, preload } = await setup(t, null, npmAssetPreload(overrides));
  await cp(
    join(repo, "stack/profiles/coding.yaml"),
    join(dir, "stack/profiles/coding.yaml"),
  );
  return { dir, preload };
}
test("npm and herdr preview supported targets with uv blocked", async (t) => {
  const { dir, preload } = await codingNpmFixture(t);
  await writeFile(join(dir, "stack/stack.lock.json"), "preserve\n");
  const before = await snapshot(dir);
  const r = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--json",
    "--target",
    "win32-x64",
    "--target",
    "darwin-arm64",
    "--target",
    "darwin-x64",
  ]);
  assert.equal(r.status, 1, r.stdout);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.targets, ["darwin-arm64", "darwin-x64", "win32-x64"]);
  for (const target of report.targets) {
    const a = report.assets.filter((x) => x.target === target);
    assert.equal(
      a.find((x) => x.component === "pi").identity,
      "@earendil-works/pi-coding-agent@1.5.2",
    );
    assert.equal(
      a.find((x) => x.component === "pnpm" && x.role === "top-level").identity,
      "pnpm@12.15.0",
    );
    const native = a.find((x) => x.component === "pnpm" && x.role === "native");
    assert.equal(native.identity, `@pnpm/exe.${target}@12.15.0`);
    assert.equal(native.integrity, integrity);
    assert.match(native.url, /^https:\/\/registry\.npmjs\.org\//);
    assert.ok(a.find((x) => x.component === "herdr").sha256);
    assert.match(a.find((x) => x.component === "uv").error, /not covered/);
  }
  assert.deepEqual(await snapshot(dir), before);
});
for (const [label, overrides, pattern] of [
  [
    "missing dependency",
    { dependencies: { "@pnpm/exe.darwin-arm64": "" } },
    /native dependency/,
  ],
  [
    "range dependency",
    { dependencies: { "@pnpm/exe.darwin-arm64": "^12.15.0" } },
    /native dependency/,
  ],
  ["native platform", { native: { cpu: ["x64"] } }, /cpu/],
  [
    "native bad digest",
    {
      native: {
        dist: {
          tarball: "https://registry.npmjs.org/pkg.tgz",
          integrity: "sha512-invalid",
        },
      },
    },
    /SHA512/,
  ],
  [
    "native bad URL",
    { native: { dist: { tarball: "https://evil.test/pkg.tgz", integrity } } },
    /tarball URL/,
  ],
  ["pi excluded OS", { pi: { os: ["!darwin"] } }, /os/],
  ["pi excluded CPU", { pi: { cpu: ["x64"] } }, /cpu/],
  ["pi unknown libc", { pi: { libc: ["musl"] } }, /libc/],
])
  test(`npm target rejects ${label}`, async (t) => {
    const { dir, preload } = await codingNpmFixture(t, overrides);
    const before = await snapshot(dir);
    const r = run(dir, preload, [
      "--profile",
      "coding",
      "--dry-run",
      "--json",
      "--target",
      "darwin-arm64",
    ]);
    assert.equal(r.status, 1, r.stdout);
    const report = JSON.parse(r.stdout);
    assert.match(report.assets.map((x) => x.error || "").join("\n"), pattern);
    assert.deepEqual(await snapshot(dir), before);
  });
for (const columns of [40, 80])
  for (const color of ["color", "no-color"])
    test(`mixed npm and herdr assets fit ${columns} columns ${color}`, {
      skip: process.platform === "win32",
    }, async (t) => {
      const { dir, preload } = await codingNpmFixture(t);
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
      const r = spawnSync(
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
          "darwin-arm64",
        ],
        { encoding: "utf8", timeout: 15000 },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.status, 1, out.stderr);
      const { stripVTControlCharacters } = await import("node:util");
      const width = (await import("fast-string-width")).default;
      const text = stripVTControlCharacters(out.stdout);
      for (const line of text.split(/\r?\n/))
        assert.ok(width(line) <= columns, line);
      const compact = text.replace(/\s/g, "");
      assert.ok(compact.includes(integrity));
      assert.ok(compact.includes(assetHash));
      assert.ok(compact.includes("https://registry.npmjs.org/pkg.tgz"));
      assert.match(text, /\[BLOCKED\] uv/);
    });
for (const [label, override, pattern] of [
  ["native wrong name", { name: "other" }, /Contradictory/],
  ["native wrong version", { version: "12.14.0" }, /Contradictory/],
  [
    "native Node incompatible",
    { engines: { node: ">=999" } },
    /does not satisfy engines/,
  ],
  [
    "native missing integrity",
    { dist: { tarball: "https://registry.npmjs.org/pkg.tgz" } },
    /integrity/,
  ],
])
  test(`pnpm target blocks ${label}`, async (t) => {
    const { dir, preload } = await codingNpmFixture(t, { native: override });
    const before = await snapshot(dir);
    const r = run(dir, preload, [
      "--profile",
      "coding",
      "--dry-run",
      "--json",
      "--target",
      "darwin-arm64",
    ]);
    assert.equal(r.status, 1);
    assert.match(JSON.stringify(JSON.parse(r.stdout).assets), pattern);
    assert.deepEqual(await snapshot(dir), before);
  });
test("pnpm native metadata fetch aborts on Ctrl-C", {
  skip: process.platform === "win32",
}, async (t) => {
  const { dir, preload } = await codingNpmFixture(t);
  const marker = join(dir, "probe.pid"),
    aborted = join(dir, "aborted");
  let body = await readFile(preload, "utf8");
  body =
    `import {writeFileSync} from 'node:fs';` +
    body.replace(
      "globalThis.fetch=async u=>{u=String(u);",
      `globalThis.fetch=async (u,{signal})=>{u=String(u);if(decodeURIComponent(u).includes('@pnpm/exe.'))return new Promise((_,reject)=>{writeFileSync(${JSON.stringify(marker)},'start');const timer=setInterval(()=>{},1000);signal.addEventListener('abort',()=>{clearInterval(timer);writeFileSync(${JSON.stringify(aborted)},'yes');reject(signal.reason)})});`,
    );
  await writeFile(preload, body);
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
  const r = spawnSync(
    "python3",
    [
      ptyDriver,
      process.execPath,
      cli,
      dir,
      dir,
      "interrupt",
      "80",
      "no-color",
      preload,
      "darwin-arm64",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(r.status, 0, r.stderr);
  const output = JSON.parse(r.stdout);
  assert.equal(output.status, 130, output.stderr);
  assert.equal(await readFile(aborted, "utf8"), "yes");
});
for (const mode of ["network failure", "timeout"])
  test(`pnpm native reports ${mode}`, async (t) => {
    const { dir, preload } = await codingNpmFixture(t);
    let body = await readFile(preload, "utf8");
    const fail =
      mode === "timeout"
        ? "return new Promise((_,reject)=>{const timer=setInterval(()=>{},1000);signal.addEventListener('abort',()=>{clearInterval(timer);reject(signal.reason)})})"
        : "throw new Error('native offline')";
    body = body.replace(
      "globalThis.fetch=async u=>{u=String(u);",
      `globalThis.fetch=async (u,{signal})=>{u=String(u);if(decodeURIComponent(u).includes('@pnpm/exe.')){${fail}}`,
    );
    await writeFile(preload, body);
    const before = await snapshot(dir);
    const result = run(dir, preload, [
      "--profile",
      "coding",
      "--dry-run",
      "--json",
      "--target",
      "darwin-arm64",
    ]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      JSON.stringify(JSON.parse(result.stdout).assets),
      mode === "timeout" ? /timed out/ : /native offline/,
    );
    assert.deepEqual(await snapshot(dir), before);
  });
test("asset-only metadata does not change version-only reports", async (t) => {
  const { dir, preload } = await codingNpmFixture(t, {
    pi: { os: "invalid" },
    dependencies: { "@pnpm/exe.darwin-arm64": 42 },
  });
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--json",
  ]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).components.length, 4);
});
test("unverified pnpm versions do not infer native layout", async (t) => {
  const { dir, preload } = await codingNpmFixture(t);
  let body = await readFile(preload, "utf8");
  body = body.replaceAll("12.15.0", "12.16.0");
  await writeFile(preload, body);
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(result.status, 1);
  assert.match(
    JSON.stringify(JSON.parse(result.stdout).assets),
    /native mapping is not verified/,
  );
});
