import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("artifact checksum rejects changed bytes and malformed checksum files", () => {
  const temp = mkdtempSync(join(tmpdir(), "artifact-check-"));
  try {
    const file = join(temp, "package.tgz");
    const script = resolve("scripts/check-artifact.mjs");
    const run = (mode) =>
      spawnSync(process.execPath, [script, mode, file], { encoding: "utf8" });
    writeFileSync(file, "original");
    assert.equal(run("write").status, 0);
    assert.equal(run("verify").status, 0);
    writeFileSync(file, "changed");
    assert.notEqual(run("verify").status, 0);
    writeFileSync(`${file}.sha256`, "not a checksum\n");
    assert.notEqual(run("verify").status, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
