import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { stripVTControlCharacters } from "node:util";
import stringWidth from "fast-string-width";
import { create as createTar } from "tar";

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
      body += recheckOverride({ herdr: {} });
    } else {
      const path = JSON.stringify(join(dir, "stack/profiles/coding.yaml"));
      body += `;{const original=globalThis.fetch;let count=0;globalThis.fetch=async(u,o)=>{if(String(u)==='https://herdr.dev/latest.json' && ++count>1){const fs=await import('node:fs');fs.writeFileSync(${path},fs.readFileSync(${path},'utf8').replace('Terminal coding','Altered coding'))}return original(u,o)}}`;
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
  body += `;{const original=globalThis.fetch;let count=0;globalThis.fetch=async(u,o)=>{if(String(u)==='https://herdr.dev/latest.json' && ++count>1){const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'yes');return new Promise((_,reject)=>{const timer=setInterval(()=>{},1000);o.signal.addEventListener('abort',()=>{clearInterval(timer);reject(o.signal.reason)})})}return original(u,o)}}`;
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

const fixtureUrls = {
  pi: `https://registry.npmjs.org/${encodeURIComponent("@earendil-works/pi-coding-agent")}`,
  pnpm: "https://registry.npmjs.org/pnpm",
  native: `https://registry.npmjs.org/${encodeURIComponent("@pnpm/exe.darwin-arm64")}`,
  uv: "https://api.github.com/repos/astral-sh/uv/releases?per_page=100&page=1",
  herdr: "https://herdr.dev/latest.json",
};
function recheckSnapshots() {
  const packument = (name, version, extra = {}) => ({
    name,
    versions: {
      [version]: {
        name,
        version,
        dist: { tarball: "https://registry.npmjs.org/pkg.tgz", integrity },
        ...extra,
      },
    },
  });
  return {
    pi: packument("@earendil-works/pi-coding-agent", "1.5.2"),
    pnpm: packument("pnpm", "12.15.0", {
      optionalDependencies: {
        "@pnpm/exe.darwin-arm64": "12.15.0",
        "@pnpm/exe.darwin-x64": "12.15.0",
        "@pnpm/exe.win32-x64": "12.15.0",
      },
    }),
    native: packument("@pnpm/exe.darwin-arm64", "12.15.0", {
      os: ["darwin"],
      cpu: ["arm64"],
    }),
    uv: [uvReleaseWithAssets()],
    herdr: herdrAssetManifest(),
  };
}
function recheckOverride(snapshots, statuses = {}) {
  const responses = Object.fromEntries(
    Object.entries(snapshots).map(([key, data]) => [
      fixtureUrls[key],
      { data, status: statuses[key] ?? 200 },
    ]),
  );
  return `;{const original=globalThis.fetch;const counts=new Map();const responses=${JSON.stringify(responses)};globalThis.fetch=async(u,o)=>{const url=String(u);const n=(counts.get(url)||0)+1;counts.set(url,n);const entry=responses[url];if(n>1 && entry)return new Response(JSON.stringify(entry.data),{status:entry.status});return original(u,o)};}`;
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
  const snapshots = recheckSnapshots();
  snapshots.uv.push(uvRelease("0.13.9", 1));
  await writeFile(
    preload,
    (await readFile(preload, "utf8")) + recheckOverride({ uv: snapshots.uv }),
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
for (const [label, source, mutate, expected, status] of [
  [
    "npm tarball",
    "pi",
    (x) => {
      x.versions["1.5.2"].dist.tarball =
        "https://registry.npmjs.org/changed.tgz";
    },
    /npm asset changed/,
  ],
  [
    "npm engines",
    "pi",
    (x) => {
      x.versions["1.5.2"].engines = { node: ">=24.0.0" };
    },
    /npm metadata changed/,
  ],
  [
    "pnpm native mapping",
    "pnpm",
    (x) => {
      x.versions["12.15.0"].optionalDependencies["@pnpm/exe.darwin-arm64"] =
        "12.15.1";
    },
    /native|mapping/i,
  ],
  [
    "pnpm native integrity",
    "native",
    (x) => {
      x.versions["12.15.0"].dist.integrity =
        `sha512-${Buffer.alloc(64, 2).toString("base64")}`;
    },
    /native asset changed/,
  ],
  [
    "uv release id",
    "uv",
    (x) => {
      x[0].id = 2;
    },
    /uv release identity changed/,
  ],
  [
    "uv asset digest",
    "uv",
    (x) => {
      x[0].assets[0].digest = `sha256:${"b".repeat(64)}`;
    },
    /uv asset changed/,
  ],
  [
    "herdr stable version",
    "herdr",
    (x) => {
      x.version = "0.9.6";
    },
    /herdr stable version changed/,
  ],
  [
    "herdr asset hash",
    "herdr",
    (x) => {
      x.sha256["macos-aarch64"] = "b".repeat(64);
    },
    /herdr asset changed/,
  ],
  ["release HTTP limit", "uv", () => {}, /429/, 429],
])
  test(`fresh recheck rejects changed ${label}`, async (t) => {
    const { dir, preload } = await uvAssetsFixture(t);
    const snapshots = recheckSnapshots();
    mutate(snapshots[source]);
    await writeFile(
      preload,
      (await readFile(preload, "utf8")) +
        recheckOverride({ [source]: snapshots[source] }, { [source]: status }),
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
  const snapshots = recheckSnapshots();
  snapshots.uv[0].updated_at = "changed";
  snapshots.uv.push(uvRelease("0.99.0", 42));
  for (const source of ["pi", "pnpm", "native"]) {
    snapshots[source].time = { modified: "changed" };
    snapshots[source].versions["0.1.0"] = {};
  }
  snapshots.herdr.timestamp = "changed";
  await writeFile(
    preload,
    (await readFile(preload, "utf8")) + recheckOverride(snapshots),
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

for (const [label, mutate] of [
  [
    "source identity",
    (x) => {
      x.components.find((c) => c.component === "pi").source.unexpected =
        "extra";
    },
  ],
  [
    "definition digests",
    (x) => {
      x.definitionDigests.unexpected = "extra";
    },
  ],
])
  test(`validate lock keeps strict unknown-field rejection for ${label}`, async (t) => {
    const f = await freshForValidation(t);
    mutate(f.lock);
    await writeFile(f.path, JSON.stringify(f.lock));
    const result = validateOffline(f, ["--lock"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(JSON.parse(result.stdout).issues[0].message, /schema/);
  });

test("oversized registry body cancels its reader in the real CLI", async (t) => {
  const { dir, preload } = await setup(t, null);
  const marker = join(dir, "reader-cancelled");
  await writeFile(
    preload,
    `import {writeFileSync} from 'node:fs';globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(8*1024*1024+1))},cancel(){writeFileSync(${JSON.stringify(marker)},'cancelled')}}));`,
  );
  const result = run(dir, preload);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    JSON.parse(result.stdout).components[0].error,
    /Registry response exceeds size limit/,
  );
  assert.equal(await readFile(marker, "utf8"), "cancelled");
});

test("setup previews a validated lock offline and refuses incomplete use", async (t) => {
  const f = await freshForValidation(t);
  const preload = join(f.dir, "setup-offline.mjs");
  await writeFile(
    preload,
    `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'darwin'}); Object.defineProperty(process,'arch',{value:'arm64'}); os.machine=()=> 'arm64'; syncBuiltinESMExports();
globalThis.fetch=()=>{throw Error('network forbidden')};`,
  );
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(f.dir, "home"));
  await mkdir(join(f.dir, "tmp"));
  const runSetup = (args, env = {}) =>
    spawnSync(process.execPath, ["--import", preload, cli, ...args], {
      encoding: "utf8",
      timeout: 12000,
      cwd: f.dir,
      env: {
        PATH: "",
        NO_COLOR: "1",
        HOME: join(f.dir, "home"),
        USERPROFILE: join(f.dir, "home"),
        TMPDIR: join(f.dir, "tmp"),
        ...env,
      },
    });
  const originalLock = await readFile(f.path, "utf8");
  const differentNode = JSON.parse(originalLock);
  differentNode.node = "24.0.0";
  await writeFile(f.path, JSON.stringify(differentNode));
  const before = await snapshot(f.dir);
  const pathsBefore = (await readdir(f.dir, { recursive: true })).sort();
  const result = runSetup([
    "--json",
    "setup",
    "--repo",
    f.dir,
    "--profile",
    "coding",
    "--dry-run",
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.kind, "setup-plan");
  assert.equal(plan.host.target, "darwin-arm64");
  assert.equal(plan.lock.node, "24.0.0");
  assert.equal(plan.components.length, 4);
  assert.ok(
    plan.components.every(
      (item) =>
        item.ownership === "unknown" && item.observation.status === "not_found",
    ),
  );
  assert.ok(plan.blockers.length);
  assert.notEqual(
    runSetup(["setup", "--repo", f.dir, "--dry-run", "--json"]).status,
    0,
  );
  assert.ok(plan.integrations.includes("pi-herdr"));
  assert.equal(
    runSetup(["setup", "--repo", f.dir, "--profile", "coding", "--json"])
      .status,
    2,
  );
  assert.equal(
    runSetup([
      "setup",
      "--repo",
      f.dir,
      "--profile",
      "coding",
      "--dry-run",
      "--lock",
      " ",
      "--json",
    ]).status,
    2,
  );
  const env = runSetup(["setup", "--dry-run", "--json"], {
    AGENT_STACK_REPO: f.dir,
    AGENT_STACK_PROFILE: "coding",
  });
  assert.equal(JSON.parse(env.stdout).profile.selectedBy, "environment");
  const fromCwd = runSetup([
    "setup",
    "--profile",
    "coding",
    "--dry-run",
    "--json",
  ]);
  assert.equal(JSON.parse(fromCwd.stdout).repo.selectedBy, "cwd");
  const explicit = runSetup(
    ["--repo", f.dir, "--json", "setup", "--profile", "coding", "--dry-run"],
    {
      AGENT_STACK_REPO: join(f.dir, "missing"),
      AGENT_STACK_PROFILE: "fixture",
    },
  );
  assert.equal(JSON.parse(explicit.stdout).repo.selectedBy, "option");
  assert.equal(JSON.parse(explicit.stdout).profile.selectedBy, "option");
  const mismatch = runSetup([
    "setup",
    "--repo",
    f.dir,
    "--profile",
    "fixture",
    "--dry-run",
    "--json",
  ]);
  assert.equal(mismatch.status, 1);
  assert.notEqual(JSON.parse(mismatch.stdout).kind, "setup-plan");
  assert.deepEqual(await snapshot(f.dir), before);
  assert.deepEqual(
    (await readdir(f.dir, { recursive: true })).sort(),
    pathsBefore,
  );
  assert.deepEqual(await readdir(join(f.dir, "home")), []);
  assert.deepEqual(await readdir(join(f.dir, "tmp")), []);
});

test("setup validates usage and locked inputs before probing the host", async (t) => {
  const f = await freshForValidation(t);
  const marker = join(f.dir, "probe-marker");
  const preload = join(f.dir, "probe.mjs");
  await writeFile(
    preload,
    `import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'darwin'}); Object.defineProperty(process,'arch',{value:'x64'});
cp.execFile=()=>{fs.writeFileSync(${JSON.stringify(marker)},'probe'); throw Error('unexpected probe')}; syncBuiltinESMExports();
globalThis.fetch=()=>{throw Error('unexpected network')};`,
  );
  const run = (args) =>
    spawnSync(
      process.execPath,
      ["--import", preload, cli, "setup", ...args, "--json"],
      { encoding: "utf8", timeout: 12000, env: { PATH: "", NO_COLOR: "1" } },
    );
  for (const options of [
    ["--repo", "", "--profile", "coding"],
    ["--repo", "  ", "--profile", "coding"],
    ["--profile", "  "],
    ["--lock", "", "--profile", "coding"],
    ["--repo", f.dir, "--repo", f.dir, "--profile", "coding"],
  ]) {
    assert.equal(run([...options, "--dry-run"]).status, 2);
  }
  assert.equal(
    run([
      "--repo",
      f.dir,
      "--profile",
      "coding",
      "--lock",
      join(f.dir, "missing"),
      "--dry-run",
    ]).status,
    1,
  );
  assert.equal(
    run(["--repo", f.dir, "--profile", "fixture", "--dry-run"]).status,
    1,
  );
  const noTarget = structuredClone(f.lock);
  noTarget.targets = noTarget.targets.filter((x) => x.id !== "darwin-x64");
  noTarget.assets = noTarget.assets.filter((x) => x.target !== "darwin-x64");
  await writeFile(f.path, JSON.stringify(noTarget));
  const missing = run(["--repo", f.dir, "--profile", "coding", "--dry-run"]);
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).error, /does not cover/);
  await writeFile(f.path, "bad json");
  assert.equal(
    run(["--repo", f.dir, "--profile", "coding", "--dry-run"]).status,
    1,
  );
  await assert.rejects(readFile(marker));
});

test("setup evaluates native and emulated Windows Node process evidence", async (t) => {
  const f = await freshForValidation(t);
  for (const [answer, expected] of [
    ["0,34404", true],
    ["34404,43620", false],
    ["bad", false],
  ]) {
    const preload = join(f.dir, `win-${expected}-${answer.length}.mjs`);
    await writeFile(
      preload,
      `import os from 'node:os'; import cp from 'node:child_process'; import {EventEmitter} from 'node:events'; import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'win32'}); Object.defineProperty(process,'arch',{value:'x64'}); os.machine=()=> 'x86_64';
cp.execFile=(file,args,opts,cb)=>{const child=new EventEmitter();queueMicrotask(()=>{cb(null,${JSON.stringify(answer)},'');child.emit('close',0)});return child;}; syncBuiltinESMExports(); globalThis.fetch=()=>{throw Error('network forbidden')};`,
    );
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        cli,
        "setup",
        "--repo",
        f.dir,
        "--profile",
        "coding",
        "--dry-run",
        "--json",
      ],
      {
        encoding: "utf8",
        timeout: 12000,
        env: { PATH: "", SystemRoot: "C:\\Windows" },
      },
    );
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const output = JSON.parse(r.stdout);
    assert.equal(output.kind === "setup-plan", expected);
    if (expected) assert.equal(output.host.evidence, "IsWow64Process2");
    else assert.match(output.error, /Cannot establish/);
  }
});

test("setup PTY selects, cancels, and renders both widths without mixing streams", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await freshForValidation(t);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(f.dir, "tmp"));
  await mkdir(join(f.dir, "bin"));
  await writeFile(
    join(f.dir, "setup-pty-preload.mjs"),
    `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; Object.defineProperty(process,'platform',{value:'darwin'}); Object.defineProperty(process,'arch',{value:'arm64'}); os.machine=()=> 'arm64'; syncBuiltinESMExports(); globalThis.fetch=()=>{throw Error('network forbidden')};`,
  );
  const driver = join(repo, "test/setup_pty_driver.py");
  for (const [mode, width, color] of [
    ["report", "40", "color"],
    ["report", "40", "no-color"],
    ["report", "80", "color"],
    ["report", "80", "no-color"],
    ["select", "40", "color"],
    ["cancel", "80", "no-color"],
    ["redirect-out", "80", "no-color"],
    ["redirect-err", "80", "no-color"],
    ["ci", "80", "no-color"],
    ["dumb", "80", "no-color"],
  ]) {
    const result = spawnSync(
      "python3",
      [
        driver,
        process.execPath,
        cli,
        f.dir,
        join(f.dir, "bin"),
        mode,
        width,
        color,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    if (mode === "cancel") {
      assert.equal(out.status, 130, out.stderr);
      assert.equal(out.sent, true);
    } else if (["redirect-out", "redirect-err", "ci", "dumb"].includes(mode)) {
      assert.equal(out.status, 2, out.stderr);
      assert.doesNotMatch(out.stderr, /Choose a profile/);
    } else {
      assert.equal(out.status, 1, out.stderr);
      assert.match(out.stdout, /Setup preview/);
      assert.match(out.stdout, /Blockers/);
      for (const row of stripVTControlCharacters(out.stdout).split(/\r?\n/))
        assert.ok(stringWidth(row) <= Number(width), row);
      if (mode === "select") assert.equal(out.sent, true);
    }
    assert.doesNotMatch(out.stdout, /Choose a profile/);
  }
  const probe = join(f.dir, "bin", "uv");
  await writeFile(
    probe,
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(join(f.dir, "probe.pid"))}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
`,
  );
  await import("node:fs/promises").then(({ chmod }) => chmod(probe, 0o755));
  const interrupted = spawnSync(
    "python3",
    [
      driver,
      process.execPath,
      cli,
      f.dir,
      join(f.dir, "bin"),
      "interrupt",
      "80",
      "no-color",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(interrupted.status, 0, interrupted.stderr);
  const outcome = JSON.parse(interrupted.stdout);
  assert.equal(outcome.status, 130, outcome.stderr);
  assert.equal(outcome.sent, true);
  assert.deepEqual(await readdir(join(f.dir, "tmp")), []);
  const pid = Number(await readFile(join(f.dir, "probe.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("setup distinguishes Intel, Rosetta and unknown sysctl results", async (t) => {
  const f = await freshForValidation(t);
  for (const [code, stdout, stderr, native] of [
    [0, "0\n", "", true],
    [1, "", "sysctl: unknown oid 'sysctl.proc_translated'\n", true],
    [0, "1\n", "", false],
    [1, "", "permission denied", false],
  ]) {
    const preload = join(f.dir, `mac-${native}-${stderr.length}.mjs`);
    await writeFile(
      preload,
      `import cp from 'node:child_process'; import os from 'node:os'; import {EventEmitter} from 'node:events'; import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'darwin'}); Object.defineProperty(process,'arch',{value:'x64'}); os.machine=()=> 'x86_64';
cp.execFile=(file,args,opts,cb)=>{if(file !== '/usr/bin/arch' || args.join(' ') !== '-x86_64 /usr/sbin/sysctl -n sysctl.proc_translated') throw Error('wrong architecture'); const error=${code} ? Object.assign(new Error('failed'),{code:${code}}) : null; const child=new EventEmitter();queueMicrotask(()=>{cb(error,${JSON.stringify(stdout)},${JSON.stringify(stderr)});child.emit('close',${code})});return child;}; syncBuiltinESMExports(); globalThis.fetch=()=>{throw Error('network forbidden')};`,
    );
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        cli,
        "setup",
        "--repo",
        f.dir,
        "--profile",
        "coding",
        "--dry-run",
        "--json",
      ],
      { encoding: "utf8", timeout: 12000, env: { PATH: "" } },
    );
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const value = JSON.parse(r.stdout);
    assert.equal(value.kind === "setup-plan", native);
    if (native) assert.equal(value.host.evidence, "same-architecture-sysctl");
  }
});

test("setup distinguishes matched metadata, unverified entry, mismatched version and missing tool", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await freshForValidation(t);
  const { mkdir, chmod } = await import("node:fs/promises");
  const bin = join(f.dir, "bin"),
    pkg = join(f.dir, "pi-package");
  await mkdir(bin);
  await mkdir(pkg);
  const entry = join(pkg, "pi.js");
  await writeFile(entry, "never execute this entry");
  await chmod(entry, 0o755);
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.5.2",
      bin: { pi: "pi.js" },
    }),
  );
  await symlink(entry, join(bin, "pi"));
  await writeFile(join(bin, "pnpm"), "unverified entry");
  await chmod(join(bin, "pnpm"), 0o755);
  await writeFile(
    join(bin, "uv"),
    `#!${process.execPath}\nconsole.log('uv 9.9.9')\n`,
  );
  await chmod(join(bin, "uv"), 0o755);
  const preload = join(f.dir, "offline-host.mjs");
  await writeFile(
    preload,
    `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; Object.defineProperty(process,'platform',{value:'darwin'});Object.defineProperty(process,'arch',{value:'arm64'});os.machine=()=> 'arm64';syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('unexpected fetch')}`,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      cli,
      "setup",
      "--repo",
      f.dir,
      "--profile",
      "coding",
      "--dry-run",
      "--json",
    ],
    { encoding: "utf8", timeout: 12000, env: { PATH: bin } },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const plan = JSON.parse(result.stdout),
    byName = Object.fromEntries(plan.components.map((x) => [x.component, x]));
  assert.equal(byName.pi.observation.status, "ok");
  assert.equal(byName.pi.observation.evidence, "package_metadata");
  assert.equal(byName.pnpm.observation.status, "unverified_entrypoint");
  assert.equal(byName.uv.observation.status, "version_mismatch");
  assert.equal(byName.herdr.observation.status, "not_found");
  assert.ok(plan.components.every((x) => x.ownership === "unknown"));
});

test("setup observes the real native Windows x64 CI process", {
  skip: !(process.platform === "win32" && process.env.RUNNER_ARCH === "X64"),
}, async (t) => {
  const f = await freshForValidation(t);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      f.offline,
      cli,
      "setup",
      "--repo",
      f.dir,
      "--profile",
      "coding",
      "--dry-run",
      "--json",
    ],
    { encoding: "utf8", timeout: 20000, env: { ...process.env, PATH: "" } },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.kind, "setup-plan");
  assert.equal(plan.host.evidence, "IsWow64Process2");
  assert.equal(plan.host.native, true);
});

for (const mode of ["timeout", "output_limit", "abort"]) {
  test(`setup host probe ${mode} kills and reaps an uncooperative child`, {
    skip: mode === "abort" && process.platform === "win32",
    timeout: 15000,
  }, async (t) => {
    const f = await freshForValidation(t);
    const { mkdir } = await import("node:fs/promises");
    const tmp = join(f.dir, "probe-tmp");
    await mkdir(tmp);
    const pidPath = join(f.dir, "host-probe.pid");
    const ready = join(f.dir, "host-probe-ready");
    const childCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');${mode === "output_limit" ? "process.stdout.write('x'.repeat(20000));" : ""}setInterval(()=>{},1000);`;
    const preload = join(f.dir, `host-${mode}.mjs`);
    await writeFile(
      preload,
      `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'darwin'});Object.defineProperty(process,'arch',{value:'x64'});
const original=cp.execFile;cp.execFile=(_file,_args,opts,callback)=>{const child=original(process.execPath,['-e',${JSON.stringify(childCode)}],opts,callback);fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));return child;};syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('network forbidden')};`,
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        preload,
        cli,
        "setup",
        "--repo",
        f.dir,
        "--profile",
        "coding",
        "--dry-run",
        "--json",
      ],
      {
        env: {
          PATH: "",
          TMPDIR: tmp,
          TMP: tmp,
          TEMP: tmp,
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.resume();
    const done = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    let pid;
    let reaped = false;
    let guard;
    try {
      for (let i = 0; i < 200; i++) {
        try {
          pid = Number(await readFile(pidPath, "utf8"));
          await readFile(ready);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      assert.ok(pid, "host probe started");
      if (mode === "abort") child.kill("SIGINT");
      const result = await Promise.race([
        done,
        new Promise((resolve) => {
          guard = setTimeout(() => resolve(null), 6500);
        }),
      ]);
      assert.ok(result, "CLI must finish without outside termination");
      assert.equal(result.code, mode === "abort" ? 130 : 1, stdout);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      reaped = true;
      assert.deepEqual(await readdir(tmp), []);
      assert.match(
        JSON.parse(stdout).error,
        mode === "abort" ? /Cancelled/ : /probe-unknown/,
      );
    } finally {
      clearTimeout(guard);
      if (pid && !reaped) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await done;
      }
    }
  });
}

test("setup previews the locked uv asset for a capability-complete uv-only profile", async (t) => {
  const { dir, preload } = await setup(
    t,
    null,
    npmAssetPreload({ uv: [uvReleaseWithAssets()] }),
  );
  await writeFile(
    join(dir, "stack/profiles/uv-only.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "uv-only",
      description: "Python tools",
      platforms: ["darwin", "linux", "win32"],
      components: [{ component: "uv", version: ">=0.13.8 <0.14" }],
      integrations: [],
      requires: ["python-tools"],
    }),
  );
  const created = run(dir, preload, [
    "--profile",
    "uv-only",
    "--target",
    "darwin-arm64",
    "--json",
  ]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const locked = JSON.parse(
    await readFile(join(dir, "stack/stack.lock.json"), "utf8"),
  );
  const asset = locked.assets.find((entry) => entry.component === "uv");
  const before = await snapshot(dir);
  const offline = join(dir, "uv-only-offline.mjs");
  await writeFile(
    offline,
    `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';Object.defineProperty(process,'platform',{value:'darwin'});Object.defineProperty(process,'arch',{value:'arm64'});os.machine=()=> 'arm64';syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('unexpected network')}`,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      offline,
      cli,
      "setup",
      "--repo",
      dir,
      "--profile",
      "uv-only",
      "--dry-run",
      "--json",
    ],
    { encoding: "utf8", timeout: 12000, env: { PATH: "", NO_COLOR: "1" } },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.kind, "setup-plan");
  assert.deepEqual(plan.components[0].lockedAsset, {
    target: asset.target,
    name: asset.artifact.assetName,
    url: asset.url,
    format: asset.format,
    sha256: asset.digest.value,
    digestSource: asset.digestSource,
  });
  assert.deepEqual(plan.resources, []);
  assert.ok(plan.blockers.includes("HOME is required for uv setup"));
  assert.ok(
    !plan.blockers.some(
      (entry) =>
        entry.includes("Node engines") || entry.includes("integrations"),
    ),
  );
  assert.deepEqual(await snapshot(dir), before);
});

async function uvInstallFixture(t, variant = "normal", arch = "x64") {
  const { mkdir, chmod, realpath } = await import("node:fs/promises");
  const { dir } = await setup(t, null);
  const rootName = `uv-${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`,
    files = join(dir, "archive-files"),
    root = join(files, rootName);
  await mkdir(root, { recursive: true });
  for (const name of ["uv", "uvx"]) {
    if (variant === "malicious" && name === "uv") {
      await symlink("/etc/passwd", join(root, name));
      continue;
    }
    if (variant === "oversize-expanded" && name === "uv") {
      const file = await import("node:fs/promises").then(({ open }) =>
        open(join(root, name), "w"),
      );
      try {
        await file.truncate(128 * 1024 * 1024 + 1);
      } finally {
        await file.close();
      }
      continue;
    }
    await writeFile(
      join(root, name),
      variant === "version-stall" && name === "uv"
        ? `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(join(dir, "version-pid"))},String(process.pid));setInterval(()=>{},1000)\n`
        : `#!${process.execPath}\nif(process.argv[2] !== '--version')process.exit(2);console.log('${name} ${variant === "bad-version" && name === "uvx" ? "9.9.9" : "0.13.8"}')\n`,
    );
    await chmod(join(root, name), 0o755);
  }
  const archive = join(dir, "uv.tar.gz");
  await createTar(
    {
      gzip: true,
      cwd: files,
      file: archive,
      ...(variant === "traversal" ? { prefix: "../escape" } : {}),
    },
    variant === "duplicate" ? [rootName, rootName] : [rootName],
  );
  const sha = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const name = `${rootName}.tar.gz`,
    assetUrl = `https://github.com/astral-sh/uv/releases/download/0.13.8/${name}`;
  const release = uvRelease("0.13.8", 1, {
    assets: [
      {
        id: 101,
        name,
        state: "uploaded",
        browser_download_url: assetUrl,
        digest: `sha256:${sha}`,
      },
    ],
  });
  const metadata = join(dir, "metadata.mjs");
  await writeFile(metadata, npmAssetPreload({ uv: [release] }));
  await writeFile(
    join(dir, "stack/profiles/uv-only.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "uv-only",
      description: "Python tools",
      platforms: ["darwin", "linux", "win32"],
      components: [{ component: "uv", version: ">=0.13.8 <0.14" }],
      integrations: [],
      requires: ["python-tools"],
    }),
  );
  const locked = run(dir, metadata, [
    "--profile",
    "uv-only",
    "--target",
    `darwin-${arch}`,
    "--json",
  ]);
  assert.equal(locked.status, 0, locked.stdout + locked.stderr);
  await mkdir(join(dir, "home"));
  const home = await realpath(join(dir, "home")),
    bin = join(home, ".agent-stack/bin"),
    tools = join(dir, "tools");
  await mkdir(bin, { recursive: true });
  await mkdir(tools);
  for (const name of ["npm", "git"]) {
    await writeFile(
      join(tools, name),
      `#!${process.execPath}\nconsole.log('${name === "git" ? "git version " : ""}11.0.0')\n`,
    );
    await chmod(join(tools, name), 0o755);
  }
  const marker = join(dir, "network-marker"),
    preload = join(dir, "install-preload.mjs");
  await writeFile(
    preload,
    `import cp from 'node:child_process';import os from 'node:os';import fs from 'node:fs';import {EventEmitter} from 'node:events';import {readFile,appendFile,writeFile} from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';Object.defineProperty(process,'platform',{value:'darwin'});Object.defineProperty(process,'arch',{value:${JSON.stringify(arch)}});os.machine=()=>${JSON.stringify(arch === "arm64" ? "arm64" : "x86_64")};const originalUnlink=fs.promises.unlink;fs.promises.unlink=async(p)=>{if(process.env.FAULT_UNLINK==='binding-temp'&&typeof p==='string'&&p.includes('/binding-uv-')&&p.endsWith('.tmp'))throw Object.assign(Error('injected unlink failure'),{code:'EACCES'});return originalUnlink(p)};const originalStat=fs.promises.lstat;let failedStageStat=false;fs.promises.lstat=async(p,...args)=>{if(process.env.FAULT_STAT==='stage'&&!failedStageStat&&typeof p==='string'&&p.includes('/.agent-stack/uv-')){failedStageStat=true;throw Object.assign(Error('injected stage stat failure'),{code:'EACCES'})}return originalStat(p,...args)};const originalOpen=fs.promises.open,originalMkdir=fs.promises.mkdir;fs.promises.open=async(p,...args)=>{if(typeof p==='string'&&((process.env.FAULT_OPEN==='lock'&&p===${JSON.stringify(join(home, ".agent-stack", "operation.lock"))})||(process.env.FAULT_OPEN==='archive'&&p.endsWith('/archive.tar.gz'))||(process.env.FAULT_OPEN==='journal'&&p.endsWith('/pending.json')&&args[0]==='wx')||(process.env.FAULT_OPEN==='binding-temp'&&p.includes('/binding-')&&p.endsWith('.tmp'))))throw Object.assign(Error('injected open failure'),{code:'EACCES'});return originalOpen(p,...args)};fs.promises.mkdir=async(p,...args)=>{if(process.env.FAULT_OPEN==='stage'&&typeof p==='string'&&p.includes('/.agent-stack/uv-'))throw Object.assign(Error('injected mkdir failure'),{code:'EACCES'});return originalMkdir(p,...args)};const originalLink=fs.promises.link;fs.promises.link=async(a,b)=>{if((process.env.FAULT_THROW==='uvx'&&b===${JSON.stringify(join(bin, "uvx"))})||(process.env.FAULT_THROW==='binding'&&b===${JSON.stringify(join(home, ".agent-stack", "binding.json"))}))throw Object.assign(Error('injected write failure'),{code:'EACCES'});await originalLink(a,b);if((process.env.FAULT_KILL==='link'&&b===${JSON.stringify(join(bin, "uv"))})||(process.env.FAULT_KILL==='binding'&&b===${JSON.stringify(join(home, ".agent-stack", "binding.json"))}))process.kill(process.pid,'SIGKILL')};const old=cp.execFile;cp.execFile=(file,args,opts,cb)=>{if(file==='/usr/bin/arch'){const p=new EventEmitter();queueMicrotask(()=>{cb(null,'0\\n','');p.emit('close',0)});return p}return old(file,args,opts,cb)};syncBuiltinESMExports();if(process.env.FETCH_MODE==='timeout'){const oldTimeout=AbortSignal.timeout;AbortSignal.timeout=(ms)=>oldTimeout(Math.min(ms,200));}globalThis.fetch=async(url,options)=>{await appendFile(${JSON.stringify(marker)},'x');if(process.env.FETCH_MODE==='timeout'||process.env.FETCH_MODE==='stall')return new Promise((resolve,reject)=>{const timer=setInterval(()=>{},1000);options.signal.addEventListener('abort',()=>{clearInterval(timer);reject(Error('aborted'))},{once:true})});if(process.env.FETCH_MODE==='forbid')throw Error('unexpected network');if(process.env.FETCH_MODE==='bad')return new Response('wrong');if(process.env.FETCH_MODE==='http')return new Response('denied',{status:403});if(process.env.FETCH_MODE==='oversize')return new Response('x',{headers:{'content-length':'67108865'}});if(process.env.FETCH_MODE==='redirect')return new Response('',{status:302,headers:{location:'https://example.com/evil'}});if(process.env.FETCH_MODE==='valid-redirect'&&String(url)===${JSON.stringify(assetUrl)})return new Response('',{status:302,headers:{location:'https://release-assets.githubusercontent.com/fixture?sig=private'}});if(process.env.FETCH_MODE==='valid-redirect'&&String(url).startsWith('https://release-assets.githubusercontent.com/'))return new Response(await readFile(${JSON.stringify(archive)}));if(process.env.FETCH_MODE==='lock-change')await appendFile(${JSON.stringify(join(dir, "stack/stack.lock.json"))},' ');if(process.env.FETCH_MODE==='source-change')await appendFile(${JSON.stringify(join(dir, "stack/components/uv.yaml"))},' ');if(process.env.FETCH_MODE==='env-change')process.env.PATH+=':/changed';if(process.env.FETCH_MODE==='conflict')await writeFile(${JSON.stringify(join(bin, "uv"))},'foreign');if(process.env.FETCH_MODE==='delay')await new Promise(r=>setTimeout(r,1200));if(String(url)!==${JSON.stringify(assetUrl)})throw Error('unexpected URL');return new Response(await readFile(${JSON.stringify(archive)}));};`,
  );
  return { dir, home, bin, tools, preload, marker, archive, sha, metadata };
}
function runUvSetup(f, args, extra = {}) {
  return spawnSync(
    process.execPath,
    ["--import", f.preload, cli, "setup", ...args, "--json"],
    {
      encoding: "utf8",
      timeout: 20000,
      env: {
        HOME: f.home,
        PATH: `${f.bin}:${f.tools}`,
        NO_COLOR: "1",
        ...extra,
      },
    },
  );
}
test("setup installs the locked uv profile, binds it and reruns without a download", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t),
    before = await snapshot(f.dir);
  const noConsent = runUvSetup(f, ["--repo", f.dir, "--profile", "uv-only"], {
    FETCH_MODE: "forbid",
  });
  assert.equal(noConsent.status, 2);
  assert.equal(JSON.parse(noConsent.stdout).error.kind, "usage");
  const noPath = runUvSetup(
    f,
    ["--repo", f.dir, "--profile", "uv-only", "--dry-run"],
    { FETCH_MODE: "forbid", PATH: f.tools },
  );
  assert.equal(noPath.status, 1);
  assert.match(
    JSON.stringify(JSON.parse(noPath.stdout).blockers),
    /Add .* to PATH/,
  );
  const preview = runUvSetup(
    f,
    ["--repo", f.dir, "--profile", "uv-only", "--dry-run"],
    { FETCH_MODE: "forbid" },
  );
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(JSON.parse(preview.stdout).uvInstallation.mode, "install");
  await assert.rejects(readFile(f.marker));
  const result = runUvSetup(f, [
    "--repo",
    f.dir,
    "--profile",
    "uv-only",
    "--yes",
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).kind, "setup-complete");
  for (const name of ["uv", "uvx"]) {
    const r = spawnSync(join(f.bin, name), ["--version"], {
      encoding: "utf8",
      env: { HOME: f.home, PATH: "" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^${name} 0\\.13\\.8`));
  }
  const again = runUvSetup(f, ["--yes"], { FETCH_MODE: "forbid" });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  const p = JSON.parse(again.stdout);
  assert.equal(p.mode, "managed");
  assert.equal(p.plan.profile.selectedBy, "binding");
  assert.deepEqual(await snapshot(f.dir), before);
  assert.equal(await readFile(f.marker, "utf8"), "x");
});

for (const [variant, fetchMode, expected] of [
  ["normal", "bad", /SHA-256 mismatch/],
  ["normal", "redirect", /Untrusted uv download URL/],
  ["normal", "timeout", /uv download timed out/],
  ["normal", "http", /HTTP 403/],
  ["normal", "oversize", /exceeds size limit/],
  ["malicious", "normal", /Unexpected uv archive entry/],
  ["traversal", "normal", /Unexpected uv archive entry/],
  [
    "duplicate",
    "normal",
    /Duplicate uv archive entry|Too many uv archive entries/,
  ],
  ["bad-version", "normal", /Cannot verify uvx version/],
  ["oversize-expanded", "normal", /expanded size limit/],
]) {
  test(`setup refuses uv ${fetchMode === "normal" ? variant : fetchMode} without publishing`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const f = await uvInstallFixture(t, variant),
      before = await snapshot(f.dir);
    const result = runUvSetup(
      f,
      ["--repo", f.dir, "--profile", "uv-only", "--yes"],
      { FETCH_MODE: fetchMode },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(JSON.parse(result.stdout).error, expected);
    assert.deepEqual(await readdir(join(f.home, ".agent-stack")), ["bin"]);
    assert.deepEqual(await readdir(f.bin), []);
    assert.deepEqual(await snapshot(f.dir), before);
  });
}

test("setup refuses a changed lock and preserves a conflicting target", {
  skip: process.platform === "win32",
}, async (t) => {
  for (const mode of [
    "lock-change",
    "source-change",
    "env-change",
    "conflict",
  ]) {
    const f = await uvInstallFixture(t),
      result = runUvSetup(
        f,
        ["--repo", f.dir, "--profile", "uv-only", "--yes"],
        { FETCH_MODE: mode },
      );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      JSON.parse(result.stdout).error,
      mode === "conflict" ? /conflict/i : /changed/,
    );
    if (mode === "conflict")
      assert.equal(await readFile(join(f.bin, "uv"), "utf8"), "foreign");
    else assert.deepEqual(await readdir(f.bin), []);
    assert.deepEqual(await readdir(join(f.home, ".agent-stack")), ["bin"]);
  }
});
test("setup recovers a killed publisher before retrying", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t),
    killed = runUvSetup(f, ["--repo", f.dir, "--profile", "uv-only", "--yes"], {
      FAULT_KILL: "link",
    });
  assert.equal(killed.signal, "SIGKILL");
  assert.ok(
    (await readdir(join(f.home, ".agent-stack"))).includes("pending.json"),
  );
  const retry = runUvSetup(f, [
    "--repo",
    f.dir,
    "--profile",
    "uv-only",
    "--yes",
  ]);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(JSON.parse(retry.stdout).kind, "setup-complete");
  assert.ok(
    !(await readdir(join(f.home, ".agent-stack"))).includes("pending.json"),
  );
});

test("setup serializes competing uv installations", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t);
  const args = [
    "--import",
    f.preload,
    cli,
    "setup",
    "--repo",
    f.dir,
    "--profile",
    "uv-only",
    "--yes",
    "--json",
  ];
  const env = {
    HOME: f.home,
    PATH: `${f.bin}:${f.tools}`,
    NO_COLOR: "1",
    FETCH_MODE: "delay",
  };
  const first = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  first.stdout.on("data", (x) => (stdout += x));
  first.stderr.on("data", (x) => (stderr += x));
  const done = new Promise((resolve) =>
    first.once("close", (code) => resolve(code)),
  );
  try {
    for (let i = 0; i < 200; i++) {
      try {
        await readFile(f.marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const second = runUvSetup(f, [
      "--repo",
      f.dir,
      "--profile",
      "uv-only",
      "--yes",
    ]);
    assert.equal(second.status, 1, second.stdout + second.stderr);
    assert.match(JSON.parse(second.stdout).error, /operation is running/);
    assert.equal(await done, 0, stdout + stderr);
    assert.equal(JSON.parse(stdout).kind, "setup-complete");
  } finally {
    if (first.exitCode === null && first.signalCode === null) {
      first.kill("SIGKILL");
      await done;
    }
  }
});

test("setup reuses matching external uv without taking ownership", {
  skip: process.platform === "win32",
}, async (t) => {
  const { chmod } = await import("node:fs/promises");
  const f = await uvInstallFixture(t);
  for (const name of ["uv", "uvx"]) {
    await writeFile(
      join(f.tools, name),
      `#!${process.execPath}\nconsole.log('${name} 0.13.8')\n`,
    );
    await chmod(join(f.tools, name), 0o755);
  }
  const before = await readFile(join(f.tools, "uv"));
  const result = runUvSetup(
    f,
    ["--repo", f.dir, "--profile", "uv-only", "--yes"],
    { FETCH_MODE: "forbid" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.mode, "reuse");
  assert.equal(value.binding.uv.mode, "external");
  assert.equal(value.plan.components[0].ownership, "unknown");
  assert.deepEqual(await readFile(join(f.tools, "uv")), before);
  await assert.rejects(readFile(f.marker));
  assert.deepEqual(await readdir(f.bin), []);
});
test("setup preserves unknown entries and blocks full coding before download", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t);
  await writeFile(join(f.bin, "uv"), "unknown file");
  const blocked = runUvSetup(
    f,
    ["--repo", f.dir, "--profile", "uv-only", "--yes"],
    { FETCH_MODE: "forbid" },
  );
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.equal(await readFile(join(f.bin, "uv"), "utf8"), "unknown file");
  await assert.rejects(readFile(f.marker));
  await rm(join(f.bin, "uv"));
  await cp(
    join(repo, "stack/profiles/coding.yaml"),
    join(f.dir, "stack/profiles/coding.yaml"),
  );
  await rm(join(f.dir, "stack/stack.lock.json"));
  const locked = run(f.dir, f.metadata, [
    "--profile",
    "coding",
    "--target",
    "darwin-x64",
    "--json",
  ]);
  assert.equal(locked.status, 0, locked.stdout + locked.stderr);
  const coding = runUvSetup(
    f,
    ["--repo", f.dir, "--profile", "coding", "--yes"],
    { FETCH_MODE: "forbid" },
  );
  assert.equal(coding.status, 1, coding.stdout + coding.stderr);
  assert.match(
    JSON.stringify(JSON.parse(coding.stdout).blockers),
    /complete profile/,
  );
  await assert.rejects(readFile(f.marker));
  assert.deepEqual(await readdir(f.bin), []);
});

test("setup interruption during download removes its own staging and lock", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t),
    args = [
      "--import",
      f.preload,
      cli,
      "setup",
      "--repo",
      f.dir,
      "--profile",
      "uv-only",
      "--yes",
      "--json",
    ];
  const child = spawn(process.execPath, args, {
    env: {
      HOME: f.home,
      PATH: `${f.bin}:${f.tools}`,
      NO_COLOR: "1",
      FETCH_MODE: "stall",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (x) => (out += x));
  child.stderr.resume();
  const done = new Promise((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  try {
    for (let i = 0; i < 200; i++) {
      try {
        await readFile(f.marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(await readFile(f.marker, "utf8"), "x");
    child.kill("SIGINT");
    assert.equal(await done, 130, out);
    assert.match(JSON.parse(out).error, /Cancelled/);
    assert.deepEqual(await readdir(join(f.home, ".agent-stack")), ["bin"]);
    assert.deepEqual(await readdir(f.bin), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await done;
    }
  }
});

test("setup recovers a stale download stage after an interrupted process", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t),
    args = [
      "--import",
      f.preload,
      cli,
      "setup",
      "--repo",
      f.dir,
      "--profile",
      "uv-only",
      "--yes",
      "--json",
    ];
  const child = spawn(process.execPath, args, {
    env: {
      HOME: f.home,
      PATH: `${f.bin}:${f.tools}`,
      NO_COLOR: "1",
      FETCH_MODE: "stall",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  const done = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  try {
    for (let i = 0; i < 200; i++) {
      try {
        await readFile(f.marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(await readFile(f.marker, "utf8"), "x");
    child.kill("SIGKILL");
    assert.equal((await done).signal, "SIGKILL");
    const result = runUvSetup(f, [
      "--repo",
      f.dir,
      "--profile",
      "uv-only",
      "--yes",
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const names = await readdir(join(f.home, ".agent-stack"));
    assert.equal(names.filter((x) => x.startsWith("uv-")).length, 1);
    assert.ok(!names.includes("operation.lock"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await done;
    }
  }
});

for (const mode of ["confirm-cancel", "confirm-no", "confirm-yes"]) {
  test(`setup asks for real TTY confirmation: ${mode}`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const f = await uvInstallFixture(t);
    await cp(f.preload, join(f.dir, "setup-pty-preload.mjs"));
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(f.dir, "tmp")),
    );
    const result = spawnSync(
      "python3",
      [
        join(repo, "test/setup_pty_driver.py"),
        process.execPath,
        cli,
        f.dir,
        `${f.bin}:${f.tools}`,
        mode,
        "80",
        "no-color",
      ],
      {
        encoding: "utf8",
        timeout: 20000,
        env: {
          ...process.env,
          HOME: f.home,
          FETCH_MODE: mode === "confirm-yes" ? "normal" : "forbid",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sent, true, output.stderr);
    assert.equal(
      output.status,
      mode === "confirm-yes" ? 0 : 130,
      output.stderr,
    );
    assert.doesNotMatch(output.stdout, /Apply this setup plan/);
    if (mode === "confirm-yes")
      assert.ok((await readdir(f.bin)).includes("uv"));
    else {
      await assert.rejects(readFile(f.marker));
      assert.deepEqual(await readdir(f.bin), []);
    }
  });
}

test("setup completes recovery after binding was published", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t),
    killed = runUvSetup(f, ["--repo", f.dir, "--profile", "uv-only", "--yes"], {
      FAULT_KILL: "binding",
    });
  assert.equal(killed.signal, "SIGKILL");
  const recovered = runUvSetup(f, ["--yes"], { FETCH_MODE: "forbid" });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).mode, "managed");
  const entries = await readdir(join(f.home, ".agent-stack"));
  assert.ok(!entries.includes("pending.json"));
  assert.ok(!entries.includes("operation.lock"));
  assert.ok(
    !entries.some((x) => x.startsWith("binding-") && x.endsWith(".tmp")),
  );
  assert.equal(await readFile(f.marker, "utf8"), "x");
});

test("setup follows only the allowed release asset CDN redirect", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t),
    result = runUvSetup(f, ["--repo", f.dir, "--profile", "uv-only", "--yes"], {
      FETCH_MODE: "valid-redirect",
    });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await readFile(f.marker, "utf8"), "xx");
  assert.doesNotMatch(result.stdout, /sig=private/);
});

test("setup installs a locked macOS arm64 uv profile with an isolated fixture", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t, "normal", "arm64"),
    result = runUvSetup(f, ["--repo", f.dir, "--profile", "uv-only", "--yes"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.plan.host.target, "darwin-arm64");
  assert.equal(output.kind, "setup-complete");
});

test("setup refuses an unsupported Windows uv target before downloading", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t);
  const win = join(f.dir, "windows-preload.mjs");
  const source = await readFile(f.preload, "utf8");
  await writeFile(
    win,
    source
      .replace("value:'darwin'", "value:'win32'")
      .replace(
        "if(file==='/usr/bin/arch')",
        "if(file.includes('powershell.exe'))",
      )
      .replace("cb(null,'0\\n','')", "cb(null,'0,34404','')"),
  );
  const winName = "uv-x86_64-pc-windows-msvc.zip";
  const release = uvRelease("0.13.8", 1, {
    assets: [
      {
        id: 102,
        name: winName,
        state: "uploaded",
        browser_download_url: `https://github.com/astral-sh/uv/releases/download/0.13.8/${winName}`,
        digest: `sha256:${f.sha}`,
      },
    ],
  });
  await writeFile(f.metadata, npmAssetPreload({ uv: [release] }));
  await rm(join(f.dir, "stack/stack.lock.json"));
  const created = run(f.dir, f.metadata, [
    "--profile",
    "uv-only",
    "--target",
    "win32-x64",
    "--json",
  ]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      win,
      cli,
      "setup",
      "--repo",
      f.dir,
      "--profile",
      "uv-only",
      "--yes",
      "--json",
    ],
    {
      encoding: "utf8",
      timeout: 15000,
      env: {
        HOME: f.home,
        PATH: `${f.bin}:${f.tools}`,
        SystemRoot: "C:\\Windows",
        FETCH_MODE: "forbid",
      },
    },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    JSON.stringify(JSON.parse(result.stdout)),
    /only supported on native macOS/,
  );
  await assert.rejects(readFile(f.marker));
  assert.deepEqual(await readdir(f.bin), []);
});

for (const point of ["uvx", "binding"]) {
  test(`setup rolls back its own entries when ${point} publication fails`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const f = await uvInstallFixture(t),
      result = runUvSetup(
        f,
        ["--repo", f.dir, "--profile", "uv-only", "--yes"],
        { FAULT_THROW: point },
      );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(JSON.parse(result.stdout).error, /injected write failure/);
    assert.deepEqual(await readdir(f.bin), []);
    assert.deepEqual(await readdir(join(f.home, ".agent-stack")), ["bin"]);
  });
}

test("setup interruption during staged version verification reaps the child", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t, "version-stall"),
    args = [
      "--import",
      f.preload,
      cli,
      "setup",
      "--repo",
      f.dir,
      "--profile",
      "uv-only",
      "--yes",
      "--json",
    ];
  const child = spawn(process.execPath, args, {
    env: { HOME: f.home, PATH: `${f.bin}:${f.tools}`, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (x) => (output += x));
  child.stderr.resume();
  const done = new Promise((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  let pid;
  try {
    for (let i = 0; i < 200; i++) {
      try {
        pid = Number(await readFile(join(f.dir, "version-pid"), "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(pid);
    child.kill("SIGINT");
    assert.equal(await done, 130, output);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(await readdir(join(f.home, ".agent-stack")), ["bin"]);
    assert.deepEqual(await readdir(f.bin), []);
    pid = undefined;
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await done;
    }
  }
});

for (const point of ["lock", "stage", "archive", "journal", "binding-temp"]) {
  test(`setup cleans its own state when ${point} creation fails`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const f = await uvInstallFixture(t),
      result = runUvSetup(
        f,
        ["--repo", f.dir, "--profile", "uv-only", "--yes"],
        { FAULT_OPEN: point },
      );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      JSON.parse(result.stdout).error,
      /injected (open|mkdir) failure/,
    );
    assert.deepEqual(await readdir(f.bin), []);
    assert.deepEqual(await readdir(join(f.home, ".agent-stack")), ["bin"]);
  });
}

test("setup reports published state if binding cleanup fails and repairs it on retry", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t),
    first = runUvSetup(f, ["--repo", f.dir, "--profile", "uv-only", "--yes"], {
      FAULT_UNLINK: "binding-temp",
    });
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.match(JSON.parse(first.stdout).error, /installed and bound.*cleanup/);
  assert.ok((await readdir(f.bin)).includes("uv"));
  const retry = runUvSetup(f, ["--yes"], { FETCH_MODE: "forbid" });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(JSON.parse(retry.stdout).mode, "managed");
  const entries = await readdir(join(f.home, ".agent-stack"));
  assert.ok(!entries.includes("pending.json"));
  assert.ok(!entries.some((x) => x.endsWith(".tmp")));
});

test("setup preserves uncertain staging ownership for manual recovery", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t),
    result = runUvSetup(f, ["--repo", f.dir, "--profile", "uv-only", "--yes"], {
      FAULT_STAT: "stage",
    });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(JSON.parse(result.stdout).error, /manual recovery/);
  assert.deepEqual(await readdir(f.bin), []);
  const entries = await readdir(join(f.home, ".agent-stack"));
  assert.ok(entries.includes("operation.lock"));
  assert.ok(entries.some((x) => x.startsWith("uv-")));
  const retry = runUvSetup(
    f,
    ["--repo", f.dir, "--profile", "uv-only", "--yes"],
    { FETCH_MODE: "forbid" },
  );
  assert.equal(retry.status, 1, retry.stdout + retry.stderr);
  assert.match(JSON.parse(retry.stdout).error, /manual recovery/);
  await assert.rejects(readFile(f.marker));
});

test("setup updates its own binding after an explicit equivalent checkout", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t),
    first = runUvSetup(f, ["--repo", f.dir, "--profile", "uv-only", "--yes"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const other = join(f.dir, "other checkout"),
    { mkdir } = await import("node:fs/promises");
  await mkdir(other);
  await cp(join(f.dir, "stack"), join(other, "stack"), { recursive: true });
  const before = await readFile(join(f.bin, "uv"));
  const result = runUvSetup(
    f,
    ["--repo", other, "--profile", "uv-only", "--yes"],
    { FETCH_MODE: "forbid" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).binding.repo, other);
  assert.deepEqual(await readFile(join(f.bin, "uv")), before);
  const bound = runUvSetup(f, ["--dry-run"], { FETCH_MODE: "forbid" });
  assert.equal(bound.status, 0, bound.stdout + bound.stderr);
  assert.equal(JSON.parse(bound.stdout).repo.path, other);
});

test("setup refuses an external executable changed after confirmation was displayed", {
  skip: process.platform === "win32",
}, async (t) => {
  const { chmod, mkdir } = await import("node:fs/promises"),
    f = await uvInstallFixture(t);
  for (const name of ["uv", "uvx"]) {
    await writeFile(
      join(f.tools, name),
      `#!${process.execPath}\nconsole.log('${name} 0.13.8')\n`,
    );
    await chmod(join(f.tools, name), 0o755);
  }
  await cp(f.preload, join(f.dir, "setup-pty-preload.mjs"));
  await mkdir(join(f.dir, "tmp"));
  const result = spawnSync(
    "python3",
    [
      join(repo, "test/setup_pty_driver.py"),
      process.execPath,
      cli,
      f.dir,
      `${f.bin}:${f.tools}`,
      "confirm-change",
      "80",
      "no-color",
    ],
    {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        HOME: f.home,
        FETCH_MODE: "forbid",
        MUTATE_ENTRY: join(f.tools, "uv"),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.sent, true, output.stderr);
  assert.equal(output.status, 1, output.stderr);
  assert.match(output.stderr, /Existing uv entries changed/);
  await assert.rejects(readFile(join(f.home, ".agent-stack/binding.json")));
  await assert.rejects(readFile(f.marker));
});

test("setup preserves locally modified managed uv entries", {
  skip: process.platform === "win32",
}, async (t) => {
  const { appendFile } = await import("node:fs/promises"),
    f = await uvInstallFixture(t),
    first = runUvSetup(f, ["--repo", f.dir, "--profile", "uv-only", "--yes"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const path = join(f.bin, "uv"),
    binding = await readFile(join(f.home, ".agent-stack/binding.json"));
  await appendFile(path, "\n# local change\n");
  const changed = await readFile(path);
  const retry = runUvSetup(f, ["--yes"], { FETCH_MODE: "forbid" });
  assert.equal(retry.status, 1, retry.stdout + retry.stderr);
  assert.match(
    JSON.stringify(JSON.parse(retry.stdout).blockers),
    /Managed uv entries changed/,
  );
  assert.deepEqual(await readFile(path), changed);
  assert.deepEqual(
    await readFile(join(f.home, ".agent-stack/binding.json")),
    binding,
  );
  assert.equal(await readFile(f.marker, "utf8"), "x");
});

test("setup can bind matching external tools without a managed PATH directory", {
  skip: process.platform === "win32",
}, async (t) => {
  const { chmod } = await import("node:fs/promises"),
    f = await uvInstallFixture(t);
  await rm(join(f.home, ".agent-stack"), { recursive: true });
  for (const name of ["uv", "uvx"]) {
    await writeFile(
      join(f.tools, name),
      `#!${process.execPath}\nconsole.log('${name} 0.13.8')\n`,
    );
    await chmod(join(f.tools, name), 0o755);
  }
  const result = runUvSetup(
    f,
    ["--repo", f.dir, "--profile", "uv-only", "--yes"],
    { PATH: f.tools, FETCH_MODE: "forbid" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, "reuse");
  assert.deepEqual(await readdir(join(f.home, ".agent-stack")), [
    "binding.json",
  ]);
  await assert.rejects(readFile(f.marker));
});

test("external uv binding recovers after publication interruption without owning tools", {
  skip: process.platform === "win32",
}, async (t) => {
  const { chmod } = await import("node:fs/promises"),
    f = await uvInstallFixture(t);
  for (const name of ["uv", "uvx"]) {
    await writeFile(
      join(f.tools, name),
      `#!${process.execPath}\nconsole.log('${name} 0.13.8')\n`,
    );
    await chmod(join(f.tools, name), 0o755);
  }
  const before = await readFile(join(f.tools, "uv")),
    first = runUvSetup(f, ["--repo", f.dir, "--profile", "uv-only", "--yes"], {
      FAULT_KILL: "binding",
      FETCH_MODE: "forbid",
    });
  assert.equal(first.signal, "SIGKILL");
  const retry = runUvSetup(f, ["--yes"], { FETCH_MODE: "forbid" });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(JSON.parse(retry.stdout).mode, "reuse");
  assert.deepEqual(await readFile(join(f.tools, "uv")), before);
  const entries = await readdir(join(f.home, ".agent-stack"));
  assert.ok(!entries.includes("operation.lock"));
  assert.ok(!entries.some((x) => x.endsWith(".tmp")));
  await assert.rejects(readFile(f.marker));
});

test("setup applies an explicit relative candidate lock and remembers it", {
  skip: process.platform === "win32",
}, async (t) => {
  const { rename } = await import("node:fs/promises"),
    f = await uvInstallFixture(t),
    candidate = join(f.dir, "candidate 锁.json");
  await rename(join(f.dir, "stack/stack.lock.json"), candidate);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      f.preload,
      cli,
      "setup",
      "--repo",
      f.dir,
      "--profile",
      "uv-only",
      "--lock",
      "candidate 锁.json",
      "--yes",
      "--json",
    ],
    {
      cwd: f.dir,
      encoding: "utf8",
      timeout: 20000,
      env: { HOME: f.home, PATH: `${f.bin}:${f.tools}`, NO_COLOR: "1" },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    JSON.parse(result.stdout).binding.lock,
    await import("node:fs/promises").then(({ realpath }) =>
      realpath(candidate),
    ),
  );
  const retry = runUvSetup(f, ["--yes"], { FETCH_MODE: "forbid" });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(JSON.parse(retry.stdout).plan.lock.selectedBy, "binding");
});

test("recovery preserves a modified staged uv file and its published entry", {
  skip: process.platform === "win32",
}, async (t) => {
  const { appendFile } = await import("node:fs/promises"),
    f = await uvInstallFixture(t),
    killed = runUvSetup(f, ["--repo", f.dir, "--profile", "uv-only", "--yes"], {
      FAULT_KILL: "link",
    });
  assert.equal(killed.signal, "SIGKILL");
  const entry = join(f.bin, "uv");
  await appendFile(entry, "\n# user change\n");
  const before = await readFile(entry);
  const result = runUvSetup(
    f,
    ["--repo", f.dir, "--profile", "uv-only", "--yes"],
    { FETCH_MODE: "forbid" },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(JSON.parse(result.stdout).error, /changed; manual recovery/);
  assert.deepEqual(await readFile(entry), before);
  assert.ok(
    (await readdir(join(f.home, ".agent-stack"))).includes("pending.json"),
  );
  assert.equal(await readFile(f.marker, "utf8"), "x");
});
test("root review: managed receipt must match current asset digest", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await uvInstallFixture(t);
  const installed = runUvSetup(f, [
    "--repo",
    f.dir,
    "--profile",
    "uv-only",
    "--yes",
  ]);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const file = join(f.dir, "stack/stack.lock.json");
  const lock = JSON.parse(await readFile(file, "utf8"));
  const previous = lock.assets[0].digest.value;
  const bindingPath = join(f.home, ".agent-stack/binding.json");
  const bindingBefore = await readFile(bindingPath);
  const entryBefore = await readFile(join(f.bin, "uv"));
  lock.assets[0].digest.value =
    previous === "c".repeat(64) ? "d".repeat(64) : "c".repeat(64);
  await writeFile(file, JSON.stringify(lock));
  const repeated = runUvSetup(f, ["--yes"], { FETCH_MODE: "forbid" });
  assert.notEqual(
    repeated.status,
    0,
    "managed install must not claim success for a different archive digest",
  );
  assert.deepEqual(await readFile(bindingPath), bindingBefore);
  assert.deepEqual(await readFile(join(f.bin, "uv")), entryBefore);
  assert.equal(await readFile(f.marker, "utf8"), "x");
  lock.assets[0].digest.value = previous;
  await writeFile(file, JSON.stringify(lock));
  const legacy = JSON.parse(bindingBefore);
  delete legacy.uv.asset;
  await writeFile(bindingPath, JSON.stringify(legacy));
  const legacyResult = runUvSetup(f, ["--yes"], { FETCH_MODE: "forbid" });
  assert.notEqual(legacyResult.status, 0, legacyResult.stdout);
  assert.deepEqual(await readFile(join(f.bin, "uv")), entryBefore);
});

test("root review: reject a newly shadowing PATH executable before execution", {
  skip: process.platform === "win32",
}, async (t) => {
  const { mkdir, chmod, appendFile } = await import("node:fs/promises");
  const f = await uvInstallFixture(t);
  const shadow = join(f.dir, "new-first-path");
  await mkdir(shadow);
  for (const name of ["uv", "uvx"]) {
    await writeFile(
      join(f.tools, name),
      `#!${process.execPath}\nconsole.log('${name} 0.13.8')\n`,
    );
    await chmod(join(f.tools, name), 0o755);
  }
  const marker = join(f.dir, "unconfirmed-execution");
  const replacement = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');console.log('uv 0.13.8')\n`;
  await appendFile(
    f.preload,
    `\n{const previousExec=cp.execFile;let observedUv=0;cp.execFile=(file,args,opts,cb)=>{if(file===${JSON.stringify(join(f.tools, "uv"))}&&args[0]==='--version'&&++observedUv===2){fs.writeFileSync(${JSON.stringify(join(shadow, "uv"))},${JSON.stringify(replacement)});fs.chmodSync(${JSON.stringify(join(shadow, "uv"))},0o755);}return previousExec(file,args,opts,cb)};syncBuiltinESMExports();}\n`,
  );
  const result = runUvSetup(
    f,
    ["--repo", f.dir, "--profile", "uv-only", "--yes"],
    { FETCH_MODE: "forbid", PATH: `${shadow}:${f.bin}:${f.tools}` },
  );
  const executed = await readFile(marker, "utf8").then(
    () => true,
    () => false,
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(JSON.parse(result.stdout).error, /entries changed/);
  await assert.rejects(readFile(join(f.home, ".agent-stack/binding.json")), {
    code: "ENOENT",
  });
  assert.equal(
    executed,
    false,
    "new first PATH entry was not part of confirmed plan",
  );
});

test("root review: concurrent stale lock recovery must not remove a live owner", {
  skip: process.platform === "win32",
  timeout: 30000,
}, async (t) => {
  const { appendFile } = await import("node:fs/promises");
  const f = await uvInstallFixture(t);
  const lockPath = join(f.home, ".agent-stack/operation.lock");
  const finished = spawnSync(process.execPath, ["-e", ""], {
    encoding: "utf8",
  });
  assert.throws(() => process.kill(finished.pid, 0), { code: "ESRCH" });
  await writeFile(
    lockPath,
    JSON.stringify({ pid: finished.pid, stage: null, temporary: null }),
  );
  await appendFile(
    f.preload,
    `\n{const previousUnlink=fs.promises.unlink;let intercepted=false;fs.promises.unlink=async(p)=>{if(!intercepted&&p===${JSON.stringify(lockPath)}){intercepted=true;fs.writeFileSync(process.env.REVIEW_AT_UNLINK,'waiting');while(!fs.existsSync(process.env.REVIEW_GATE))await new Promise(r=>setTimeout(r,10));}return previousUnlink(p)};const previousFetch=globalThis.fetch;globalThis.fetch=async(...args)=>{fs.writeFileSync(process.env.REVIEW_FETCH,'started');return previousFetch(...args)};syncBuiltinESMExports();}\n`,
  );
  const children = [];
  t.after(async () => {
    for (const p of children) {
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGINT");
    }
    await Promise.all(
      children.map((p) =>
        p.exitCode !== null || p.signalCode !== null
          ? undefined
          : new Promise((resolve) => {
              p.once("close", resolve);
              setTimeout(() => {
                p.kill("SIGKILL");
              }, 2000).unref();
            }),
      ),
    );
  });
  const pathExists = async (p) =>
    readFile(p).then(
      () => true,
      () => false,
    );
  const waitFor = async (fn, label) => {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("waiting for " + label);
  };
  const start = (name) => {
    const state = {
      at: join(f.dir, name + ".at-unlink"),
      gate: join(f.dir, name + ".gate"),
      fetch: join(f.dir, name + ".fetch"),
    };
    const child = spawn(
      process.execPath,
      [
        "--import",
        f.preload,
        cli,
        "setup",
        "--repo",
        f.dir,
        "--profile",
        "uv-only",
        "--yes",
        "--json",
      ],
      {
        env: {
          HOME: f.home,
          PATH: `${f.bin}:${f.tools}`,
          NO_COLOR: "1",
          FETCH_MODE: "stall",
          REVIEW_AT_UNLINK: state.at,
          REVIEW_GATE: state.gate,
          REVIEW_FETCH: state.fetch,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    children.push(child);
    return { ...state, child };
  };
  const a = start("A");
  await waitFor(() => pathExists(a.at), "A stale lock check");
  const b = start("B");
  await waitFor(
    () => b.child.exitCode !== null || b.child.signalCode !== null,
    "B rejected",
  );
  assert.notEqual(b.child.exitCode, 0);
  assert.equal(await pathExists(b.fetch), false);
  await writeFile(a.gate, "release");
  await waitFor(() => pathExists(a.fetch), "A fetch");
  const owner = JSON.parse(await readFile(lockPath, "utf8")).pid;
  assert.equal(owner, a.child.pid);
  assert.equal(await pathExists(b.fetch), false);
});

test("setup rejects a newly shadowing entry after publication without executing it", {
  skip: process.platform === "win32",
}, async (t) => {
  const { mkdir, appendFile } = await import("node:fs/promises");
  const f = await uvInstallFixture(t);
  const shadow = join(f.dir, "first-path"),
    marker = join(f.dir, "unexpected-execution");
  await mkdir(shadow);
  const replacement = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');console.log('uv 0.13.8')\n`;
  await appendFile(
    f.preload,
    `\n{const prior=fs.promises.link;fs.promises.link=async(a,b)=>{await prior(a,b);if(b===${JSON.stringify(join(f.bin, "uvx"))}){fs.writeFileSync(${JSON.stringify(join(shadow, "uv"))},${JSON.stringify(replacement)});fs.chmodSync(${JSON.stringify(join(shadow, "uv"))},0o755)}};syncBuiltinESMExports();}\n`,
  );
  const result = runUvSetup(
    f,
    ["--repo", f.dir, "--profile", "uv-only", "--yes"],
    { PATH: `${shadow}:${f.bin}:${f.tools}` },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(JSON.parse(result.stdout).error, /not the first matching PATH/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.home, ".agent-stack/binding.json")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(f.bin, "uv")), { code: "ENOENT" });
});
