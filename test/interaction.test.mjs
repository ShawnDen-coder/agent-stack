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
import { stripVTControlCharacters } from "node:util";
import stringWidth from "fast-string-width";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "dist/cli.js");
const driver = join(root, "test/pty_driver.py");
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "agent stack & 测试 "));
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
  const environment = {
    ...process.env,
    PATH: join(dir, "bin"),
    FORCE_COLOR: "3",
  };
  delete environment.NO_COLOR;
  const report = run(
    ["doctor", "--profile", "coding", "--repo", dir, "--json"],
    { env: environment },
  );
  assert.equal(report.status, 1);
  assert.equal(JSON.parse(report.stdout).profile, "coding");
  assert.doesNotMatch(
    report.stdout,
    new RegExp(`${String.fromCharCode(27)}\\[`),
  );
  assert.doesNotMatch(
    report.stderr,
    /Choose a profile|Inspecting toolchain|Checks complete/,
  );
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
test("empty PATH reports missing tools as failures", async (t) => {
  const { dir, bin } = await fixture(t);
  const result = run(["doctor", "--repo", dir, "--profile", "coding"], {
    env: { ...process.env, PATH: bin },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[FAIL\] npm/);
  assert.match(result.stdout, /Failed: 6 {2}Unknown: 0/);
  assert.match(result.stdout, /Next: Check PATH/);
  assert.match(result.stdout, /Integrations: pi-herdr/);
});
for (const [mode, columns, color] of [
  ["select", 80, "no-color"],
  ["select", 40, "no-color"],
  ["select", 80, "color"],
  ["select", 40, "color"],
  ["cancel", 80, "no-color"],
  ["interrupt", 80, "no-color"],
  ["ci", 80, "no-color"],
  ["dumb", 80, "no-color"],
  ["redirect-out", 80, "no-color"],
  ["redirect-err", 80, "no-color"],
]) {
  test(`PTY ${mode} ${color} at ${columns} columns`, {
    skip: process.platform === "win32",
  }, async (t) => {
    const { dir, bin } = await fixture(t);
    if (mode === "select") {
      await writeFile(join(bin, "pnpm"), "#!/bin/sh\nexit 99\n");
      await chmod(join(bin, "pnpm"), 0o755);
      await writeFile(
        join(bin, "git"),
        "#!/bin/sh\necho 'git version 2.40.0'\n",
      );
      await chmod(join(bin, "git"), 0o755);
    }
    if (mode === "interrupt") {
      await writeFile(
        join(bin, "uv"),
        `#!/bin/sh\necho $$ > '${join(dir, "probe.pid")}'\nexec /bin/sleep 10\n`,
      );
      await chmod(join(bin, "uv"), 0o755);
    }
    const profilePath = join(dir, "profiles/coding-rex.yaml");
    const text = await readFile(profilePath, "utf8");
    await writeFile(
      profilePath,
      text.replace(
        "Experimental macOS alternative",
        "工作区配置 演示 Experimental macOS alternative",
      ),
    );
    const result = spawnSync(
      "python3",
      [driver, process.execPath, cli, dir, bin, mode, String(columns), color],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const run = JSON.parse(result.stdout);
    const detail = `${run.stdout}\n${run.stderr}`;
    assert.doesNotMatch(
      run.stdout,
      /Choose a profile|Inspecting toolchain|Checks complete/,
    );
    assert.doesNotMatch(
      run.stdout,
      new RegExp(`${String.fromCharCode(27)}\\[(?:\\?[0-9;]*[ABCDEFGHJKhl])`),
    );
    if (["ci", "dumb", "redirect-out", "redirect-err"].includes(mode)) {
      assert.equal(run.sent, false, detail);
      assert.equal(run.status, 2, detail);
      assert.match(run.stderr, /--profile/);
      assert.doesNotMatch(detail, /Choose a profile/);
      return;
    }
    assert.equal(run.sent, true, detail);
    if (mode === "cancel" || mode === "interrupt") {
      assert.equal(run.status, 130, detail);
      assert.match(run.stderr, /Cancelled/);
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
      return;
    }
    assert.equal(run.status, 1, detail);
    assert.match(run.stderr, /Choose a profile/);
    assert.match(run.stderr, /工作区配置/);
    const report = stripVTControlCharacters(run.stdout).replace(/\r/g, "");
    assert.match(report, /Profile: coding\b/);
    assert.match(report, /Not checked/);
    assert.match(report, /\[FAIL\] npm/);
    assert.match(report, /\[UNKNOWN\] pnpm/);
    assert.match(report, /\[OBSERVED\] git/);
    assert.match(report, /Required: >=12.15.0 <13/);
    const section = report.split("[UNKNOWN] pnpm")[1].split("Evidence:")[0];
    const pathRows = section
      .split("Path:\n")[1]
      .split("\n")
      .filter((row) => row.startsWith("      "));
    assert.equal(
      pathRows.map((row) => row.slice(6)).join(""),
      join(bin, "pnpm"),
    );
    assert.match(
      report,
      /Summary\n {2}Matched: 1 {2}Observed: 1\n {2}Failed: 4 {2}Unknown: 1/,
    );
    assert.match(report, /Package metadata does not prove a/);
    const repository = report
      .split("Repository:\n")[1]
      .split("\nProfile:")[0]
      .split("\n")
      .map((row) => row.slice(2))
      .join("");
    assert.equal(repository, dir);
    for (const row of report.split("\n"))
      assert.ok(
        stringWidth(row) <= columns,
        `${stringWidth(row)} > ${columns}: ${row}`,
      );
    const colorEscape = new RegExp(
      `${String.fromCharCode(27)}\\[(?:3[0-7]|9[0-7]|4[0-7]|10[0-7])m`,
    );
    if (color === "color") assert.match(run.stdout, colorEscape);
    else {
      assert.doesNotMatch(run.stdout, colorEscape);
      assert.doesNotMatch(run.stderr, colorEscape);
    }
  });
}
