import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  boundedFileHash,
  directoryInode,
  inode,
  optionalBytes,
  removeIfOwned,
  removeOwned,
  safeDir,
  withOperationGuard,
} from "../dist/adapters/managed-operation.js";
import {
  readDefaultBinding,
  readSetupState,
  setupStateFingerprint,
} from "../dist/adapters/setup-state.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repo, "dist/cli.js");
const unix = { skip: process.platform === "win32" };
const abcHash =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

async function fixture(t) {
  // Canonicalize macOS's /var alias before testing the no-symlink contract.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "path boundary 中文 ")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function externalBinding(root, profile = "coding") {
  return {
    schemaVersion: 1,
    repo: join(root, "checkout 中文"),
    profile,
    lock: join(root, "锁 files", "candidate.json"),
    uv: {
      version: "0.13.8",
      target: "darwin-arm64",
      mode: "external",
      directory: null,
      uvHash: null,
      uvxHash: null,
    },
  };
}
async function writeBinding(home, value) {
  const root = join(home, ".agent-stack");
  await mkdir(root, { recursive: true });
  const path = join(root, "binding.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}
function isolatedEnv(home, userprofile = home) {
  return {
    HOME: home,
    USERPROFILE: userprofile,
    PATH: "",
    NO_COLOR: "1",
    ...(process.platform === "win32"
      ? { SystemRoot: process.env.SystemRoot, PATHEXT: ".COM;.EXE;.BAT;.CMD" }
      : {}),
  };
}
function runCli(cwd, env, command, args) {
  const result = spawnSync(
    process.execPath,
    [cli, command, "--json", ...args],
    { cwd, env, encoding: "utf8", timeout: 10000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { ...result, report: JSON.parse(result.stdout) };
}

test("setup state requires an absolute home and leaves missing state absent", async (t) => {
  const home = await fixture(t);
  for (const value of [undefined, "", "relative-home", "  ", home]) {
    assert.equal(await readSetupState(value), null);
    assert.equal(await readDefaultBinding(value), null);
    assert.equal(await setupStateFingerprint(value), null);
  }
  assert.deepEqual(await readdir(home), []);
  // A real relative binding must stay ignored even when it exists in cwd.
  const relativeHome = "relative-home";
  const path = await writeBinding(
    join(home, relativeHome),
    externalBinding(home),
  );
  const before = await readFile(path);
  const moduleUrl = new URL("../dist/adapters/setup-state.js", import.meta.url)
    .href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict';
import {readSetupState, readDefaultBinding, setupStateFingerprint} from ${JSON.stringify(moduleUrl)};
for (const read of [readSetupState, readDefaultBinding, setupStateFingerprint])
  assert.equal(await read(process.argv[1]), null);`,
      relativeHome,
    ],
    { cwd: home, encoding: "utf8", timeout: 10000, env: isolatedEnv(home) },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(path), before);
});

test("setup state preserves uv v1 receipts while projecting only default context", async (t) => {
  const home = await fixture(t);
  const external = externalBinding(home);
  const managed = {
    ...external,
    uv: {
      ...external.uv,
      mode: "managed",
      directory: `uv-0.13.8-darwin-arm64-${"a".repeat(32)}`,
      uvHash: "b".repeat(64),
      uvxHash: "c".repeat(64),
      asset: {
        name: "uv-aarch64-apple-darwin.tar.gz",
        url: "https://github.com/astral-sh/uv/releases/download/0.13.8/uv-aarch64-apple-darwin.tar.gz",
        sha256: "d".repeat(64),
        releaseId: 123,
        assetId: 456,
      },
    },
  };
  // Legacy external receipts have no asset; neither shape proves Herdr applied.
  for (const value of [external, managed]) {
    const path = await writeBinding(home, value);
    const before = await readFile(path);
    assert.deepEqual(await readSetupState(home), value);
    assert.deepEqual(await readDefaultBinding(home), {
      repo: value.repo,
      profile: value.profile,
      lock: value.lock,
    });
    assert.deepEqual(await readFile(path), before);
  }
});

test("invalid or future setup state fails closed without rewriting user bytes", async (t) => {
  const home = await fixture(t);
  const valid = externalBinding(home);
  const path = await writeBinding(home, valid);
  const invalid = [
    "not JSON: private fixture marker",
    JSON.stringify({ ...valid, schemaVersion: 2 }),
    JSON.stringify({ ...valid, repo: "relative-repo" }),
    JSON.stringify({ ...valid, lock: "relative-lock" }),
    JSON.stringify({ ...valid, herdr: { version: "0.9.5" } }),
    JSON.stringify({ ...valid, uv: { ...valid.uv, directory: "claimed" } }),
    JSON.stringify({ ...valid, uv: { ...valid.uv, mode: "managed" } }),
  ];
  for (const raw of invalid) {
    await writeFile(path, raw);
    for (const read of [readSetupState, readDefaultBinding])
      await assert.rejects(read(home), {
        message: "Invalid local setup state",
      });
    assert.equal(await readFile(path, "utf8"), raw);
    assert.deepEqual(await readdir(join(home, ".agent-stack")), [
      "binding.json",
    ]);
  }
});

test("setup reads accept exactly 64 KiB and reject one additional byte", async (t) => {
  const home = await fixture(t);
  const value = externalBinding(home);
  const path = await writeBinding(home, value);
  const raw = JSON.stringify(value);
  const accepted = Buffer.concat([
    Buffer.from(raw),
    Buffer.alloc(65536 - Buffer.byteLength(raw), 0x20),
  ]);
  await writeFile(path, accepted);
  assert.deepEqual(await optionalBytes(path), accepted);
  assert.deepEqual(await readSetupState(home), value);
  assert.deepEqual(await readDefaultBinding(home), {
    repo: value.repo,
    profile: value.profile,
    lock: value.lock,
  });
  const rejected = Buffer.concat([accepted, Buffer.from(" ")]);
  await writeFile(path, rejected);
  for (const read of [
    readSetupState,
    readDefaultBinding,
    setupStateFingerprint,
  ])
    await assert.rejects(read(home), { message: "Invalid local setup state" });
  assert.deepEqual(await readFile(path), rejected);
});

test(
  "setup state refuses a symlinked binding and preserves its target",
  unix,
  async (t) => {
    const home = await fixture(t);
    const target = join(home, "private state.json");
    const raw = JSON.stringify(externalBinding(home));
    await writeFile(target, raw);
    await mkdir(join(home, ".agent-stack"));
    const path = join(home, ".agent-stack", "binding.json");
    await symlink(target, path);
    for (const read of [
      readSetupState,
      readDefaultBinding,
      setupStateFingerprint,
    ])
      await assert.rejects(read(home));
    assert.equal(await readFile(target, "utf8"), raw);
    assert.ok((await lstat(path)).isSymbolicLink());
  },
);

test("optional state bytes distinguish empty, absent and non-regular entries", async (t) => {
  const root = await fixture(t);
  const path = join(root, "empty");
  assert.equal(await optionalBytes(path), null);
  await writeFile(path, "");
  assert.deepEqual(await optionalBytes(path), Buffer.alloc(0));
  await assert.rejects(optionalBytes(root));
  assert.deepEqual(await readdir(root), ["empty"]);
});

test(
  "optional state bytes reject a FIFO without waiting for a writer",
  unix,
  async (t) => {
    const root = await fixture(t);
    const path = join(root, "state.fifo");
    const made = spawnSync("mkfifo", [path], {
      encoding: "utf8",
      timeout: 3000,
    });
    assert.equal(made.status, 0, made.stderr);
    const moduleUrl = new URL(
      "../dist/adapters/managed-operation.js",
      import.meta.url,
    ).href;
    // A child timeout keeps a regression in O_NONBLOCK from hanging the test runner.
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict';
import {optionalBytes} from ${JSON.stringify(moduleUrl)};
await assert.rejects(optionalBytes(process.argv[1]), {message: 'Invalid local setup state'});`,
        path,
      ],
      { encoding: "utf8", timeout: 4000, env: isolatedEnv(root) },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await lstat(path)).isFIFO());
  },
);

test(
  "managed directories reject writable modes and symlink traversal",
  unix,
  async (t) => {
    const root = await fixture(t);
    const owned = join(root, "owned 中文");
    await mkdir(owned, { mode: 0o700 });
    await safeDir(owned);
    for (const mode of [0o720, 0o702]) {
      await chmod(owned, mode);
      await assert.rejects(safeDir(owned), /unsafe ownership or permissions/);
    }
    await chmod(owned, 0o700);
    const alias = join(root, "alias");
    await symlink(owned, alias);
    await assert.rejects(safeDir(alias), /unsafe ownership or permissions/);
    await mkdir(join(owned, "child"), { mode: 0o700 });
    await assert.rejects(
      safeDir(join(alias, "child")),
      /must not traverse symlinks/,
    );
    assert.deepEqual(await readdir(owned), ["child"]);
  },
);

test(
  "managed identities distinguish ordinary files, directories and links",
  unix,
  async (t) => {
    const root = await fixture(t);
    const path = join(root, "file");
    await writeFile(path, "abc");
    const info = await lstat(path, { bigint: true });
    assert.deepEqual(await inode(path), {
      dev: String(info.dev),
      ino: String(info.ino),
    });
    const dirInfo = await lstat(root, { bigint: true });
    assert.deepEqual(await directoryInode(root), {
      dev: String(dirInfo.dev),
      ino: String(dirInfo.ino),
    });
    await assert.rejects(inode(root), /Cannot verify managed file ownership/);
    await assert.rejects(
      directoryInode(path),
      /Cannot verify managed directory ownership/,
    );
    const fileAlias = join(root, "file-link");
    const dirAlias = join(root, "dir-link");
    await symlink(path, fileAlias);
    await symlink(root, dirAlias);
    await assert.rejects(
      inode(fileAlias),
      /Cannot verify managed file ownership/,
    );
    await assert.rejects(
      directoryInode(dirAlias),
      /Cannot verify managed directory ownership/,
    );
  },
);

test("managed hashes bind to inode as well as bytes and detect in-place edits", async (t) => {
  const root = await fixture(t);
  const path = join(root, "uv");
  const alias = join(root, "uv-hardlink");
  await writeFile(path, "abc");
  const identity = await inode(path);
  await link(path, alias);
  assert.equal(await boundedFileHash(alias, identity), abcHash);
  await writeFile(alias, "changed locally");
  assert.notEqual(await boundedFileHash(path, identity), abcHash);
  await rename(path, join(root, "old-inode"));
  await writeFile(path, "abc");
  await assert.rejects(boundedFileHash(path, identity), /Managed file changed/);
  assert.equal(await readFile(path, "utf8"), "abc");
});

test("managed hashing rejects a file above 128 MiB without altering it", async (t) => {
  const root = await fixture(t);
  const path = join(root, "large");
  const file = await open(path, "wx");
  try {
    await file.truncate(128 * 1024 * 1024 + 1);
  } finally {
    await file.close();
  }
  await assert.rejects(
    boundedFileHash(path, await inode(path)),
    /exceeds size limit/,
  );
  assert.equal((await lstat(path)).size, 128 * 1024 * 1024 + 1);
});

test("owned deletion preserves replacements even when their bytes match", async (t) => {
  const root = await fixture(t);
  const path = join(root, "entry");
  await writeFile(path, "abc");
  const { dev, ino } = await inode(path);
  await rename(path, join(root, "original"));
  await writeFile(path, "abc");
  assert.equal(await removeIfOwned(path, dev, ino), false);
  await assert.rejects(removeOwned(path, dev, ino), /manual recovery required/);
  assert.equal(await readFile(path, "utf8"), "abc");
  assert.equal(await readFile(join(root, "original"), "utf8"), "abc");
});

test("owned deletion unlinks only its entry and permits already absent entries", async (t) => {
  const root = await fixture(t);
  const path = join(root, "entry");
  const alias = join(root, "retained");
  await writeFile(path, "abc");
  await link(path, alias);
  const { dev, ino } = await inode(path);
  assert.equal(await removeIfOwned(path, dev, ino), true);
  assert.equal(await readFile(alias, "utf8"), "abc");
  assert.equal(await removeIfOwned(path, dev, ino), true);
  await removeOwned(path, dev, ino);
  await removeOwned(alias, dev, ino);
  assert.deepEqual(await readdir(root), []);
});

test(
  "owned deletion and hashing refuse symlinks without touching their targets",
  unix,
  async (t) => {
    const root = await fixture(t);
    const target = join(root, "target");
    const path = join(root, "entry");
    await writeFile(target, "abc");
    const { dev, ino } = await inode(target);
    await symlink(target, path);
    await assert.rejects(
      removeOwned(path, dev, ino),
      /Cannot verify managed file ownership/,
    );
    await assert.rejects(
      removeIfOwned(path, dev, ino),
      /Cannot verify managed file ownership/,
    );
    await assert.rejects(boundedFileHash(path, { dev, ino }));
    assert.ok((await lstat(path)).isSymbolicLink());
    assert.equal(await readFile(target, "utf8"), "abc");
  },
);

test("operation guard excludes a contender until its owner finishes", async (t) => {
  const root = await fixture(t);
  const guard = join(root, "operation.guard");
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const owner = withOperationGuard(root, async () => {
    entered();
    await held;
    return "owner result";
  });
  try {
    await started;
    let contenderRan = false;
    await assert.rejects(
      withOperationGuard(root, async () => {
        contenderRan = true;
      }),
      /Another setup operation/,
    );
    assert.equal(contenderRan, false);
    assert.ok((await lstat(guard)).isDirectory());
  } finally {
    release();
    assert.equal(await owner, "owner result");
  }
  await assert.rejects(lstat(guard), { code: "ENOENT" });
});

test("operation guard releases on action failure and preserves the original error", async (t) => {
  const root = await fixture(t);
  const error = new Error("fixture action failed");
  await assert.rejects(
    withOperationGuard(root, async () => {
      throw error;
    }),
    (actual) => actual === error,
  );
  assert.deepEqual(await readdir(root), []);
  assert.equal(await withOperationGuard(root, async () => 42), 42);
  assert.deepEqual(await readdir(root), []);
});

test("operation guard preserves an existing interrupted guard for manual recovery", async (t) => {
  const root = await fixture(t);
  const guard = join(root, "operation.guard");
  await mkdir(guard);
  await writeFile(join(guard, "evidence"), "keep");
  let ran = false;
  await assert.rejects(
    withOperationGuard(root, async () => {
      ran = true;
    }),
    /manual recovery/,
  );
  assert.equal(ran, false);
  assert.equal(await readFile(join(guard, "evidence"), "utf8"), "keep");
});

test("CLI resolves relative repo and lock from the caller cwd with spaces and Chinese", async (t) => {
  const root = await fixture(t);
  const checkout = join(root, "checkout 中文");
  await cp(join(repo, "stack"), join(checkout, "stack"), { recursive: true });
  const home = join(root, "isolated home");
  await mkdir(home);
  const env = isolatedEnv(home);
  const doctor = runCli(root, env, "doctor", [
    "--repo",
    "checkout 中文",
    "--profile",
    "coding",
  ]);
  assert.equal(doctor.status, 1); // PATH is empty: this is context resolution only.
  assert.equal(doctor.report.profile, "coding");
  assert.ok(Array.isArray(doctor.report.checks));
  const relativeLock = "candidate 锁.json";
  await writeFile(join(root, relativeLock), "caller invalid JSON");
  await writeFile(join(checkout, relativeLock), "{}"); // Wrong repo-relative oracle.
  const setup = runCli(root, env, "setup", [
    "--repo",
    "checkout 中文",
    "--profile",
    "coding",
    "--lock",
    relativeLock,
    "--dry-run",
  ]);
  assert.equal(setup.status, 1);
  assert.equal(setup.report.error, "Lock is not valid JSON");
  assert.equal(
    await readFile(join(root, relativeLock), "utf8"),
    "caller invalid JSON",
  );
  assert.equal(await readFile(join(checkout, relativeLock), "utf8"), "{}");
  assert.deepEqual(await readdir(home), []);
});

test("CLI context uses isolated HOME binding when USERPROFILE points elsewhere", async (t) => {
  const root = await fixture(t);
  const home = join(root, "home");
  const userprofile = join(root, "other home");
  const binding = externalBinding(root, "coding-rex");
  await cp(join(repo, "stack"), join(binding.repo, "stack"), {
    recursive: true,
  });
  const homePath = await writeBinding(home, binding);
  const otherPath = await writeBinding(userprofile, {
    ...binding,
    profile: "coding",
  });
  const before = await readFile(homePath);
  const otherBefore = await readFile(otherPath);
  const result = runCli(root, isolatedEnv(home, userprofile), "doctor", []);
  assert.equal(result.status, 1);
  assert.equal(result.report.profile, "coding-rex");
  assert.deepEqual(await readFile(homePath), before);
  assert.deepEqual(await readFile(otherPath), otherBefore);
});
