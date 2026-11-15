import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setupStateFingerprint } from "../dist/adapters/setup-state.js";

test("setup state fingerprint hashes original bytes, including invalid UTF-8", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "setup-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".agent-stack"));
  const path = join(home, ".agent-stack", "binding.json");
  const first = Buffer.from([0xff]);
  const second = Buffer.from([0xfe]);
  await writeFile(path, first);
  assert.equal(
    await setupStateFingerprint(home),
    createHash("sha256").update(first).digest("hex"),
  );
  await writeFile(path, second);
  assert.equal(
    await setupStateFingerprint(home),
    createHash("sha256").update(second).digest("hex"),
  );
});
