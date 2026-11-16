import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertNodeTarget } from "../dist/adapters/external-node.js";
import { observe } from "../dist/adapters/toolchain.js";

test("external Node observation does not execute an unknown script", {
  skip: process.platform === "win32",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-stack-node-"));
  const oldPath = process.env.PATH;
  const marker = join(dir, "executed");
  try {
    const entry = join(dir, "node");
    await writeFile(
      entry,
      `#!/bin/sh\nprintf executed > '${marker}'\nprintf 'v24.15.0\\n'\n`,
    );
    await chmod(entry, 0o755);
    process.env.PATH = dir;
    const result = await observe("node");
    assert.equal(result.failure, "unverified_entrypoint");
    await assert.rejects(
      assertNodeTarget(
        { path: entry, version: "24.15.0" },
        `${process.platform}-${process.arch}`,
        new AbortController().signal,
      ),
      /not a verified native entry/,
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("external Node observation reads a native Node version", {
  skip: process.platform === "win32",
}, async () => {
  const { symlink } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "agent-stack-node-"));
  const oldPath = process.env.PATH;
  try {
    await symlink(process.execPath, join(dir, "node"));
    process.env.PATH = dir;
    const result = await observe("node");
    assert.equal(result.failure, null);
    assert.equal(result.version, process.versions.node);
    assert.equal(result.evidence, "version_command");
    const runtime = await assertNodeTarget(
      { path: result.path, version: result.version },
      `${process.platform}-${process.arch}`,
      new AbortController().signal,
    );
    assert.equal(runtime.arch, process.arch);
    await assert.rejects(
      assertNodeTarget(
        { path: result.path, version: result.version },
        `${process.platform}-${process.arch === "arm64" ? "x64" : "arm64"}`,
        new AbortController().signal,
      ),
      /architecture/,
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});
