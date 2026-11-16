import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { create } from "tar";
import { hash, inode } from "../dist/adapters/managed-operation.js";
import { recordManagedTree } from "../dist/adapters/managed-tree.js";
import { applyNpmComponent } from "../dist/adapters/npm-state.js";
import { readSetupState } from "../dist/adapters/setup-state.js";
import {
  recoverPendingUv,
  withSetupOperation,
} from "../dist/adapters/uv-state.js";
import {
  managedNpmReceiptSchema,
  npmPendingSchema,
} from "../dist/core/npm-state.js";

const unix = { skip: process.platform === "win32" };
async function fixture(t, state = "before") {
  const home = await mkdtemp(
    join(await realpath(tmpdir()), "agent-stack-npm-recovery-"),
  );
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, ".agent-stack"),
    bin = join(root, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const stage = "pnpm-12.15.0-darwin-x64-0123456789abcdef0123456789abcdef";
  const directory = join(root, stage),
    source = join(directory, "pnpm"),
    entry = join(bin, "pnpm");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(source, "known native bytes\n", { mode: 0o755 });
  await writeFile(join(directory, "license"), "known license\n");
  const tree = await recordManagedTree(directory, async () => {});
  await link(source, entry);
  const before = {
    schemaVersion: 2,
    defaultBinding: {
      repo: home,
      profile: "old",
      lock: join(home, "old.lock"),
    },
    installations: {},
  };
  const assets = [
    {
      name: "pnpm",
      version: "12.15.0",
      url: "https://registry.npmjs.org/pnpm/-/pnpm-12.15.0.tgz",
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      role: "top-level",
    },
    {
      name: "@pnpm/exe.darwin-x64",
      version: "12.15.0",
      url: "https://registry.npmjs.org/@pnpm/exe.darwin-x64/-/exe.darwin-x64-12.15.0.tgz",
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      role: "native",
    },
  ];
  const receipt = managedNpmReceiptSchema.parse({
    mode: "managed",
    component: "pnpm",
    version: "12.15.0",
    target: "darwin-x64",
    directory: stage,
    entry: { ...(await inode(entry)), type: "file", target: null },
    tree,
    assets,
    npmVersion: null,
    lockHash: null,
  });
  const after = { ...before, installations: { pnpm: receipt } };
  const statePath = join(root, "binding.json"),
    journalPath = join(root, "pending.json");
  const beforeBytes = Buffer.from(JSON.stringify(before)),
    afterBytes = Buffer.from(JSON.stringify(after));
  await writeFile(statePath, beforeBytes);
  const pending = npmPendingSchema.parse({
    schemaVersion: 2,
    kind: "npm-install",
    component: "pnpm",
    stage,
    tree,
    entry: receipt.entry,
    beforeHash: hash(beforeBytes),
    beforeIdentity: await inode(statePath),
    afterHash: hash(afterBytes),
  });
  if (state === "after") await writeFile(statePath, afterBytes);
  else if (state === "third")
    await writeFile(
      statePath,
      JSON.stringify({ ...before, defaultBinding: null }),
    );
  const journal = JSON.stringify(pending);
  await writeFile(journalPath, journal);
  const recover = () =>
    recoverPendingUv(
      home,
      `${bin}:/usr/bin:/bin`,
      new AbortController().signal,
      async () => {},
    );
  return {
    home,
    root,
    bin,
    directory,
    source,
    entry,
    statePath,
    journalPath,
    journal,
    pending,
    beforeBytes,
    afterBytes,
    receipt,
    recover,
  };
}

test(
  "npm recovery before commit removes only owned files and preserves the old binding",
  unix,
  async (t) => {
    const f = await fixture(t);
    await f.recover();
    assert.deepEqual(await readFile(f.statePath), f.beforeBytes);
    await assert.rejects(readFile(f.entry), { code: "ENOENT" });
    await assert.rejects(readFile(f.source), { code: "ENOENT" });
    await assert.rejects(readFile(f.journalPath), { code: "ENOENT" });
    await f.recover();
  },
);

test(
  "npm recovery after commit retains the verified installation and clears the journal",
  unix,
  async (t) => {
    const f = await fixture(t, "after");
    await f.recover();
    assert.deepEqual(await readFile(f.statePath), f.afterBytes);
    assert.equal(await readFile(f.entry, "utf8"), "known native bytes\n");
    assert.equal(await readFile(f.source, "utf8"), "known native bytes\n");
    await assert.rejects(readFile(f.journalPath), { code: "ENOENT" });
  },
);

test(
  "npm recovery refuses third state and replacement binding identities",
  unix,
  async (t) => {
    for (const variant of ["third", "replacement"]) {
      const f = await fixture(t, variant === "third" ? "third" : "before");
      if (variant === "replacement") {
        await rename(f.statePath, join(f.root, "original-state"));
        await writeFile(f.statePath, f.beforeBytes);
      }
      await assert.rejects(f.recover(), /manual recovery/);
      assert.equal(await readFile(f.entry, "utf8"), "known native bytes\n");
      assert.equal(await readFile(f.journalPath, "utf8"), f.journal);
    }
  },
);

test(
  "npm recovery preserves drift, unknown files and unknown public entry identities",
  unix,
  async (t) => {
    for (const variant of ["drift", "extra", "unknown-entry"]) {
      const f = await fixture(t);
      if (variant === "drift") await writeFile(f.source, "local edit\n");
      if (variant === "extra")
        await writeFile(join(f.directory, "local.txt"), "retain\n");
      if (variant === "unknown-entry") {
        const pending = { ...f.pending, entry: null, afterHash: null };
        await writeFile(f.journalPath, JSON.stringify(pending));
      }
      await assert.rejects(f.recover(), /manual recovery/);
      assert.equal(
        await readFile(f.entry, "utf8"),
        variant === "drift" ? "local edit\n" : "known native bytes\n",
      );
      assert.deepEqual(await readFile(f.statePath), f.beforeBytes);
      assert((await readFile(f.journalPath)).length > 0);
    }
  },
);

test(
  "npm recovery resumes interrupted owned cleanup without taking over missing files",
  unix,
  async (t) => {
    const f = await fixture(t);
    await unlink(f.entry);
    await unlink(join(f.directory, "license"));
    await f.recover();
    await assert.rejects(readFile(f.journalPath), { code: "ENOENT" });
    await assert.rejects(readFile(f.source), { code: "ENOENT" });
    assert.deepEqual(await readFile(f.statePath), f.beforeBytes);
  },
);

test(
  "corrupt npm journal and inconsistent receipt schemas fail closed",
  unix,
  async (t) => {
    const f = await fixture(t);
    await writeFile(f.journalPath, '{"schemaVersion":2,');
    await assert.rejects(f.recover(), /Invalid local setup state/);
    assert.equal(await readFile(f.entry, "utf8"), "known native bytes\n");
    assert.equal(
      npmPendingSchema.safeParse({ ...f.pending, beforeIdentity: null })
        .success,
      false,
    );
    assert.equal(
      npmPendingSchema.safeParse({ ...f.pending, entry: null }).success,
      false,
    );
    assert.equal(
      managedNpmReceiptSchema.safeParse({ ...f.receipt, component: "pi" })
        .success,
      false,
    );
  },
);

test("a grouped npm install defers default binding and excludes a competing process", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const home = await mkdtemp(
    join(await realpath(tmpdir()), "agent-stack-npm-group-"),
  );
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, ".agent-stack"),
    bin = join(root, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const oldBinding = {
    repo: home,
    profile: "previous",
    lock: join(home, "old.lock"),
  };
  await writeFile(
    join(root, "binding.json"),
    JSON.stringify({
      schemaVersion: 2,
      defaultBinding: oldBinding,
      installations: {},
    }),
  );
  const c = join(home, "pnpm.c"),
    executable = join(home, "fixture-pnpm");
  await writeFile(
    c,
    '#include <stdio.h>\nint main(void) { puts("12.15.0"); return 0; }\n',
  );
  const compiled = spawnSync("cc", [c, "-o", executable], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(compiled.status, 0, compiled.stderr);
  const nativeName = `@pnpm/exe.darwin-${process.arch}`;
  async function archive(name, metadata, binary) {
    const dir = join(home, name);
    await mkdir(join(dir, "package"), { recursive: true });
    await writeFile(
      join(dir, "package", "package.json"),
      JSON.stringify(metadata),
    );
    if (binary) await writeFile(join(dir, "package", "pnpm"), binary);
    const path = join(dir, "asset.tgz");
    await create({ cwd: dir, gzip: true, file: path }, ["package"]);
    return await readFile(path);
  }
  const top = await archive("top", {
    name: "pnpm",
    version: "12.15.0",
    optionalDependencies: { [nativeName]: "12.15.0" },
  });
  const native = await archive(
    "native",
    {
      name: nativeName,
      version: "12.15.0",
      os: ["darwin"],
      cpu: [process.arch],
    },
    await readFile(executable),
  );
  const assets = [
    {
      name: "pnpm",
      version: "12.15.0",
      url: "https://registry.npmjs.org/pnpm/-/pnpm-12.15.0.tgz",
      role: "top-level",
      bytes: top,
    },
    {
      name: nativeName,
      version: "12.15.0",
      url: `https://registry.npmjs.org/${nativeName}/-/exe.darwin-${process.arch}-12.15.0.tgz`,
      role: "native",
      bytes: native,
    },
  ].map(({ bytes, ...asset }) => ({
    ...asset,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  }));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    new Response(url === assets[0].url ? top : native);
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const recoverUrl = new URL("../dist/adapters/uv-state.js", import.meta.url)
    .href;
  await assert.rejects(
    withSetupOperation(root, async () => {
      const result = await applyNpmComponent({
        home,
        path: `${bin}:/usr/bin:/bin`,
        repo: home,
        profile: "next",
        lock: join(home, "next.lock"),
        component: "pnpm",
        version: "12.15.0",
        target: `darwin-${process.arch}`,
        node: { path: process.execPath, version: process.versions.node },
        npm: "unused",
        assets,
        deferBinding: true,
        signal: new AbortController().signal,
        recheck: async () => {},
        checkReachable: async () => {},
      });
      assert.deepEqual(result.defaultBinding, oldBinding);
      const contender = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {recoverPendingUv} from ${JSON.stringify(recoverUrl)};try {await recoverPendingUv(${JSON.stringify(home)},${JSON.stringify(`${bin}:/usr/bin:/bin`)},new AbortController().signal,async()=>{});process.exitCode=2;}catch(e){console.log(e.message);}`,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(contender.status, 0, contender.stderr);
      assert.match(contender.stdout, /Another setup operation is running/);
      throw Error("subsequent resource application failed");
    }),
    /subsequent resource/,
  );
  const state = await readSetupState(home);
  assert.deepEqual(state.defaultBinding, oldBinding);
  assert.equal(state.installations.pnpm.mode, "managed");
  assert.equal(
    await readFile(join(bin, "pnpm"), "utf8"),
    await readFile(executable, "utf8"),
  );
  assert.equal(
    JSON.parse(await readFile(join(root, "operation.lock"), "utf8")).pid,
    process.pid,
  );
});
