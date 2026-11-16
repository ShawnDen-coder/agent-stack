import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create } from "tar";
import { inspectNpmArchive } from "../dist/adapters/npm-archive.js";

async function fixture(manifest, files = {}) {
  const root = await mkdtemp(join(tmpdir(), "npm-archive-test-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "package"));
    await writeFile(
      join(root, "package", "package.json"),
      JSON.stringify(manifest),
    );
    for (const [name, value] of Object.entries(files))
      await writeFile(join(root, "package", name), value);
    const archive = join(root, "package.tgz");
    await create({ cwd: root, gzip: true, file: archive }, ["package"]);
    return await readFile(archive);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const signal = () => new AbortController().signal;
const expected = {
  name: "@pnpm/exe.darwin-x64",
  version: "12.15.0",
  node: "24.0.0",
  native: { os: "darwin", cpu: "x64" },
};
const manifest = {
  name: expected.name,
  version: expected.version,
  os: ["darwin"],
  cpu: ["x64"],
};

test("native npm archive checks identity, target, engines and entry", async () => {
  const data = await fixture(manifest, { pnpm: "binary" });
  const result = await inspectNpmArchive(data, expected, signal());
  assert.equal(result.binary.toString(), "binary");
  assert.match(
    createHash("sha512").update(data).digest("base64"),
    /^[A-Za-z0-9+/]+==$/,
  );
  await assert.rejects(
    inspectNpmArchive(data, { ...expected, version: "12.15.1" }, signal()),
    /identity/,
  );
  await assert.rejects(
    inspectNpmArchive(
      data,
      { ...expected, native: { os: "darwin", cpu: "arm64" } },
      signal(),
    ),
    /target/,
  );
  await assert.rejects(
    inspectNpmArchive(
      await fixture(
        { ...manifest, engines: { node: ">=25" } },
        { pnpm: "binary" },
      ),
      expected,
      signal(),
    ),
    /engines/,
  );
  await assert.rejects(
    inspectNpmArchive(await fixture(manifest), expected, signal()),
    /target/,
  );
});

test("locked pnpm staging verifies both tarballs and dependency mapping", async () => {
  const { prepareLockedPnpm } = await import("../dist/adapters/npm-archive.js");
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(0x01000007, 4);
  const top = await fixture({
    name: "pnpm",
    version: "12.15.0",
    optionalDependencies: { [expected.name]: "12.15.0" },
  });
  const native = await fixture(manifest, { pnpm: binary });
  const sri = (bytes) =>
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const topUrl = "https://registry.npmjs.org/pnpm/-/pnpm-12.15.0.tgz";
  const nativeUrl =
    "https://registry.npmjs.org/@pnpm/exe.darwin-x64/-/exe.darwin-x64-12.15.0.tgz";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(url === topUrl ? top : native);
  const input = {
    top: { url: topUrl, integrity: sri(top), version: "12.15.0" },
    native: {
      url: nativeUrl,
      integrity: sri(native),
      name: expected.name,
      version: "12.15.0",
    },
    target: "darwin-x64",
    node: "24.0.0",
    signal: signal(),
  };
  try {
    assert.deepEqual(await prepareLockedPnpm(input), binary);
    await assert.rejects(
      prepareLockedPnpm({
        ...input,
        top: { ...input.top, integrity: sri(native) },
      }),
      /integrity/,
    );
    await assert.rejects(
      prepareLockedPnpm({
        ...input,
        native: { ...input.native, version: "12.15.1" },
      }),
      /distribution/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pi staging isolates npm configuration and verifies installed entry", {
  skip: process.platform !== "darwin",
}, async () => {
  const { chmod, mkdir } = await import("node:fs/promises");
  const { stagePi } = await import("../dist/adapters/pi-staging.js");
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-stage-test-")));
  const stage = join(dir, "stage");
  const npm = join(dir, "npm");
  await mkdir(stage);
  const pi = {
    name: "@earendil-works/pi-coding-agent",
    version: "1.5.2",
    bin: { pi: "dist/bundle/cli.js" },
    engines: { node: ">=22.19.0" },
  };
  const archive = await fixture(pi);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(archive);
  const script = `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');\nif (process.argv[2] === '--version') { console.log('11.12.1'); process.exit(0); }\nfs.writeFileSync('invocation.json', JSON.stringify({args:process.argv.slice(2),env:process.env}));\nconst dir = 'node_modules/@earendil-works/pi-coding-agent'; fs.mkdirSync(path.join(dir,'dist/bundle'),{recursive:true});\nfs.writeFileSync(path.join(dir,'package.json'),${JSON.stringify(JSON.stringify(pi))});\nfs.writeFileSync(path.join(dir,'dist/bundle/cli.js'), "console.log('1.5.2')");\nfs.writeFileSync('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'':{},[dir]:{version:'1.5.2'}}}));\n`;
  try {
    await writeFile(npm, script);
    await chmod(npm, 0o755);
    const result = await stagePi({
      stage,
      npm,
      node: { path: process.execPath, version: process.versions.node },
      version: "1.5.2",
      url: "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.5.2.tgz",
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      signal: signal(),
    });
    assert.equal(result.npmVersion, "11.12.1");
    const { inspectPiInstallation } = await import(
      "../dist/adapters/pi-staging.js"
    );
    await inspectPiInstallation(stage, "1.5.2", process.versions.node);
    await assert.rejects(
      inspectPiInstallation(stage, "1.5.2", "22.18.0"),
      /engines mismatch/,
    );
    const lockPath = join(stage, "package-lock.json");
    const actualLock = JSON.parse(await readFile(lockPath, "utf8"));
    actualLock.packages["node_modules/windows-only"] = {
      version: "1.0.0",
      optional: true,
      os: ["win32"],
    };
    await writeFile(lockPath, JSON.stringify(actualLock));
    await inspectPiInstallation(stage, "1.5.2", process.versions.node);
    actualLock.packages["node_modules/windows-only"].optional = false;
    await writeFile(lockPath, JSON.stringify(actualLock));
    await assert.rejects(
      inspectPiInstallation(stage, "1.5.2", process.versions.node),
      { code: "ENOENT" },
    );
    const invocation = JSON.parse(
      await readFile(join(stage, "invocation.json"), "utf8"),
    );
    assert.deepEqual(invocation.args.slice(0, 5), [
      "install",
      "--ignore-scripts",
      "--engine-strict",
      "--no-audit",
      "--no-fund",
    ]);
    assert.deepEqual(invocation.args.slice(5, 8), [
      "--global=false",
      "--prefix",
      stage,
    ]);
    assert.notEqual(
      invocation.env.npm_config_userconfig,
      invocation.env.npm_config_globalconfig,
    );
    assert.equal(invocation.env.HOME, stage);
    assert.equal(invocation.env.NPM_TOKEN, undefined);
    const changedStage = join(dir, "changed");
    await mkdir(changedStage);
    await assert.rejects(
      stagePi({
        stage: changedStage,
        npm,
        node: { path: process.execPath, version: "999.0.0" },
        version: "1.5.2",
        url: "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.5.2.tgz",
        integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
        signal: signal(),
      }),
      /Node version changed/,
    );
    await assert.rejects(readFile(join(changedStage, "invocation.json")), {
      code: "ENOENT",
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("npm archive rejects symlinks and incompatible Pi identity", async () => {
  const { mkdir, symlink } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "npm-link-test-"));
  try {
    await mkdir(join(root, "package"));
    await writeFile(
      join(root, "package", "package.json"),
      JSON.stringify(manifest),
    );
    await symlink("../../outside", join(root, "package", "link"));
    const path = join(root, "bad.tgz");
    await create({ cwd: root, gzip: true, file: path }, ["package"]);
    await assert.rejects(
      inspectNpmArchive(await readFile(path), expected, signal()),
      /Unsafe/,
    );
    await assert.rejects(
      inspectNpmArchive(
        await fixture(manifest),
        { ...expected, name: "other" },
        signal(),
      ),
      /identity/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staged tree fingerprint detects drift and rejects escaping links", {
  skip: process.platform === "win32",
}, async () => {
  const { managedTreeDigest } = await import(
    "../dist/adapters/managed-tree.js"
  );
  const { symlink, realpath } = await import("node:fs/promises");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "staged-tree-test-")),
  );
  try {
    await writeFile(join(root, "item"), "before");
    const before = await managedTreeDigest(root);
    assert.equal(await managedTreeDigest(root), before);
    await writeFile(join(root, "item"), "after");
    assert.notEqual(await managedTreeDigest(root), before);
    await symlink("../outside", join(root, "escape"));
    await assert.rejects(managedTreeDigest(root), /manual recovery/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
