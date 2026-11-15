import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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

test("state replacement recheck compares file identity and raw bytes", async (t) => {
  const { assertFileUnchanged, inode } = await import(
    "../dist/adapters/managed-operation.js"
  );
  const dir = await mkdtemp(join(tmpdir(), "state-recheck-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "binding.json");
  const original = Buffer.from([0xff]);
  await writeFile(path, original);
  const identity = await inode(path);
  await assertFileUnchanged(path, identity, original);
  await writeFile(path, Buffer.from([0xfe]));
  await assert.rejects(
    assertFileUnchanged(path, identity, original),
    /Binding changed/,
  );
  // Keep the original inode allocated so replacement cannot reuse its identity.
  await writeFile(path, original);
  await assertFileUnchanged(path, identity, original);
  const previous = join(dir, "previous-binding.json");
  await rename(path, previous);
  await writeFile(path, original);
  assert.notDeepEqual(await inode(path), identity);
  assert.deepEqual(await readFile(path), original);
  await assert.rejects(
    assertFileUnchanged(path, identity, original),
    /Binding changed/,
  );
  assert.deepEqual(await readFile(previous), original);
});

test("v1 state normalizes without changing disk or inventing asset evidence", async (t) => {
  const { readSetupState } = await import("../dist/adapters/setup-state.js");
  const home = await mkdtemp(join(tmpdir(), "setup-legacy-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".agent-stack"));
  const path = join(home, ".agent-stack", "binding.json");
  const v1 = {
    schemaVersion: 1,
    repo: home,
    profile: "uv-only",
    lock: join(home, "lock"),
    uv: {
      version: "0.13.8",
      target: "darwin-x64",
      mode: "external",
      directory: null,
      uvHash: null,
      uvxHash: null,
    },
  };
  const raw = JSON.stringify(v1);
  await writeFile(path, raw);
  const state = await readSetupState(home);
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(state.installations.uv, v1.uv);
  assert.equal(state.installations.uv.asset, undefined);
  assert.equal(await readFile(path, "utf8"), raw);
  await writeFile(path, JSON.stringify({ ...state, defaultBinding: null }));
  assert.deepEqual((await readSetupState(home)).installations.uv, v1.uv);
  await writeFile(path, JSON.stringify({ ...state, unexpected: true }));
  await assert.rejects(readSetupState(home), /Invalid local setup state/);
});

test("Windows setup context falls back to USERPROFILE only when HOME is absent", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const home = await mkdtemp(join(tmpdir(), "setup-win-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const moduleUrl = new URL("../dist/adapters/setup-state.js", import.meta.url)
    .href;
  const source = `import 'node:path';if(process.platform!=='win32')Object.defineProperty(process,'platform',{value:'win32'});const {localSetupHome}=await import(${JSON.stringify(moduleUrl)});console.log(localSetupHome())`;
  const env = {
    USERPROFILE: home,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const fallback = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { encoding: "utf8", env, timeout: 10000 },
  );
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fallback.stdout.trim(), home);
  const explicit = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      encoding: "utf8",
      env: { ...env, HOME: join(home, "explicit") },
      timeout: 10000,
    },
  );
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout.trim(), join(home, "explicit"));
});

test("managed state and hashed files reject symlink paths", {
  skip: process.platform === "win32",
}, async (t) => {
  const { symlink } = await import("node:fs/promises");
  const { boundedFileHash, inode, optionalBytes } = await import(
    "../dist/adapters/managed-operation.js"
  );
  const dir = await mkdtemp(join(tmpdir(), "setup-symlink-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "target"),
    link = join(dir, "link");
  await writeFile(target, "contents");
  const identity = await inode(target);
  await symlink(target, link);
  await assert.rejects(optionalBytes(link), /Invalid local setup state/);
  await assert.rejects(boundedFileHash(link, identity), /ownership/);
});

test("state disappearing between identity check and open fails closed", async (t) => {
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { optionalBytes } = await import(
    "../dist/adapters/managed-operation.js"
  );
  const dir = await mkdtemp(join(tmpdir(), "setup-disappear-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "binding.json");
  await writeFile(path, "{}");
  const original = fs.promises.open;
  fs.promises.open = async (candidate, ...args) => {
    if (candidate === path) await rm(path);
    return original(candidate, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(optionalBytes(path), /Invalid local setup state/);
  } finally {
    fs.promises.open = original;
    syncBuiltinESMExports();
  }
});
