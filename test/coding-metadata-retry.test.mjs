import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { retryCodingMetadataLock } from "../scripts/lib/coding-metadata.mjs";

const timeout = () =>
  Object.assign(new Error("metadata child failed"), {
    code: 1,
    signal: null,
    killed: false,
    stdout: JSON.stringify({ error: "Release metadata request timed out" }),
    stderr: "diagnostic from first attempt",
  });

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "coding-metadata-retry-"));
  try {
    await fn(join(dir, "stack.lock.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("exact metadata timeout retries once only when the lock is absent", async () => {
  await fixture(async (lockPath) => {
    const names = [],
      first = timeout();
    const result = await retryCodingMetadataLock({
      lockPath,
      wait: async () => {},
      call: async (name) => {
        names.push(name);
        if (names.length === 1) throw first;
        await writeFile(lockPath, "created by second attempt");
        return { kind: "shared-lock-created" };
      },
    });
    assert.deepEqual(names, ["lock-1", "lock-2"]);
    assert.equal(result.kind, "shared-lock-created");
    assert.match(first.stdout, /Release metadata request timed out/);
    assert.match(first.stderr, /first attempt/);
  });
});

test("non-timeout, malformed, cancelled, and non-exit failures never retry", async () => {
  await fixture(async (lockPath) => {
    for (const error of [
      Object.assign(timeout(), { stdout: '{"error":"Validation failed"}' }),
      Object.assign(timeout(), { stdout: "not json" }),
      Object.assign(timeout(), {
        stdout: '{"error":"Release metadata request timed out","extra":true}',
      }),
      Object.assign(timeout(), { code: 130 }),
      Object.assign(timeout(), { signal: "SIGINT" }),
      Object.assign(timeout(), { killed: true }),
      Object.assign(timeout(), { code: "ETIMEDOUT" }),
    ]) {
      const names = [];
      await assert.rejects(
        retryCodingMetadataLock({
          lockPath,
          wait: async () => {
            throw Error("unexpected wait");
          },
          call: async (name) => {
            names.push(name);
            throw error;
          },
        }),
        (received) => received === error,
      );
      assert.deepEqual(names, ["lock-1"]);
    }
  });
});

test("two metadata timeouts fail after exactly two attempts", async () => {
  await fixture(async (lockPath) => {
    const errors = [timeout(), timeout()],
      names = [];
    await assert.rejects(
      retryCodingMetadataLock({
        lockPath,
        wait: async () => {},
        call: async (name) => {
          names.push(name);
          throw errors[names.length - 1];
        },
      }),
      (error) => error === errors[1],
    );
    assert.deepEqual(names, ["lock-1", "lock-2"]);
  });
});

test("a lock created before retry, including a dangling symlink, blocks retry", async () => {
  for (const kind of process.platform === "win32"
    ? ["file"]
    : ["file", "symlink"])
    await fixture(async (lockPath) => {
      const names = [],
        error = timeout();
      await assert.rejects(
        retryCodingMetadataLock({
          lockPath,
          wait: async () => {
            if (kind === "file") await writeFile(lockPath, "existing lock");
            else await symlink("missing-target", lockPath);
          },
          call: async (name) => {
            names.push(name);
            throw error;
          },
        }),
        (received) => received === error,
      );
      assert.deepEqual(names, ["lock-1"]);
    });
});

test("an unexpected successful result is not retried on validation failure", async () => {
  await fixture(async (lockPath) => {
    const names = [];
    await assert.rejects(async () => {
      const result = await retryCodingMetadataLock({
        lockPath,
        wait: async () => {
          throw Error("unexpected wait");
        },
        call: async (name) => {
          names.push(name);
          return { kind: "unexpected" };
        },
      });
      assert.equal(result.kind, "shared-lock-created");
    }, assert.AssertionError);
    assert.deepEqual(names, ["lock-1"]);
  });
});
