import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { planCodingResources } from "../dist/adapters/coding-resources.js";
import { verifyCodingLock } from "../scripts/lib/coding-fixture.mjs";

const cli = resolve("dist/cli.js");

test("production lock fixture validates offline and preserves coding resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-fixture test-"));
  try {
    const repo = join(root, "repo"),
      home = join(root, "home"),
      offline = join(root, "offline.mjs");
    await mkdir(repo);
    await mkdir(home);
    await cp(resolve("stack"), join(repo, "stack"), { recursive: true });
    await verifyCodingLock(repo);
    await writeFile(
      offline,
      "globalThis.fetch=async()=>{throw Error('Unexpected network');};",
    );
    const args = [
      "--import",
      pathToFileURL(offline).href,
      cli,
      "validate",
      "--repo",
      repo,
      "--lock",
      "--json",
    ];
    const run = () =>
      spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    let result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, true);
    assert.equal(report.checked.lock.targets, 2);
    assert.equal(report.checked.lock.assets, 10);
    const lockPath = join(repo, "stack/stack.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    assert.deepEqual(
      lock.targets.map((item) => item.id),
      ["darwin-arm64", "darwin-x64"],
    );
    for (const target of lock.targets) {
      const assets = lock.assets.filter((asset) => asset.target === target.id);
      assert.deepEqual(assets.map((asset) => asset.component).sort(), [
        "herdr",
        "pi",
        "pnpm",
        "pnpm",
        "uv",
      ]);
      assert.equal(
        assets.find((asset) => asset.component === "uv").artifact.releaseId,
        443258077,
      );
    }
    const input = {
      repo,
      home,
      profile: "coding",
      target: "darwin-arm64",
      piVersion: "1.5.2",
      herdrVersion: "0.9.5",
      env: {},
    };
    const plan = await planCodingResources(input);
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(
      plan.managedSkills.map((path) => basename(path)),
      ["shape", "implement", "verify"],
    );
    const shape = await readFile(
      join(repo, "stack/skills/shape/SKILL.md"),
      "utf8",
    );
    assert.match(shape, /API 的使用样例/);
    assert.match(
      await readFile(
        join(repo, "stack/skills/dependency-layers/SKILL.md"),
        "utf8",
      ),
      /依赖边界/,
    );
    for (const match of shape.matchAll(/\]\((references\/[^)]+)\)/g))
      await readFile(join(repo, "stack/skills/shape", match[1]));
    const profilePath = join(repo, "stack/profiles/coding.yaml");
    const originalProfile = await readFile(profilePath, "utf8");
    const profile = parse(originalProfile);
    profile.components.find((item) => item.component === "pi").version =
      "1.5.3";
    await writeFile(profilePath, stringify(profile));
    result = run();
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).valid, false);
    await writeFile(profilePath, originalProfile);
    for (const [file, before, after] of [
      [
        "stack/components/pi.yaml",
        "Pi coding agent runtime",
        "Modified Pi coding agent runtime",
      ],
      [
        "stack/integrations/pi-herdr.yaml",
        "Pi state reporting through herdr's native Pi integration",
        "Modified Pi state reporting through herdr's native Pi integration",
      ],
    ]) {
      const path = join(repo, file);
      const original = await readFile(path, "utf8");
      assert(original.includes(before));
      await writeFile(path, original.replace(before, after));
      result = run();
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).valid, false);
      await writeFile(path, original);
    }
    lock.assets.find((asset) => asset.component === "uv").digest.value =
      "invalid";
    await writeFile(lockPath, JSON.stringify(lock));
    result = run();
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).valid, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid-looking digest drift in the shipped lock is rejected before installation smoke", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "coding-drift-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await mkdir(join(repo, "stack"));
  const lock = JSON.parse(
    await readFile(resolve("stack/stack.lock.json"), "utf8"),
  );
  const digest = lock.assets.find((asset) => asset.component === "uv").digest;
  digest.value = (digest.value[0] === "0" ? "1" : "0") + digest.value.slice(1);
  await writeFile(join(repo, "stack/stack.lock.json"), JSON.stringify(lock));
  await assert.rejects(verifyCodingLock(repo), /SHA-256 mismatch/);
});

test("fixture refresh refuses to overwrite a candidate before contacting sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-fixture-refresh-"));
  try {
    const target = join(root, "candidate.json");
    await writeFile(target, "existing candidate");
    const token = "test-token-not-a-credential";
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/refresh-coding-fixture.mjs"), "--out", target],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, AGENT_STACK_TEST_GITHUB_TOKEN: token },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Candidate output already exists/);
    assert(!result.stdout.includes(token) && !result.stderr.includes(token));
    assert.equal(await readFile(target, "utf8"), "existing candidate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
