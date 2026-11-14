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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "dist/cli.js");
const driver = join(root, "test/pty_driver.py");
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "agent stack & tty "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["components", "profiles", "integrations"])
    await cp(join(root, name), join(dir, name), { recursive: true });
  const bin = join(dir, "bin");
  await mkdir(bin);
  await mkdir(join(dir, "tmp"));
  return { dir, bin };
}
function run(args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 15000,
    ...extra,
  });
}
test("shared options work in either position, JSON errors are structured", async (t) => {
  const { dir } = await fixture(t);
  const left = run(["--repo", dir, "--json", "validate"]);
  const right = run(["validate", "--json", "--repo", dir]);
  assert.equal(left.status, 0, left.stderr);
  assert.deepEqual(JSON.parse(left.stdout), JSON.parse(right.stdout));
  const forced = run(["--json", "validate", "--repo", dir], {
    env: { ...process.env, FORCE_COLOR: "3" },
  });
  assert.equal(JSON.parse(forced.stdout).valid, true);
  assert.doesNotMatch(
    forced.stdout,
    new RegExp(`${String.fromCharCode(27)}\\[`),
  );
  for (const args of [
    ["--json", "doctor"],
    ["doctor", "--json", "--profile", "coding", "--profile", "coding"],
    ["--json", "validate", "--bogus"],
    ["validate", "--json", "--repo"],
    ["--repo", dir, "validate", "--repo", dir, "--json"],
    ["--json", "nonesuch"],
  ]) {
    const result = run(args, { env: { ...process.env, FORCE_COLOR: "3" } });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).error.kind, "usage");
    assert.doesNotMatch(
      result.stdout,
      new RegExp(`${String.fromCharCode(27)}\\[`),
    );
  }
  assert.equal(JSON.parse(run(["--json", "--help"]).stdout).schemaVersion, 1);
});
test("noninteractive environments never ask for a profile", async (t) => {
  const { dir } = await fixture(t);
  for (const extra of [
    {},
    { CI: "true" },
    { TERM: "dumb" },
    { NO_COLOR: "1", FORCE_COLOR: "3" },
  ]) {
    const result = run(["doctor", "--repo", dir], {
      env: { ...process.env, ...extra },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--profile/);
    assert.doesNotMatch(
      result.stdout,
      new RegExp(`Choose a profile|${String.fromCharCode(27)}\\[`),
    );
  }
  const help = run(["--help"], {
    env: { ...process.env, TERM: "dumb", FORCE_COLOR: "3" },
  });
  assert.doesNotMatch(help.stdout, new RegExp(`${String.fromCharCode(27)}\\[`));
});
for (const [mode, columns] of [
  ["select", 80],
  ["select", 40],
  ["cancel", 80],
  ["interrupt", 80],
  ["ci", 80],
  ["dumb", 80],
]) {
  test(`PTY ${mode} at ${columns} columns`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const { dir, bin } = await fixture(t);
    if (mode === "interrupt") {
      await writeFile(
        join(bin, "uv"),
        `#!/bin/sh\necho $$ > '${join(dir, "probe.pid")}'\nexec /bin/sleep 10\n`,
      );
      await chmod(join(bin, "uv"), 0o755);
    }
    const result = spawnSync(
      "python3",
      [driver, process.execPath, cli, dir, bin, mode, String(columns)],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const run = JSON.parse(result.stdout);
    if (mode === "ci" || mode === "dumb") {
      assert.equal(run.sent, false, run.output);
      assert.equal(run.status, 2, run.output);
      assert.match(run.output, /--profile/);
      assert.doesNotMatch(run.output, /Choose a profile/);
      return;
    }
    assert.equal(run.sent, true, run.output);
    if (mode === "cancel" || mode === "interrupt") {
      assert.equal(run.status, 130, run.output);
      assert.match(run.output, /Cancelled/);
      if (mode === "interrupt") {
        assert.deepEqual(await readdir(join(dir, "tmp")), []);
        const pid = Number(await readFile(join(dir, "probe.pid"), "utf8"));
        let alive = true;
        for (let attempt = 0; attempt < 20 && alive; attempt++) {
          try {
            process.kill(pid, 0);
            await new Promise((resolve) => setTimeout(resolve, 50));
          } catch (error) {
            if (error.code === "ESRCH") alive = false;
            else throw error;
          }
        }
        assert.equal(alive, false, "version probe was not terminated");
      }
    } else {
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /Profile: coding\b/);
      assert.match(run.output, /Not checked/);
    }
    assert.doesNotMatch(
      run.output,
      new RegExp(
        `${String.fromCharCode(27)}\\[(?:3[0-7]|9[0-7]|4[0-7]|10[0-7])m`,
      ),
    );
  });
}
