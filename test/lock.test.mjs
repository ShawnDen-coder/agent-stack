import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
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
  [
    "oversized metadata",
    "new Response('x'.repeat(13*1024*1024))",
    /size limit/,
  ],
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
  return `const opts=${JSON.stringify(overrides)};const hashes=${JSON.stringify(integrity)};globalThis.fetch=async u=>{u=String(u);if(u.startsWith('https://api.github.com/'))return new Response(JSON.stringify(opts.uv ?? [{id:1,tag_name:'0.13.8',html_url:'https://github.com/astral-sh/uv/releases/tag/0.13.8',draft:false,prerelease:false}]));if(u==='https://herdr.dev/latest.json')return new Response(${JSON.stringify(JSON.stringify(data))});const name=decodeURIComponent(u.split('/').pop()),version=name.startsWith('@pnpm/exe.')||name==='pnpm'?'12.15.0':'1.5.2';const deps={'@pnpm/exe.darwin-arm64':'12.15.0','@pnpm/exe.darwin-x64':'12.15.0','@pnpm/exe.win32-x64':'12.15.0'};let entry={name,version,dist:{tarball:'https://registry.npmjs.org/pkg.tgz',integrity:hashes}};if(name==='pnpm')entry.optionalDependencies={...deps,...(opts.dependencies||{})};if(name.startsWith('@pnpm/exe.')){const parts=name.split('.').pop().split('-');entry.os=[parts[0]];entry.cpu=[parts[1]];Object.assign(entry,opts.native||{});}if(name==='@earendil-works/pi-coding-agent')Object.assign(entry,opts.pi||{});return new Response(JSON.stringify({name,versions:{[version]:entry}}));};`;
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
    assert.match(
      a.find((x) => x.component === "uv").error,
      /assets are unavailable/,
    );
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
      assert.ok(compact.includes("ExpectedSHA-512SRI:"));
      assert.ok(compact.includes("ExpectedSHA-256:"));
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
test("pnpm 12.21 contract resolves native targets without a per-version whitelist", async (t) => {
  const { dir, preload } = await codingNpmFixture(t);
  let body = await readFile(preload, "utf8");
  body = body.replaceAll("12.15.0", "12.21.0");
  await writeFile(preload, body);
  const before = await snapshot(dir);
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(
    report.assets.find((x) => x.component === "pnpm" && x.role === "native")
      ?.identity,
    "@pnpm/exe.darwin-arm64@12.21.0",
  );
  assert.deepEqual(await snapshot(dir), before);
});

test("pnpm unknown major distribution series is blocked", async (t) => {
  const { dir, preload } = await codingNpmFixture(t);
  const body = await readFile(preload, "utf8");
  await writeFile(preload, body.replaceAll("12.15.0", "13.0.0"));
  const file = join(dir, "stack/profiles/coding.yaml");
  let profile = await readFile(file, "utf8");
  profile = profile.replace(">=12.15.0 <13", ">=13.0.0 <14");
  await writeFile(file, profile);
  const before = await snapshot(dir);
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    JSON.stringify(JSON.parse(result.stdout).assets),
    /Unsupported pnpm native distribution series/,
  );
  assert.deepEqual(await snapshot(dir), before);
});
for (const [label, override] of [
  ["empty os", { os: [] }],
  ["empty cpu", { cpu: [] }],
  ["ambiguous cpu", { cpu: ["arm64", "x64"] }],
])
  test(`pnpm native blocks ${label}`, async (t) => {
    const { dir, preload } = await codingNpmFixture(t, { native: override });
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
      /os\/cpu metadata/,
    );
  });
for (const [label, spec] of [
  ["alias", "npm:@pnpm/exe.darwin-arm64@12.21.0"],
  ["different version", "12.20.0"],
])
  test(`pnpm rejects ${label} optional dependency`, async (t) => {
    const { dir, preload } = await codingNpmFixture(t, {
      dependencies: { "@pnpm/exe.darwin-arm64": spec },
    });
    const before = await snapshot(dir);
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
      /unsupported exact native dependency/,
    );
    assert.deepEqual(await snapshot(dir), before);
  });
test("pnpm native rejects undeclared platform fields", async (t) => {
  const { dir, preload } = await codingNpmFixture(t);
  let body = await readFile(preload, "utf8");
  body = body.replace("entry.os=[parts[0]];entry.cpu=[parts[1]];", "");
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
    /os\/cpu metadata/,
  );
});
test("pnpm native rejects libc constraint on macOS", async (t) => {
  const { dir, preload } = await codingNpmFixture(t, {
    native: { libc: ["musl"] },
  });
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(result.status, 1);
  assert.match(JSON.stringify(JSON.parse(result.stdout).assets), /libc/);
});

const uvNames = [
  "uv-aarch64-apple-darwin.tar.gz",
  "uv-x86_64-apple-darwin.tar.gz",
  "uv-x86_64-pc-windows-msvc.zip",
];
function uvReleaseWithAssets() {
  return uvRelease("0.13.8", 1, {
    assets: uvNames.map((name, i) => ({
      id: 100 + i,
      name,
      state: "uploaded",
      browser_download_url: `https://github.com/astral-sh/uv/releases/download/0.13.8/${name}`,
      digest: `sha256:${assetHash}`,
    })),
  });
}
async function uvAssetsFixture(t, release = uvReleaseWithAssets()) {
  return codingNpmFixture(t, { uv: [release] });
}
test("full coding resolves all target assets from selected release without writing", async (t) => {
  const { dir, preload } = await uvAssetsFixture(t);
  await writeFile(join(dir, "stack/stack.lock.json"), "unchanged\n");
  const before = await snapshot(dir);
  const r = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--json",
    "--target",
    "win32-x64",
    "--target",
    "darwin-x64",
    "--target",
    "darwin-arm64",
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.kind, "resolution-report");
  assert.equal(report.assets.length, 15);
  assert.equal(report.assets.filter((x) => x.error).length, 0);
  for (const [i, target] of [
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
  ].entries()) {
    const item = report.assets.find(
      (x) => x.component === "uv" && x.target === target,
    );
    assert.equal(item.sha256, assetHash);
    assert.equal(
      item.url,
      uvReleaseWithAssets().assets[i].browser_download_url,
    );
    assert.equal(item.format, i === 2 ? "zip" : "tar.gz");
    assert.match(item.identity, new RegExp(`asset ${100 + i}`));
  }
  assert.deepEqual(await snapshot(dir), before);
});
for (const [label, mutate, pattern] of [
  ["missing", (r) => r.assets.shift(), /Missing or duplicate/],
  [
    "duplicate",
    (r) => r.assets.push({ ...r.assets[0] }),
    /Missing or duplicate/,
  ],
  [
    "duplicate id",
    (r) => (r.assets[1].id = r.assets[0].id),
    /Duplicate uv asset identity/,
  ],
  [
    "wrong tag URL",
    (r) =>
      (r.assets[0].browser_download_url =
        r.assets[0].browser_download_url.replace("/0.13.8/", "/0.13.7/")),
    /version-mismatched/,
  ],
  [
    "foreign host",
    (r) => (r.assets[0].browser_download_url = "https://evil.test/archive"),
    /Untrusted/,
  ],
  ["absent digest", (r) => delete r.assets[0].digest, /digest/],
  [
    "wrong algorithm",
    (r) => (r.assets[0].digest = `sha512:${assetHash}`),
    /invalid SHA-256/,
  ],
  [
    "bad digest",
    (r) => (r.assets[0].digest = "sha256:nope"),
    /invalid SHA-256/,
  ],
  ["not uploaded", (r) => (r.assets[0].state = "new"), /uploaded/],
  ["invalid release id", (r) => (r.id = 0), /id/],
  [
    "invalid release tag",
    (r) => (r.html_url = "https://github.com/other/uv/releases/tag/0.13.8"),
    /Invalid uv release identity/,
  ],
])
  test(`uv target rejects ${label}`, async (t) => {
    const release = uvReleaseWithAssets();
    mutate(release);
    const { dir, preload } = await uvAssetsFixture(t, release);
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
    assert.match(JSON.stringify(JSON.parse(r.stdout)), pattern);
    assert.deepEqual(await snapshot(dir), before);
  });
test("uv version-only ignores unrelated malformed assets", async (t) => {
  const release = uvReleaseWithAssets();
  release.assets = [{ name: "unrelated" }];
  const { dir, preload } = await uvAssetsFixture(t, release);
  const r = run(dir, preload, ["--profile", "coding", "--dry-run", "--json"]);
  assert.equal(r.status, 0, r.stdout);
});
test("uv target never falls back from selected release with missing assets", async (t) => {
  const newer = uvRelease("0.13.9", 2, { assets: [] });
  const older = uvReleaseWithAssets();
  const { dir, preload } = await codingNpmFixture(t, { uv: [older, newer] });
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--json",
    "--target",
    "darwin-arm64",
  ]);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(
    report.components.find((x) => x.component === "uv").version,
    "0.13.9",
  );
  assert.match(
    report.assets.find((x) => x.component === "uv").error,
    /Missing or duplicate/,
  );
});
for (const [columns, color] of [
  [40, "no-color"],
  [40, "color"],
  [80, "no-color"],
  [80, "color"],
])
  test(`uv mixed assets fit ${columns} column ${color} PTY`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const { dir, preload } = await uvAssetsFixture(t);
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
    assert.equal(out.status, 0, out.stderr);
    const { stripVTControlCharacters } = await import("node:util");
    const width = (await import("fast-string-width")).default;
    const text = stripVTControlCharacters(out.stdout);
    for (const line of text.split(/\r?\n/))
      assert.ok(width(line) <= columns, line);
    const compact = text.replace(/\s/g, "");
    assert.ok(compact.includes(integrity));
    assert.ok(compact.includes(assetHash));
    assert.ok(
      compact.includes(uvReleaseWithAssets().assets[0].browser_download_url),
    );
    assert.doesNotMatch(out.stdout, /Choose a profile/);
  });
test("uv release query aborts on target preview Ctrl-C", {
  skip: process.platform === "win32",
}, async (t) => {
  const { dir, preload } = await uvAssetsFixture(t);
  const marker = join(dir, "probe.pid"),
    aborted = join(dir, "aborted");
  let body = await readFile(preload, "utf8");
  body =
    `import {writeFileSync} from 'node:fs';` +
    body.replace(
      "globalThis.fetch=async u=>{u=String(u);",
      `globalThis.fetch=async (u,{signal})=>{u=String(u);if(u.startsWith('https://api.github.com/'))return new Promise((_,reject)=>{writeFileSync(${JSON.stringify(marker)},'start');const timer=setInterval(()=>{},1000);signal.addEventListener('abort',()=>{clearInterval(timer);writeFileSync(${JSON.stringify(aborted)},'yes');reject(signal.reason)})});`,
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

test("coding reports structured source and asset identities for all targets", async (t) => {
  const { dir, preload } = await uvAssetsFixture(t);
  await writeFile(join(dir, "stack/stack.lock.json"), "sentinel\n");
  const before = await snapshot(dir);
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--dry-run",
    "--json",
    "--target",
    "darwin-arm64",
    "--target",
    "darwin-x64",
    "--target",
    "win32-x64",
  ]);
  assert.equal(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  const component = (id) => report.components.find((x) => x.component === id);
  assert.deepEqual(component("pi").source, {
    type: "npm",
    registry: "https://registry.npmjs.org",
    package: "@earendil-works/pi-coding-agent",
  });
  assert.deepEqual(component("pnpm").source, {
    type: "npm",
    registry: "https://registry.npmjs.org",
    package: "pnpm",
  });
  assert.deepEqual(component("uv").source, {
    type: "github-release",
    owner: "astral-sh",
    repo: "uv",
    releaseId: 1,
    tag: "0.13.8",
  });
  assert.deepEqual(component("herdr").source, {
    type: "channel-manifest",
    manifest: "https://herdr.dev/latest.json",
    channel: "stable",
    version: "0.9.5",
  });
  assert.equal(report.assets.length, 15);
  for (const target of report.targets) {
    const items = report.assets.filter((x) => x.target === target);
    const pi = items.find((x) => x.component === "pi");
    assert.equal(pi.packageName, component("pi").package);
    assert.equal(pi.packageVersion, component("pi").version);
    const native = items.find(
      (x) => x.component === "pnpm" && x.role === "native",
    );
    assert.equal(native.packageVersion, component("pnpm").version);
    assert.equal(native.packageName, `@pnpm/exe.${target}`);
    const uv = items.find((x) => x.component === "uv");
    assert.equal(uv.releaseId, 1);
    assert.equal(typeof uv.assetId, "number");
    assert.ok(uv.assetName.startsWith("uv-"));
    const herdr = items.find((x) => x.component === "herdr");
    assert.ok(
      herdr.assetKey.startsWith(
        target.startsWith("win32") ? "windows-" : "macos-",
      ),
    );
    assert.equal(herdr.assetName, herdr.identity);
  }
  assert.equal(report.definitionDigests.algorithm, "sha256-canonical-json-v1");
  assert.deepEqual(Object.keys(report.definitionDigests.components), [
    "herdr",
    "pi",
    "pnpm",
    "uv",
  ]);
  assert.deepEqual(Object.keys(report.definitionDigests.integrations), [
    "pi-herdr",
  ]);
  assert.deepEqual(await snapshot(dir), before);
});
test("definition digests follow selected canonical data, not format or repository path", async (t) => {
  const a = await uvAssetsFixture(t);
  const b = await uvAssetsFixture(t);
  const args = ["--profile", "coding", "--dry-run", "--json"];
  const first = run(a.dir, a.preload, args);
  assert.equal(first.status, 0, first.stdout);
  const initial = JSON.parse(first.stdout).definitionDigests;
  const { parse, stringify } = await import("yaml");
  const original = join(b.dir, "stack/components/pi.yaml");
  const value = parse(await readFile(original, "utf8"));
  await rm(original);
  await writeFile(
    join(b.dir, "stack/components/pi.json"),
    JSON.stringify(
      Object.fromEntries(Object.entries(value).reverse()),
      null,
      4,
    ),
  );
  const profile = join(b.dir, "stack/profiles/coding.yaml");
  await writeFile(
    profile,
    "# equivalent comment\n" +
      stringify(parse(await readFile(profile, "utf8")), { indent: 4 }),
  );
  const second = run(b.dir, b.preload, args);
  assert.equal(second.status, 0, second.stdout);
  assert.deepEqual(JSON.parse(second.stdout).definitionDigests, initial);
  const unrelated = join(b.dir, "stack/components/otty.yaml");
  const text = await readFile(unrelated, "utf8");
  await writeFile(
    unrelated,
    text.replace("description:", "description: unrelated "),
  );
  const third = run(b.dir, b.preload, args);
  assert.equal(third.status, 0, third.stdout);
  assert.deepEqual(JSON.parse(third.stdout).definitionDigests, initial);
  value.description += " changed";
  await writeFile(
    join(b.dir, "stack/components/pi.json"),
    JSON.stringify(value),
  );
  const fourth = run(b.dir, b.preload, args);
  assert.equal(fourth.status, 0, fourth.stdout);
  const changed = JSON.parse(fourth.stdout).definitionDigests;
  assert.notEqual(changed.components.pi, initial.components.pi);
  assert.equal(changed.profile, initial.profile);
  assert.equal(
    changed.integrations["pi-herdr"],
    initial.integrations["pi-herdr"],
  );
});

test("fresh shared lock is deterministic and never overwrites existing files", async (t) => {
  const a = await uvAssetsFixture(t);
  const b = await uvAssetsFixture(t);
  const args = [
    "--profile",
    "coding",
    "--target",
    "win32-x64",
    "--target",
    "darwin-arm64",
    "--target",
    "darwin-x64",
    "--json",
  ];
  const first = run(a.dir, a.preload, args);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(JSON.parse(first.stdout).kind, "shared-lock-created");
  const file = join(a.dir, "stack/stack.lock.json");
  const bytes = await readFile(file, "utf8");
  const lock = JSON.parse(bytes);
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.profile, "coding");
  assert.equal(lock.components.length, 4);
  assert.equal(lock.assets.length, 15);
  assert.deepEqual(
    lock.targets.map((item) => item.id),
    ["darwin-arm64", "darwin-x64", "win32-x64"],
  );
  assert.ok(
    lock.assets.every(
      (item) => item.artifact && item.digest && item.digestSource,
    ),
  );
  const second = run(b.dir, b.preload, args);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(
    await readFile(join(b.dir, "stack/stack.lock.json"), "utf8"),
    bytes,
  );
  const duplicate = run(a.dir, a.preload, args);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stdout, /already exists/);
  assert.equal(await readFile(file, "utf8"), bytes);
});

test("fresh --out is independent and rejects misuse and existing destinations", async (t) => {
  const { dir, preload } = await uvAssetsFixture(t);
  const out = join(dir, "candidate.json");
  const args = [
    "--profile",
    "coding",
    "--target",
    "darwin-arm64",
    "--out",
    out,
    "--json",
  ];
  const result = run(dir, preload, args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(await readFile(out, "utf8")).assets.length, 5);
  assert.equal(run(dir, preload, args).status, 1);
  assert.equal(run(dir, preload, [...args, "--dry-run"]).status, 2);
  assert.equal(run(dir, preload, ["--profile", "coding", "--json"]).status, 2);
  await assert.rejects(readFile(join(dir, "stack/stack.lock.json")), {
    code: "ENOENT",
  });
});

test("fresh lock rejects changed selected metadata and definitions", async (t) => {
  for (const change of ["metadata", "definition"]) {
    const { dir, preload } = await uvAssetsFixture(t);
    let body = await readFile(preload, "utf8");
    if (change === "metadata") {
      body = `let requests=0;${body}`.replace(
        "if(u==='https://herdr.dev/latest.json')return new Response(",
        "if(u==='https://herdr.dev/latest.json' && ++requests > 1) return new Response('{}');if(u==='https://herdr.dev/latest.json')return new Response(",
      );
    } else {
      const path = JSON.stringify(join(dir, "stack/profiles/coding.yaml"));
      body =
        `import {readFileSync,writeFileSync} from 'node:fs';let requests=0;${body}`.replace(
          "if(u==='https://herdr.dev/latest.json')return new Response(",
          `if(u==='https://herdr.dev/latest.json' && ++requests > 1) writeFileSync(${path},readFileSync(${path},'utf8').replace('Terminal coding','Altered coding'));if(u==='https://herdr.dev/latest.json')return new Response(`,
        );
    }
    await writeFile(preload, body);
    const result = run(dir, preload, [
      "--profile",
      "coding",
      "--target",
      "darwin-arm64",
      "--json",
    ]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    if (change === "definition")
      assert.match(result.stdout, /Selected definitions changed/);
    await assert.rejects(readFile(join(dir, "stack/stack.lock.json")), {
      code: "ENOENT",
    });
  }
});

test("fresh lock rejects dangling symlinks and only one concurrent writer publishes", async (t) => {
  const { dir, preload } = await uvAssetsFixture(t);
  const dest = join(dir, "candidate.json");
  if (process.platform !== "win32") await symlink(join(dir, "missing"), dest);
  const args = [
    "--profile",
    "coding",
    "--target",
    "darwin-arm64",
    "--out",
    dest,
    "--json",
  ];
  if (process.platform !== "win32") {
    assert.equal(run(dir, preload, args).status, 1);
    await rm(dest);
  }
  const child = () =>
    new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [
        "--import",
        preload,
        cli,
        "lock",
        "--repo",
        dir,
        ...args,
      ]);
      let output = "";
      proc.stdout.on("data", (chunk) => {
        output += chunk;
      });
      proc.stderr.on("data", (chunk) => {
        output += chunk;
      });
      proc.on("error", reject);
      proc.on("close", (status) => resolve({ status, output }));
    });
  const results = await Promise.all([child(), child()]);
  assert.deepEqual(
    results.map((x) => x.status).sort(),
    [0, 1],
    JSON.stringify(results),
  );
  assert.equal(JSON.parse(await readFile(dest, "utf8")).assets.length, 5);
  assert.ok(!(await readdir(dir)).some((name) => name.endsWith(".tmp")));
});

test("fresh creation aborts recheck and leaves no published or temporary file", {
  skip: process.platform === "win32",
}, async (t) => {
  const { dir, preload } = await uvAssetsFixture(t);
  const marker = join(dir, "rechecking");
  let body = await readFile(preload, "utf8");
  body = `import {writeFileSync} from 'node:fs';let count=0;${body}`
    .replace(
      "globalThis.fetch=async u=>",
      "globalThis.fetch=async (u,{signal})=>",
    )
    .replace(
      "if(u==='https://herdr.dev/latest.json')return new Response(",
      `if(u==='https://herdr.dev/latest.json' && ++count>1){writeFileSync(${JSON.stringify(marker)},'yes');return new Promise((_,reject)=>{const timer=setInterval(()=>{},1000);signal.addEventListener('abort',()=>{clearInterval(timer);reject(signal.reason)})})}if(u==='https://herdr.dev/latest.json')return new Response(`,
    );
  await writeFile(preload, body);
  const proc = spawn(process.execPath, [
    "--import",
    preload,
    cli,
    "lock",
    "--repo",
    dir,
    "--profile",
    "coding",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  let output = "";
  proc.stdout.on("data", (chunk) => {
    output += chunk;
  });
  proc.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const completion = new Promise((resolve) => proc.on("close", resolve));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await readFile(marker);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  await readFile(marker);
  proc.kill("SIGINT");
  assert.equal(await completion, 130, output);
  await assert.rejects(readFile(join(dir, "stack/stack.lock.json")), {
    code: "ENOENT",
  });
  assert.ok(
    !(await readdir(join(dir, "stack"))).some((name) => name.endsWith(".tmp")),
  );
});

test("fresh creation refuses incomplete assets and an existing default lock even with --out", async (t) => {
  const broken = uvReleaseWithAssets();
  broken.assets.shift();
  const a = await uvAssetsFixture(t, broken);
  const result = run(a.dir, a.preload, [
    "--profile",
    "coding",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).kind, "resolution-report");
  await assert.rejects(readFile(join(a.dir, "stack/stack.lock.json")), {
    code: "ENOENT",
  });
  const b = await uvAssetsFixture(t);
  const input = join(b.dir, "stack/stack.lock.json");
  const out = join(b.dir, "candidate.json");
  await writeFile(input, "sentinel\n");
  assert.equal(
    run(b.dir, b.preload, [
      "--profile",
      "coding",
      "--target",
      "darwin-arm64",
      "--out",
      out,
      "--json",
    ]).status,
    1,
  );
  assert.equal(await readFile(input, "utf8"), "sentinel\n");
  await assert.rejects(readFile(out), { code: "ENOENT" });
});

for (const [columns, color] of [
  [40, "no-color"],
  [40, "color"],
  [80, "no-color"],
  [80, "color"],
])
  test(`fresh lock creation fits ${columns} column ${color} PTY`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const { dir, preload } = await uvAssetsFixture(t);
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
        "create",
        String(columns),
        color,
        preload,
        "darwin-arm64",
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, 0, out.stderr);
    const { stripVTControlCharacters } = await import("node:util");
    const width = (await import("fast-string-width")).default;
    const text = stripVTControlCharacters(out.stdout);
    for (const line of text.split(/\r?\n/))
      assert.ok(width(line) <= columns, line);
    assert.match(text, /CREATED/);
    assert.match(text, /Shared lock/);
    assert.doesNotMatch(out.stdout, /Rechecking selected metadata/);
    assert.equal(
      JSON.parse(await readFile(join(dir, "stack/stack.lock.json"), "utf8"))
        .assets.length,
      5,
    );
  });

test("fresh creation leaves no lock when output directory is missing", async (t) => {
  const { dir, preload } = await uvAssetsFixture(t);
  const out = join(dir, "missing", "candidate.json");
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--target",
    "darwin-arm64",
    "--out",
    out,
    "--json",
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  await assert.rejects(readFile(out), { code: "ENOENT" });
  await assert.rejects(readFile(join(dir, "stack/stack.lock.json")), {
    code: "ENOENT",
  });
});

function recheckOverride(code) {
  return `;{const original=globalThis.fetch;const counts=new Map();globalThis.fetch=async(u,o)=>{const url=String(u);const n=(counts.get(url)||0)+1;counts.set(url,n);const response=await original(u,o);if(n<2)return response;const data=await response.json();${code};return new Response(JSON.stringify(data));};}`;
}

test("fresh --out rejects empty and whitespace paths without writing", async (t) => {
  for (const value of ["", "   "])
    for (const dry of [false, true]) {
      const { dir, preload } = await uvAssetsFixture(t);
      const candidate = join(dir, "candidate.json");
      await writeFile(candidate, "sentinel\n");
      const before = await snapshot(dir);
      const result = run(dir, preload, [
        "--profile",
        "coding",
        "--target",
        "darwin-arm64",
        ...(dry ? ["--dry-run"] : []),
        "--out",
        value,
        "--json",
      ]);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).error.kind, "usage");
      assert.deepEqual(await snapshot(dir), before);
      assert.equal(await readFile(candidate, "utf8"), "sentinel\n");
      await assert.rejects(readFile(join(dir, "stack/stack.lock.json")), {
        code: "ENOENT",
      });
    }
});

test("fresh recheck rejects reuse of selected uv release ID under another tag", async (t) => {
  const { dir, preload } = await uvAssetsFixture(t);
  await writeFile(
    preload,
    (await readFile(preload, "utf8")) +
      recheckOverride(
        `if(url.startsWith('https://api.github.com/'))data.push({id:1,tag_name:'0.13.9',html_url:'https://github.com/astral-sh/uv/releases/tag/0.13.9',draft:false,prerelease:false})`,
      ),
  );
  const before = await snapshot(dir);
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(await snapshot(dir), before);
  await assert.rejects(readFile(join(dir, "stack/stack.lock.json")), {
    code: "ENOENT",
  });
});

for (const [label, code, expected] of [
  [
    "npm tarball",
    `if(decodeURIComponent(url).includes('@earendil-works/pi-coding-agent'))data.versions['1.5.2'].dist.tarball='https://registry.npmjs.org/changed.tgz'`,
    /npm asset changed/,
  ],
  [
    "npm engines",
    `if(decodeURIComponent(url).includes('@earendil-works/pi-coding-agent'))data.versions['1.5.2'].engines={node:'>=24.0.0'}`,
    /npm metadata changed/,
  ],
  [
    "pnpm native mapping",
    `if(url==='https://registry.npmjs.org/pnpm')data.versions['12.15.0'].optionalDependencies['@pnpm/exe.darwin-arm64']='12.15.1'`,
    /native|mapping/i,
  ],
  [
    "pnpm native integrity",
    `if(decodeURIComponent(url).includes('@pnpm/exe.darwin-arm64'))data.versions['12.15.0'].dist.integrity='sha512-'+Buffer.alloc(64,2).toString('base64')`,
    /native asset changed/,
  ],
  [
    "uv release id",
    `if(url.startsWith('https://api.github.com/'))data[0].id=2`,
    /uv release identity changed/,
  ],
  [
    "uv asset digest",
    `if(url.startsWith('https://api.github.com/'))data[0].assets[0].digest='sha256:'+'b'.repeat(64)`,
    /uv asset changed/,
  ],
  [
    "herdr stable version",
    `if(url==='https://herdr.dev/latest.json')data.version='0.9.6'`,
    /herdr stable version changed/,
  ],
  [
    "herdr asset hash",
    `if(url==='https://herdr.dev/latest.json')data.sha256['macos-aarch64']='b'.repeat(64)`,
    /herdr asset changed/,
  ],
  [
    "release HTTP limit",
    `if(url.startsWith('https://api.github.com/'))return new Response('{}',{status:429})`,
    /429/,
  ],
])
  test(`fresh recheck rejects changed ${label}`, async (t) => {
    const { dir, preload } = await uvAssetsFixture(t);
    await writeFile(
      preload,
      (await readFile(preload, "utf8")) + recheckOverride(code),
    );
    const before = await snapshot(dir);
    const result = run(dir, preload, [
      "--profile",
      "coding",
      "--target",
      "darwin-arm64",
      "--json",
    ]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(JSON.parse(result.stdout).error, expected);
    assert.deepEqual(await snapshot(dir), before);
    assert.ok(
      !(await readdir(join(dir, "stack"))).some((name) =>
        name.endsWith(".tmp"),
      ),
    );
  });

test("fresh recheck ignores unrelated new releases, history and timestamps", async (t) => {
  const { dir, preload } = await uvAssetsFixture(t);
  await writeFile(
    preload,
    (await readFile(preload, "utf8")) +
      recheckOverride(
        `if(url.startsWith('https://api.github.com/')){data[0].updated_at='changed';data.push({id:42,tag_name:'0.99.0',html_url:'https://github.com/astral-sh/uv/releases/tag/0.99.0',draft:false,prerelease:false})}else if(url.startsWith('https://registry.npmjs.org/')){data.time={modified:'changed'};data.versions['0.1.0']={}}else if(url==='https://herdr.dev/latest.json')data.timestamp='changed'`,
      ),
  );
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lock = JSON.parse(
    await readFile(join(dir, "stack/stack.lock.json"), "utf8"),
  );
  assert.equal(
    lock.components.find((item) => item.component === "uv").version,
    "0.13.8",
  );
});

test("uv accepts a bounded official page larger than the former 4 MiB limit", async (t) => {
  const { dir, preload } = await codingNpmFixture(t);
  const body = await readFile(preload, "utf8");
  await writeFile(
    preload,
    body
      .replace(
        "return new Response(JSON.stringify(opts.uv ??",
        "return new Response(JSON.stringify(opts.uv ??",
      )
      .replace(
        "[{id:1,tag_name:'0.13.8'",
        "[{padding:'x'.repeat(5*1024*1024),id:1,tag_name:'0.13.8'",
      ),
  );
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
});

test("uv follows official numeric repository pagination", async (t) => {
  const body = mixedPreload(
    [uvRelease("0.13.8", 1)],
    [uvRelease("0.13.9", 2)],
    { version: "0.9.5" },
  ).replace(
    "https://api.github.com/repos/astral-sh/uv/releases?per_page=100&page=2",
    "https://api.github.com/repositories/699532645/releases?per_page=100&page=2",
  );
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
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    JSON.parse(result.stdout).components.find((x) => x.component === "uv")
      .version,
    "0.13.9",
  );
});

function pagedUvFixture(code) {
  const body = npmAssetPreload({ uv: [uvReleaseWithAssets()] });
  const start = body.indexOf("if(u.startsWith('https://api.github.com/'))");
  const end = body.indexOf("if(u==='https://herdr.dev/latest.json')", start);
  assert.ok(start > 0 && end > start);
  return `${body.slice(0, start)}if(u.startsWith('https://api.github.com/')){${code}}${body.slice(end)}`;
}
for (const [label, link] of [
  [
    "foreign numeric repo",
    "https://api.github.com/repositories/699532646/releases?per_page=100&page=2",
  ],
  [
    "foreign host",
    "https://evil.example/repositories/699532645/releases?per_page=100&page=2",
  ],
  [
    "wrong page",
    "https://api.github.com/repositories/699532645/releases?per_page=100&page=3",
  ],
  [
    "extra parameter",
    "https://api.github.com/repositories/699532645/releases?per_page=100&page=2&token=bad",
  ],
  [
    "credentials",
    "https://user@api.github.com/repositories/699532645/releases?per_page=100&page=2",
  ],
])
  test(`uv rejects ${label} pagination before fresh publication`, async (t) => {
    const body = pagedUvFixture(
      `return new Response('[]',{headers:{link:${JSON.stringify(`<${link}>; rel="next"`)}}})`,
    );
    const { dir, preload } = await setup(t, null, body);
    await cp(
      join(repo, "stack/profiles/coding.yaml"),
      join(dir, "stack/profiles/coding.yaml"),
    );
    const before = await snapshot(dir);
    const result = run(dir, preload, [
      "--profile",
      "coding",
      "--target",
      "darwin-arm64",
      "--json",
    ]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Untrusted release pagination/);
    assert.deepEqual(await snapshot(dir), before);
  });
for (const [label, padding, expected] of [
  ["total size", 11 * 1024 * 1024, /total size limit/],
  ["page count", 0, /excessive release pagination/],
])
  test(`uv enforces bounded ${label} before fresh publication`, async (t) => {
    const release = JSON.stringify(uvReleaseWithAssets());
    const body = pagedUvFixture(
      `const page=Number(new URL(u).searchParams.get('page'));const entry=${release};entry.id=page;entry.tag_name='0.13.'+(page+10);entry.html_url='https://github.com/astral-sh/uv/releases/tag/'+entry.tag_name;entry.padding='x'.repeat(${padding});return new Response(JSON.stringify([entry]),{headers:{link:'<https://api.github.com/repositories/699532645/releases?per_page=100&page='+(page+1)+'>; rel="next"'}})`,
    );
    const { dir, preload } = await setup(t, null, body);
    await cp(
      join(repo, "stack/profiles/coding.yaml"),
      join(dir, "stack/profiles/coding.yaml"),
    );
    const before = await snapshot(dir);
    const result = run(dir, preload, [
      "--profile",
      "coding",
      "--target",
      "darwin-arm64",
      "--json",
    ]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, expected);
    assert.deepEqual(await snapshot(dir), before);
  });

test("oversized uv page blocks fresh lock without writing", async (t) => {
  const body = pagedUvFixture("return new Response('x'.repeat(13*1024*1024))");
  const { dir, preload } = await setup(t, null, body);
  await cp(
    join(repo, "stack/profiles/coding.yaml"),
    join(dir, "stack/profiles/coding.yaml"),
  );
  const before = await snapshot(dir);
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /size limit/);
  assert.deepEqual(await snapshot(dir), before);
});

async function freshForValidation(t) {
  const { dir, preload } = await uvAssetsFixture(t);
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--target",
    "darwin-arm64",
    "--target",
    "darwin-x64",
    "--target",
    "win32-x64",
    "--json",
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const path = join(dir, "stack/stack.lock.json");
  const lock = JSON.parse(await readFile(path, "utf8"));
  const offline = join(dir, "offline.mjs");
  await writeFile(
    offline,
    "globalThis.fetch=()=>{throw Error('network forbidden')}",
  );
  return { dir, path, lock, offline };
}
function validateOffline(f, args = []) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      f.offline,
      cli,
      "validate",
      "--repo",
      f.dir,
      ...args,
      "--json",
    ],
    { encoding: "utf8", env: { PATH: "", NO_COLOR: "1" }, timeout: 12000 },
  );
}
test("validate reads fresh locks offline and keeps original output without --lock", async (t) => {
  const f = await freshForValidation(t);
  const before = await snapshot(f.dir);
  for (const args of [["--lock"], ["--lock", f.path]]) {
    const r = validateOffline(f, args);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.valid, true);
    assert.deepEqual(report.checked.lock, {
      profile: "coding",
      targets: 3,
      assets: 15,
    });
  }
  assert.equal("lock" in JSON.parse(validateOffline(f).stdout).checked, false);
  for (const value of ["", "  "])
    assert.equal(validateOffline(f, ["--lock", value]).status, 2);
  assert.deepEqual(await snapshot(f.dir), before);
});
for (const [label, mutate] of [
  [
    "schema version",
    (x) => {
      x.schemaVersion = 9;
    },
  ],
  [
    "node",
    (x) => {
      x.node = "current";
    },
  ],
  [
    "version",
    (x) => {
      x.components.find((c) => c.component === "pi").version = "999.0.0";
    },
  ],
  [
    "digest syntax",
    (x) => {
      x.assets[0].digest.value = "bad";
    },
  ],
  [
    "source",
    (x) => {
      x.components.find((c) => c.component === "pi").source.package = "other";
    },
  ],
  [
    "target mismatch",
    (x) => {
      x.targets[0].arch = "x64";
    },
  ],
  [
    "duplicate target",
    (x) => {
      x.targets.push(x.targets[0]);
    },
  ],
  [
    "uv release id",
    (x) => {
      x.assets.find((a) => a.component === "uv").artifact.releaseId = 99;
    },
  ],
  [
    "uv asset name",
    (x) => {
      x.assets.find((a) => a.component === "uv").artifact.assetName = "other";
    },
  ],
  [
    "role",
    (x) => {
      x.assets.find((a) => a.component === "pnpm").artifact.role = "bad";
    },
  ],
  [
    "duplicate asset",
    (x) => {
      x.assets.push(x.assets[0]);
    },
  ],
  [
    "missing asset",
    (x) => {
      x.assets.pop();
    },
  ],
  [
    "extra asset",
    (x) => {
      x.assets.push({ ...x.assets[0], target: "unknown" });
    },
  ],
  [
    "asset url credential",
    (x) => {
      x.assets[0].url = "https://user:pass@github.com/file";
    },
  ],
  [
    "definition digest",
    (x) => {
      x.definitionDigests.profile = "0".repeat(64);
    },
  ],
  [
    "integration set",
    (x) => {
      x.integrations = [];
    },
  ],
  [
    "conflicting npm evidence",
    (x) => {
      x.assets.find(
        (a) => a.component === "pi" && a.target === "darwin-x64",
      ).digest.value = `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
    },
  ],
])
  test(`validate rejects tampered lock ${label}`, async (t) => {
    const f = await freshForValidation(t);
    mutate(f.lock);
    await writeFile(f.path, JSON.stringify(f.lock));
    const before = await snapshot(f.dir);
    const r = validateOffline(f, ["--lock"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.valid, false);
    const reason = report.issues.find((x) => x.file === "lock")?.message ?? "";
    const reasons = {
      "schema version": /schema/i,
      node: /Node/,
      version: /version/i,
      "digest syntax": /SHA-256/,
      source: /source/i,
      "target mismatch": /target identity/i,
      "duplicate target": /Duplicate lock target/,
      "uv release id": /uv release identity/,
      "uv asset name": /uv asset/,
      role: /schema/i,
      "duplicate asset": /Duplicate asset/,
      "missing asset": /Missing (pnpm native )?asset/,
      "extra asset": /unknown component or target/,
      "asset url credential": /Untrusted/,
      "definition digest": /digests/,
      "integration set": /integration set/,
      "conflicting npm evidence": /Conflicting npm asset evidence/,
    };
    assert.match(reason, reasons[label]);
    assert.doesNotMatch(r.stdout, /user:pass/);
    assert.deepEqual(await snapshot(f.dir), before);
  });

test("validate lock handles missing, malformed and oversized files without exposing content", async (t) => {
  const f = await freshForValidation(t);
  await rm(f.path);
  assert.equal(validateOffline(f, ["--lock"]).status, 1);
  for (const data of [
    '{"secret":"secret-marker"',
    "x".repeat(1024 * 1024 + 1),
  ]) {
    await writeFile(f.path, data);
    const r = validateOffline(f, ["--lock"]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /secret-marker/);
  }
});
test("validate lock follows semantic declarations across formats and repository paths", async (t) => {
  const f = await freshForValidation(t);
  const { parse } = await import("yaml");
  const profilePath = join(f.dir, "stack/profiles/coding.yaml");
  const original = await readFile(profilePath, "utf8");
  const fixturePath = join(f.dir, "stack/components/fixture.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  fixture.description = "unselected changed";
  await writeFile(fixturePath, JSON.stringify(fixture));
  await rm(profilePath);
  await writeFile(
    join(f.dir, "stack/profiles/coding.json"),
    JSON.stringify(parse(original), null, 2),
  );
  assert.equal(validateOffline(f, ["--lock"]).status, 0);
  const moved = await mkdtemp(join(tmpdir(), "moved 配置 & "));
  t.after(() => rm(moved, { recursive: true, force: true }));
  await cp(join(f.dir, "stack"), join(moved, "stack"), { recursive: true });
  assert.equal(validateOffline({ ...f, dir: moved }, ["--lock"]).status, 0);
  const parsed = JSON.parse(
    await readFile(join(moved, "stack/profiles/coding.json"), "utf8"),
  );
  parsed.description = "semantic change";
  await writeFile(
    join(moved, "stack/profiles/coding.json"),
    JSON.stringify(parsed),
  );
  const changed = validateOffline({ ...f, dir: moved }, ["--lock"]);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /digests do not match/);
});

for (const [columns, color] of [
  [40, "no-color"],
  [40, "color"],
  [80, "no-color"],
  [80, "color"],
])
  test(`validate lock human report fits ${columns} columns ${color}`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const f = await freshForValidation(t);
    const driver = `import os,sys,pty,fcntl,termios,struct,subprocess,json,errno\nmaster,slave=pty.openpty()\nfcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,int(sys.argv[5]),0,0))\np=subprocess.Popen([sys.argv[1],'--import',sys.argv[4],sys.argv[2],'validate','--repo',sys.argv[3],'--lock'],stdin=subprocess.DEVNULL,stdout=slave,stderr=subprocess.PIPE,env=({'PATH':'','NO_COLOR':'1','TERM':'xterm'} if sys.argv[6]=='no-color' else {'PATH':'','FORCE_COLOR':'3','TERM':'xterm'}))\nos.close(slave)\ndata=b''\nwhile True:\n try:\n  chunk=os.read(master,65536)\n  if not chunk: break\n  data+=chunk\n except OSError as e:\n  if e.errno==errno.EIO: break\n  raise\nos.close(master)\nprint(json.dumps({'status':p.wait(),'stdout':data.decode(),'stderr':p.stderr.read().decode()}))`;
    const result = spawnSync(
      "python3",
      [
        "-c",
        driver,
        process.execPath,
        cli,
        f.dir,
        f.offline,
        String(columns),
        color,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 0, output.stderr);
    const { stripVTControlCharacters } = await import("node:util");
    const width = (await import("fast-string-width")).default;
    const text = stripVTControlCharacters(output.stdout);
    for (const line of text.split(/\r?\n/))
      assert.ok(width(line) <= columns, line);
    assert.match(text, /Lock:/);
    assert.match(text, /Definitions:/);
    assert.equal(
      output.stdout.includes(String.fromCharCode(27)),
      color === "color",
    );
  });

test("validate lock uses the locked Node assumption and root shared options", async (t) => {
  const f = await freshForValidation(t);
  f.lock.node = "20.0.0";
  await writeFile(f.path, JSON.stringify(f.lock));
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      f.offline,
      cli,
      "--repo",
      f.dir,
      "--json",
      "validate",
      "--lock",
    ],
    { encoding: "utf8", env: { PATH: "", NO_COLOR: "1" }, timeout: 12000 },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).valid, true);
});
for (const [label, mutate, reason] of [
  [
    "digest algorithm",
    (x) => {
      x.definitionDigests.algorithm = "other";
    },
    /schema/,
  ],
  [
    "missing profile",
    (x) => {
      x.profile = "nonexistent";
    },
    /profile is missing/,
  ],
  [
    "npm integrity",
    (x) => {
      x.assets.find((a) => a.component === "pi").digest.value = "sha512-nope";
    },
    /SHA512/,
  ],
  [
    "uv repeated asset id",
    (x) => {
      const a = x.assets.filter((i) => i.component === "uv");
      a[1].artifact.assetId = a[0].artifact.assetId;
    },
    /Duplicate uv asset identity/,
  ],
  [
    "pnpm native version",
    (x) => {
      x.assets.find(
        (a) => a.component === "pnpm" && a.artifact.role === "native",
      ).artifact.packageVersion = "1.0.0";
    },
    /package identity/,
  ],
])
  test(`validate rejects ${label}`, async (t) => {
    const f = await freshForValidation(t);
    mutate(f.lock);
    await writeFile(f.path, JSON.stringify(f.lock));
    const r = validateOffline(f, ["--lock"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(JSON.parse(r.stdout).issues[0].message, reason);
  });

test("validate accepts a profile-authorized npm prerelease selected by fresh lock", async (t) => {
  const { dir, preload } = await uvAssetsFixture(t);
  const profile = join(dir, "stack/profiles/coding.yaml");
  await writeFile(
    profile,
    (await readFile(profile, "utf8")).replace(
      ">=1.5.2 <2",
      ">=1.6.0-beta.1 <2",
    ),
  );
  await writeFile(
    preload,
    (await readFile(preload, "utf8")).replace(":'1.5.2';", ":'1.6.0-beta.1';"),
  );
  const created = run(dir, preload, [
    "--profile",
    "coding",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const offline = join(dir, "offline.mjs");
  await writeFile(
    offline,
    "globalThis.fetch=()=>{throw Error('network forbidden')}",
  );
  const result = validateOffline({ dir, offline }, ["--lock"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("validate lock rejects a FIFO without blocking", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await freshForValidation(t);
  const fifo = join(f.dir, "lock.fifo");
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 3000 });
  assert.equal(made.status, 0, made.stderr);
  const r = validateOffline(f, ["--lock", fifo]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(JSON.parse(r.stdout).issues[0].message, /regular file/);
});

test("SIGINT after lock publication does not report cancellation", {
  skip: process.platform === "win32",
}, async (t) => {
  const { dir, preload } = await uvAssetsFixture(t);
  const marker = join(dir, "link-signal");
  const hook = `\nimport fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const originalLink=fs.promises.link;fs.promises.link=async(...args)=>{await originalLink(...args);fs.writeFileSync(${JSON.stringify(marker)},'sent');process.kill(process.pid,'SIGINT');await new Promise(resolve=>setImmediate(resolve));};syncBuiltinESMExports();\n`;
  await writeFile(preload, (await readFile(preload, "utf8")) + hook);
  const result = run(dir, preload, [
    "--profile",
    "coding",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(await readFile(marker, "utf8"), "sent");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).kind, "shared-lock-created");
  assert.equal(
    JSON.parse(await readFile(join(dir, "stack/stack.lock.json"), "utf8"))
      .assets.length,
    5,
  );
  assert.ok(
    !(await readdir(join(dir, "stack"))).some((name) => name.endsWith(".tmp")),
  );
});
