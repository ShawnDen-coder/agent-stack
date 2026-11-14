import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
async function nativeHerdr(bin, output) {
  const source = join(bin, "fixture.c");
  await writeFile(
    source,
    `#include <stdio.h>\nint main(void) { puts(${JSON.stringify(output)}); return 0; }\n`,
  );
  const result = spawnSync("cc", [source, "-o", join(bin, "herdr")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  await rm(source);
}
async function setHerdrRequirement(root, requirement) {
  const file = join(root, "profiles/coding.json");
  const profile = JSON.parse(await readFile(file, "utf8"));
  profile.components = profile.components.map((item) =>
    item.component === "herdr"
      ? { component: "herdr", version: requirement }
      : item,
  );
  await writeFile(file, JSON.stringify(profile));
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
    await nativeHerdr(bin, "herdr 0.9.4");
    await setHerdrRequirement(root, ">=0.9.0 <1");
    const before = await readFile(join(root, "package.json"), "utf8");
    const entries = await readdir(root);
    const result = run(root, bin);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(check(report, "pnpm").requirement, ">=12.15.0 <13");
    assert.equal(check(report, "pnpm").version, "12.15.0");
    assert.equal(check(report, "pnpm").path, join(bin, "pnpm"));
    assert.equal(check(report, "pnpm").source, "unknown");
    assert.equal(check(report, "pnpm").evidence, "package_metadata");
    assert.equal(check(report, "uv").evidence, "version_command");
    assert.deepEqual(report.unchecked.integrations, ["pi-herdr"]);
    assert.equal(check(report, "herdr").version, "0.9.4");
    assert.equal(check(report, "herdr").evidence, "version_command");
    assert.deepEqual(report.unchecked.components, []);
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
  assert.equal(check(report, "pi").evidence, null);
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

for (const [label, body, expected] of [
  ["timeout", "setInterval(() => {}, 1000)", "timeout"],
  [
    "output limit",
    "setInterval(() => process.stdout.write('x'.repeat(65536)), 1)",
    "output_limit",
  ],
])
  test(
    `doctor enforces ${label} when a version process ignores SIGTERM`,
    unix,
    async (t) => {
      const { root, bin } = await fixture(t);
      const executable = join(bin, "uv");
      await writeFile(
        executable,
        `#!${process.execPath}\nprocess.on("SIGTERM", () => {}); ${body};\n`,
      );
      await chmod(executable, 0o755);
      const child = spawn(
        process.execPath,
        [cli, "doctor", "--repo", root, "--profile", "coding", "--json"],
        {
          cwd: root,
          env: { ...process.env, PATH: bin },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      let watchdogFired = false;
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 7000);
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }).finally(() => clearTimeout(watchdog));
      assert.equal(watchdogFired, false, "doctor exceeded the outer deadline");
      assert.equal(code, 1);
      assert.equal(check(JSON.parse(output), "uv").status, expected);
    },
  );

test(
  "doctor skips directories in PATH and follows executable symlinks",
  unix,
  async (t) => {
    const { root, bin } = await fixture(t);
    const second = join(root, "second");
    await mkdir(second);
    await mkdir(join(bin, "uv"));
    await fake(second, "uv-real", "echo 'uv 0.13.8'");
    await symlink(join(second, "uv-real"), join(second, "uv"));
    const result = run(root, `${bin}:${second}`);
    const uv = check(JSON.parse(result.stdout), "uv");
    assert.equal(uv.path, join(second, "uv"));
    assert.equal(uv.version, "0.13.8");
    assert.equal(uv.status, "ok");
  },
);

test("doctor does not run a POSIX Corepack npm symlink", unix, async (t) => {
  const { root, bin } = await fixture(t);
  const pkg = join(root, "corepack");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "corepack" }),
  );
  const target = join(pkg, "dist", "npm.js");
  await writeFile(
    target,
    `#!/bin/sh\necho executed > '${join(root, "unexpected")}'\n`,
  );
  await chmod(target, 0o755);
  await symlink(target, join(bin, "npm"));
  const report = JSON.parse(run(root, bin).stdout);
  assert.equal(check(report, "npm").status, "unverified_entrypoint");
  assert.equal(check(report, "npm").evidence, null);
  assert.equal((await readdir(root)).includes("unexpected"), false);
});

test(
  "herdr reports version and leaves stable channel unresolved",
  unix,
  async (t) => {
    const { root, bin } = await fixture(t);
    await nativeHerdr(bin, "herdr 0.9.4");
    const result = run(root, bin);
    const report = JSON.parse(result.stdout);
    const herdr = check(report, "herdr");
    assert.equal(result.status, 1);
    assert.equal(herdr.path, join(bin, "herdr"));
    assert.equal(herdr.version, "0.9.4");
    assert.equal(herdr.status, "ok");
    assert.equal(herdr.channel, "stable");
    assert.equal(herdr.evidence, "version_command");
    assert.equal(herdr.source, "unknown");
    assert.deepEqual(report.unchecked.integrations, ["pi-herdr"]);
  },
);

test(
  "herdr reports missing, version mismatch and unknown output",
  unix,
  async (t) => {
    const { root, bin } = await fixture(t);
    assert.equal(
      check(JSON.parse(run(root, bin).stdout), "herdr").status,
      "not_found",
    );
    await setHerdrRequirement(root, ">=1.0.0 <2");
    await nativeHerdr(bin, "herdr 0.9.4");
    let herdr = check(JSON.parse(run(root, bin).stdout), "herdr");
    assert.equal(herdr.status, "version_mismatch");
    assert.equal(herdr.requirement, ">=1.0.0 <2");
    await nativeHerdr(bin, "unexpected 0.9.4");
    herdr = check(JSON.parse(run(root, bin).stdout), "herdr");
    assert.equal(herdr.status, "unparseable_version");
  },
);

test("herdr skips scripts and unselected profiles", unix, async (t) => {
  const { root, bin } = await fixture(t);
  await fake(bin, "herdr", `echo executed > '${join(root, "unexpected")}'`);
  let report = JSON.parse(run(root, bin).stdout);
  assert.equal(check(report, "herdr").status, "unverified_entrypoint");
  assert.equal(check(report, "herdr").evidence, null);
  const result = spawnSync(
    process.execPath,
    [cli, "doctor", "--repo", root, "--profile", "coding-rex", "--json"],
    { encoding: "utf8", env: { ...process.env, PATH: bin } },
  );
  report = JSON.parse(result.stdout);
  assert.equal(check(report, "herdr"), undefined);
  assert.equal((await readdir(root)).includes("unexpected"), false);
});

test(
  "herdr is not queried when profile platform does not apply",
  unix,
  async (t) => {
    const { root, bin } = await fixture(t);
    const path = join(root, "profiles/coding.json");
    const profile = JSON.parse(await readFile(path, "utf8"));
    profile.platforms = [process.platform === "darwin" ? "linux" : "darwin"];
    await writeFile(path, JSON.stringify(profile));
    await nativeHerdr(bin, "herdr 0.9.4");
    const herdr = check(JSON.parse(run(root, bin).stdout), "herdr");
    assert.equal(herdr.status, "platform_not_applicable");
    assert.equal(herdr.path, null);
  },
);
