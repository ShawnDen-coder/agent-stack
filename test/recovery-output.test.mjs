import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { displayArgv } from "../dist/adapters/recovery.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "dist/cli.js");

test("recovery commands are single lines and copy to the same argv as JSON", {
  skip: process.platform === "win32",
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "recovery argv ' & "));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = join(temp, "very long checkout ".repeat(7)),
    home = join(temp, "home"),
    bin = join(temp, "empty bin"),
    cwd = join(temp, "business directory"),
    lock = join(temp, "missing lock ' file.json");
  await cp(join(root, "stack"), join(repo, "stack"), { recursive: true });
  await mkdir(home);
  await mkdir(bin);
  await mkdir(cwd);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: bin,
    NO_COLOR: "1",
  };
  delete env.AGENT_STACK_REPO;
  delete env.AGENT_STACK_PROFILE;
  const invoke = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15000,
    });
  for (const [args, stream, getNext] of [
    [
      ["validate", "--repo", repo, "--lock", lock],
      "stdout",
      (report) => report.issues.find((issue) => issue.file === "lock").next,
    ],
    [
      [
        "setup",
        "--repo",
        repo,
        "--profile",
        "coding",
        "--lock",
        lock,
        "--dry-run",
      ],
      "stderr",
      (report) => report.next,
    ],
    [
      ["doctor", "--repo", repo, "--profile", "coding"],
      "stdout",
      (report) => report.next.find((step) => step.argv),
    ],
    [
      ["run", "coding", "--repo", repo, "--dry-run"],
      "stderr",
      (report) => report.next,
    ],
  ]) {
    const human = invoke(args),
      json = invoke([...args, "--json"]);
    assert.equal(human.status, 1, human.stdout + human.stderr);
    assert.equal(json.status, 1, json.stdout + json.stderr);
    const argv = getNext(JSON.parse(json.stdout)).argv;
    const match = human[stream].match(/ {2}POSIX sh:\n([^\n]+)\n/);
    assert.ok(match, human[stream]);
    assert.ok(match[1].length > 80);
    const parsed = spawnSync(
      "/bin/sh",
      ["-c", `set -- ${match[1]}; printf '%s\\0' "$@"`],
      { encoding: "utf8" },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.deepEqual(parsed.stdout.split("\0").slice(0, -1), argv);
  }
});

test("Windows PowerShell formatter preserves literal argv and quotes", () => {
  const argv = [
    "C:\\Program Files\\node.exe",
    "C:\\User's folder\\cli.js",
    "--repo",
    "D:\\a b\\Bob's repo",
    "",
    "$HOME; & x",
  ];
  const text = displayArgv(argv, "win32");
  assert.equal(
    text,
    "& 'C:\\Program Files\\node.exe' 'C:\\User''s folder\\cli.js' '--repo' 'D:\\a b\\Bob''s repo' '' '$HOME; & x'",
  );
  const tokens = [...text.slice(2).matchAll(/'((?:[^']|'')*)'(?: |$)/g)].map(
    (match) => match[1].replaceAll("''", "'"),
  );
  assert.deepEqual(tokens, argv);
  assert.equal(displayArgv(["node", "bad\npath"], "win32"), null);
  assert.equal(displayArgv(["node", "bad\u001bpath"], "darwin"), null);
});
