import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
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
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "doctor fixture & "));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["components", "profiles", "integrations"])
    await cp(join(repo, dir), join(root, dir), { recursive: true });
  const bin = join(root, "bin");
  await mkdir(bin);
  return { root, bin };
}
async function fake(bin, name, script) {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}
async function fakePackage(bin, name, version) {
  const dir = join(bin, `package-${name}`);
  await mkdir(dir);
  const target = join(dir, "cli.js");
  await writeFile(target, "this file must never be executed");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: name === "pi" ? "@earendil-works/pi-coding-agent" : "pnpm",
      version,
      bin: { [name]: "cli.js" },
    }),
  );
  await chmod(target, 0o755);
  await symlink(target, join(bin, name));
}
function run(root, bin, args = []) {
  return spawnSync(
    process.execPath,
    [cli, "doctor", "--repo", root, "--profile", "coding", "--json", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: bin },
      timeout: 15000,
    },
  );
}
function check(report, name) {
  return report.checks.find((item) => item.name === name);
}
const unix = { skip: process.platform === "win32" };
test("doctor help and profile errors are explicit", () => {
  assert.match(
    spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" }).stdout,
    /doctor/,
  );
  const result = spawnSync(
    process.execPath,
    [cli, "doctor", "--repo", repo, "--profile", "missing", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error, /Unknown profile/);
});
test(
  "doctor reports observations, requirements and unchecked scope without touching the project",
  unix,
  async (t) => {
    const { root, bin } = await fixture(t);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@99.0.0" }),
    );
    for (const [name, version] of Object.entries({
      npm: "11.0.0",
      git: "git version 2.42.0",
      uv: "uv 0.13.8",
    }))
      await fake(bin, name, `echo 'noise' >&2\necho '${version}'`);
    await fakePackage(bin, "pnpm", "12.15.0");
    await fakePackage(bin, "pi", "1.5.2");
    const before = await readFile(join(root, "package.json"), "utf8");
    const entries = await readdir(root);
    const result = run(root, bin);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(check(report, "pnpm").requirement, ">=12.15.0 <13");
    assert.equal(check(report, "pnpm").version, "12.15.0");
    assert.equal(check(report, "pnpm").path, join(bin, "pnpm"));
    assert.equal(check(report, "pnpm").source, "unknown");
    assert.deepEqual(report.unchecked.integrations, ["pi-herdr"]);
    assert.equal(report.unchecked.components[0].component, "herdr");
    assert.equal(await readFile(join(root, "package.json"), "utf8"), before);
    assert.deepEqual(await readdir(root), entries);
    const text = spawnSync(
      process.execPath,
      [cli, "doctor", "--repo", root, "--profile", "coding"],
      { encoding: "utf8", env: { ...process.env, PATH: bin } },
    );
    assert.equal(text.status, 0);
    assert.match(text.stdout, /toolchain only/);
  },
);
test(
  "doctor distinguishes missing, mismatch, prerelease, invalid output and command failure",
  unix,
  async (t) => {
    const { root, bin } = await fixture(t);
    await fake(bin, "npm", "exit 3");
    await fake(bin, "git", "echo nonsense");
    await fakePackage(bin, "pnpm", "12.15.0-beta.1");
    await fake(bin, "uv", "echo 'uv 0.14.0'");
    const result = run(root, bin);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    for (const [name, status] of Object.entries({
      npm: "nonzero_exit",
      git: "unparseable_version",
      pnpm: "version_mismatch",
      uv: "version_mismatch",
      pi: "not_found",
    }))
      assert.equal(check(report, name).status, status);
  },
);
test("doctor times out a stalled version query", unix, async (t) => {
  const { root, bin } = await fixture(t);
  await fake(bin, "uv", "exec /bin/sleep 10");
  const result = run(root, bin);
  assert.equal(result.status, 1);
  assert.equal(check(JSON.parse(result.stdout), "uv").status, "timeout");
});

test("unknown pnpm and Pi entrypoints are not executed", unix, async (t) => {
  const { root, bin } = await fixture(t);
  for (const name of ["pnpm", "pi"])
    await fake(bin, name, `echo executed > '${join(root, "unexpected")}'`);
  const report = JSON.parse(run(root, bin).stdout);
  assert.equal(check(report, "pnpm").status, "unverified_entrypoint");
  assert.equal(check(report, "pi").status, "unverified_entrypoint");
  assert.equal((await readdir(root)).includes("unexpected"), false);
});

test(
  "unsupported profile platform is reported without executing commands",
  unix,
  async (t) => {
    const { root, bin } = await fixture(t);
    const path = join(root, "profiles/coding.json");
    const profile = JSON.parse(await readFile(path, "utf8"));
    profile.platforms = [process.platform === "darwin" ? "linux" : "darwin"];
    await writeFile(path, JSON.stringify(profile));
    await fake(bin, "uv", `echo executed > '${join(root, "unexpected")}'`);
    const report = JSON.parse(run(root, bin).stdout);
    assert.equal(check(report, "uv").status, "platform_not_applicable");
    assert.equal((await readdir(root)).includes("unexpected"), false);
  },
);

test(
  "doctor reports the first PATH candidate and limits excessive output",
  unix,
  async (t) => {
    const { root, bin } = await fixture(t);
    const second = join(root, "second");
    await mkdir(second);
    await fake(bin, "git", "echo 'git version 2.40.0'");
    await fake(second, "git", "echo 'git version 9.0.0'");
    await fake(bin, "uv", "exec /usr/bin/yes 1.2.3");
    const result = run(root, `${bin}:${second}`);
    const report = JSON.parse(result.stdout);
    assert.equal(check(report, "git").path, join(bin, "git"));
    assert.equal(check(report, "git").version, "2.40.0");
    assert.equal(check(report, "uv").status, "output_limit");
  },
);
