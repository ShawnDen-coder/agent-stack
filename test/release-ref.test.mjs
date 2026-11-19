import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("scripts/check-release-ref.mjs");
test("release gate binds tag, manifest, checkout and reviewed master history", () => {
  const cwd = mkdtempSync(join(tmpdir(), "release-ref-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    const validRepository = {
      type: "git",
      url: "git+https://github.com/ShawnDen-coder/agent-stack.git",
    };
    const manifest = (version, repository = validRepository) =>
      writeFileSync(
        join(cwd, "package.json"),
        `${JSON.stringify({
          version,
          ...(repository === null ? {} : { repository }),
        })}\n`,
      );
    manifest("1.2.3");
    git("add", "package.json");
    git("commit", "-qm", "chore: initial");
    const sha = git("rev-parse", "HEAD");
    git("tag", "1.2.3");
    git("update-ref", "refs/remotes/origin/master", sha);
    const check = (tag, expected = sha) =>
      spawnSync(process.execPath, [script], {
        cwd,
        env: { ...process.env, RELEASE_TAG: tag, EXPECTED_SHA: expected },
        encoding: "utf8",
      });
    assert.equal(check("1.2.3").status, 0);
    for (const tag of ["v1.2.3", "01.2.3", "1.2.3-01", "1.2.4", "1.2.3+build"])
      assert.notEqual(check(tag).status, 0);
    assert.notEqual(check("1.2.3", "0".repeat(40)).status, 0);
    for (const repository of [
      null,
      { type: "git", url: "git+https://github.com/other/agent-stack.git" },
      { type: "git", url: "git+https://github.com/ShawnDen-coder/other.git" },
    ]) {
      manifest("1.2.3", repository);
      const rejected = check("1.2.3");
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /repository must match/);
    }
    manifest("1.2.3");
    git("commit", "--allow-empty", "-qm", "feat: later");
    assert.notEqual(check("1.2.3").status, 0);
    const later = git("rev-parse", "HEAD");
    git("tag", "-f", "1.2.3", later);
    assert.notEqual(
      check("1.2.3", later).status,
      0,
      "unreviewed descendant must fail ancestry check",
    );
    git("update-ref", "refs/remotes/origin/master", later);
    assert.equal(check("1.2.3", later).status, 0);
    manifest("1.2.4");
    assert.notEqual(check("1.2.3", later).status, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
