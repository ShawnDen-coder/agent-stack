import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "dist/cli.js");

test("coding resource recovery is distinct from a complete setup", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const dir = await mkdtemp(
    join(await realpath(tmpdir()), "coding recovery fixture "),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "source checkout"),
    home = join(dir, "home"),
    bin = join(dir, "bin"),
    state = join(home, ".agent-stack"),
    managedBin = join(state, "bin");
  await cp(join(root, "stack"), join(repo, "stack"), { recursive: true });
  await mkdir(managedBin, { recursive: true, mode: 0o700 });
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  await writeFile(join(bin, "npm"), "#!/bin/sh\necho 11.12.1\n", {
    mode: 0o755,
  });
  await writeFile(join(bin, "git"), "#!/bin/sh\necho 'git version 2.40.0'\n", {
    mode: 0o755,
  });
  const lock = join(repo, "stack", "stack.lock.json");
  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: `${managedBin}:${bin}`,
    NO_COLOR: "1",
    TMPDIR: dir,
  };
  const args = ["setup", "--repo", repo, "--profile", "coding", "--lock", lock];
  const run = (extra) =>
    spawnSync(process.execPath, [cli, ...args, ...extra], {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 20000,
    });
  const normal = run(["--dry-run", "--json"]);
  assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  assert.equal(JSON.parse(normal.stdout).canApply, true);
  assert.equal(JSON.parse(normal.stdout).canRecover, false);
  await rename(join(bin, "git"), join(bin, "git.disabled"));
  const blocked = run(["--dry-run", "--json"]);
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).canApply, false);
  assert.equal(JSON.parse(blocked.stdout).canRecover, false);
  assert.ok(
    JSON.parse(blocked.stdout).blockers.some((reason) =>
      reason.includes("git"),
    ),
  );
  await rename(join(bin, "git.disabled"), join(bin, "git"));

  const stageName = `resource-stage-${"a".repeat(32)}`,
    stage = join(state, stageName);
  await mkdir(stage, { mode: 0o700 });
  const identity = await stat(stage, { bigint: true });
  const journalPath = join(state, "resources.pending.json");
  const journal = JSON.stringify({
    schemaVersion: 1,
    phase: "preparing",
    directory: stageName,
    stage: { dev: String(identity.dev), ino: String(identity.ino) },
  });
  await writeFile(journalPath, journal);
  const before = await readdir(state, { recursive: true });
  const preview = run(["--dry-run", "--json"]);
  assert.equal(preview.status, 1, preview.stdout + preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.canApply, false);
  assert.equal(plan.canRecover, true);
  assert.deepEqual(plan.blockers, [
    "Pending resource operation requires recovery",
  ]);
  assert.match(plan.recoveryNext.message, /after recovery/);
  assert.deepEqual(plan.recoveryNext.argv.slice(-8), [
    "setup",
    "--repo",
    repo,
    "--profile",
    "coding",
    "--lock",
    lock,
    "--dry-run",
  ]);
  assert.equal(await readFile(journalPath, "utf8"), journal);
  assert.deepEqual(await readdir(state, { recursive: true }), before);
  await rename(join(bin, "git"), join(bin, "git.disabled"));
  const blockedRecovery = run(["--yes", "--json"]);
  assert.equal(
    blockedRecovery.status,
    1,
    blockedRecovery.stdout + blockedRecovery.stderr,
  );
  assert.equal(JSON.parse(blockedRecovery.stdout).canApply, false);
  assert.equal(JSON.parse(blockedRecovery.stdout).canRecover, false);
  assert.equal(await readFile(journalPath, "utf8"), journal);
  await rename(join(bin, "git.disabled"), join(bin, "git"));
  const human = run(["--dry-run"]);
  assert.equal(human.status, 1);
  assert.match(
    human.stdout.slice(0, human.stdout.indexOf("Prerequisites")),
    /Can apply: no[\s\S]*Recovery can run now[\s\S]*rerun setup/,
  );

  const recovered = run(["--yes", "--json"]);
  assert.equal(recovered.status, 1, recovered.stdout + recovered.stderr);
  const result = JSON.parse(recovered.stdout);
  assert.equal(result.reason, "resource_recovered");
  assert.deepEqual(result.next.argv, plan.recoveryNext.argv);
  await assert.rejects(readFile(journalPath), { code: "ENOENT" });
  await writeFile(journalPath, journal);
  const humanRecovery = run(["--yes"]);
  assert.equal(
    humanRecovery.status,
    1,
    humanRecovery.stdout + humanRecovery.stderr,
  );
  assert.match(humanRecovery.stderr, /Previous resources recovered/);
  const command = humanRecovery.stderr.match(/ {2}POSIX sh:\n([^\n]+)\n/);
  assert.ok(command, humanRecovery.stderr);
  const parsed = spawnSync(
    "/bin/sh",
    ["-c", `set -- ${command[1]}; printf '%s\\0' "$@"`],
    { encoding: "utf8" },
  );
  assert.deepEqual(parsed.stdout.split("\0").slice(0, -1), result.next.argv);
  await assert.rejects(readFile(journalPath), { code: "ENOENT" });
  const fresh = run(["--dry-run", "--json"]);
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).canApply, true);
});
