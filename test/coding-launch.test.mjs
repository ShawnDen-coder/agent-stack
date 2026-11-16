import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertCodingPiArgs,
  launchCodingPi,
} from "../dist/adapters/coding-launch.js";
import { inspectHerdrContext } from "../dist/adapters/herdr-context.js";

test("coding rejects missing or unreachable Herdr pane context", async () => {
  const old = { ...process.env };
  try {
    delete process.env.HERDR_ENV;
    const input = {
      herdr: "/nonexistent",
      version: "0.9.5",
      signal: new AbortController().signal,
    };
    assert.equal((await inspectHerdrContext(input)).ready, false);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "pane";
    process.env.HERDR_SOCKET_PATH = "/nonexistent/agent-stack-herdr.sock";
    assert.equal((await inspectHerdrContext(input)).ready, false);
  } finally {
    for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
});

test("coding rejects Pi options that bypass interactive integration", () => {
  assert.throws(() => assertCodingPiArgs(["--mode=rpc"]));
  assert.throws(() => assertCodingPiArgs(["--no-skills"]));
  assert.doesNotThrow(() => assertCodingPiArgs(["--model", "example"]));
  for (const args of [
    ["--mode", "rpc"],
    ["--mode=json"],
    ["-p"],
    ["--no-skills"],
    ["-ne"],
    ["auth", "print-api-key"],
  ])
    assert.throws(() => assertCodingPiArgs(args));
  assert.doesNotThrow(() =>
    assertCodingPiArgs(["--model", "example", "--mode=text"]),
  );
  assert.doesNotThrow(() => assertCodingPiArgs(["--", "--no-skills"]));
});

test("coding launch forwards native arguments and exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-launch-"));
  try {
    const entry = join(root, "pi.mjs"),
      output = join(root, "args.json"),
      agent = join(root, "coding.md");
    const skills = ["shape", "implement", "verify"].map((name) =>
      join(root, name),
    );
    await writeFile(
      entry,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2))); process.exitCode=7;`,
    );
    const code = await launchCodingPi({
      node: process.execPath,
      pi: entry,
      agent,
      skills,
      args: ["--model", "example", "value with spaces"],
      cwd: root,
      signal: new AbortController().signal,
    });
    assert.equal(code, 7);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), [
      "--append-system-prompt",
      agent,
      "--skill",
      skills[0],
      "--skill",
      skills[1],
      "--skill",
      skills[2],
      "--model",
      "example",
      "value with spaces",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding launch uses the requested working directory and blocks non-TUI options", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-cwd-"));
  try {
    const entry = join(root, "pi.mjs"),
      marker = join(root, "cwd");
    await writeFile(
      entry,
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},process.cwd());`,
    );
    const input = {
      node: process.execPath,
      pi: entry,
      agent: join(root, "agent"),
      skills: ["a", "b", "c"].map((x) => join(root, x)),
      cwd: root,
      args: [],
      signal: new AbortController().signal,
    };
    await assert.rejects(
      launchCodingPi({ ...input, args: ["--print"] }),
      /interactive/,
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal(await launchCodingPi(input), 0);
    assert.equal(
      await realpath(await readFile(marker, "utf8")),
      await realpath(root),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding launch inherits terminal resize", {
  skip: process.platform === "win32",
}, async () => {
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "coding-resize-"));
  try {
    const entry = join(root, "pi.mjs"),
      parent = join(root, "parent.mjs");
    await writeFile(
      entry,
      `process.stdout.on('resize',()=>{console.log('SIZE:'+process.stdout.rows+':'+process.stdout.columns);process.exit(0)});console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY);setInterval(()=>{},1000);`,
    );
    const url = pathToFileURL(resolve("dist/adapters/coding-launch.js")).href;
    await writeFile(
      parent,
      `import {launchCodingPi} from ${JSON.stringify(url)}; process.exitCode=await launchCodingPi({node:${JSON.stringify(process.execPath)},pi:${JSON.stringify(entry)},agent:${JSON.stringify(join(root, "agent"))},skills:${JSON.stringify(["a", "b", "c"].map((x) => join(root, x)))},cwd:${JSON.stringify(root)},args:[],signal:new AbortController().signal});`,
    );
    const result = JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        [
          resolve("test/coding_launch_pty.py"),
          process.execPath,
          parent,
          "resize",
        ],
        { encoding: "utf8", timeout: 15000 },
      ),
    );
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /SIZE:31:101/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding launch sends an abort to the child and waits for exit", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-interrupt-"));
  try {
    const entry = join(root, "pi.mjs"),
      marker = join(root, "started");
    await writeFile(
      entry,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'ready'); setInterval(()=>{},1000);`,
    );
    const controller = new AbortController();
    const result = launchCodingPi({
      node: process.execPath,
      pi: entry,
      agent: join(root, "coding.md"),
      skills: ["a", "b", "c"].map((name) => join(root, name)),
      args: [],
      signal: controller.signal,
    });
    let started = false;
    for (let i = 0; i < 100; i++) {
      try {
        await readFile(marker);
        started = true;
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await delay(20);
      }
    }
    assert(started, "child did not start");
    controller.abort();
    assert.equal(await result, 130);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding launch preserves a real controlling terminal", {
  skip: process.platform === "win32",
}, async () => {
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "coding-pty-"));
  try {
    const entry = join(root, "pi.mjs"),
      parent = join(root, "parent.mjs");
    await writeFile(
      entry,
      `import {openSync,closeSync} from 'node:fs';const tty=openSync('/dev/tty','r');closeSync(tty);console.log('CONTROLLING:true');console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY); process.stdin.once('data',d=>{console.log('INPUT:'+d.toString().trim()); process.exit(0)});`,
    );
    const url = pathToFileURL(resolve("dist/adapters/coding-launch.js")).href;
    await writeFile(
      parent,
      `import {launchCodingPi} from ${JSON.stringify(url)}; process.exitCode=await launchCodingPi({node:${JSON.stringify(process.execPath)},pi:${JSON.stringify(entry)},agent:${JSON.stringify(join(root, "coding.md"))},skills:${JSON.stringify(["a", "b", "c"].map((name) => join(root, name)))},args:[],signal:new AbortController().signal});`,
    );
    const result = JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        [resolve("test/coding_launch_pty.py"), process.execPath, parent],
        { encoding: "utf8", timeout: 15000 },
      ),
    );
    assert.equal(result.status, 0);
    assert.equal(result.sent, true);
    assert.match(result.output, /TTY:true:true/);
    assert.match(result.output, /CONTROLLING:true/);
    assert.match(result.output, /INPUT:hello/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding launch propagates terminal Ctrl-C", {
  skip: process.platform === "win32",
}, async () => {
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "coding-pty-int-"));
  try {
    const entry = join(root, "pi.mjs"),
      parent = join(root, "parent.mjs");
    await writeFile(
      entry,
      `console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY); process.stdin.resume(); setInterval(()=>{},1000);`,
    );
    const url = pathToFileURL(resolve("dist/adapters/coding-launch.js")).href;
    await writeFile(
      parent,
      `import {launchCodingPi} from ${JSON.stringify(url)}; const c=new AbortController(); process.once('SIGINT',()=>c.abort()); process.exitCode=await launchCodingPi({node:${JSON.stringify(process.execPath)},pi:${JSON.stringify(entry)},agent:${JSON.stringify(join(root, "coding.md"))},skills:${JSON.stringify(["a", "b", "c"].map((name) => join(root, name)))},args:[],signal:c.signal});`,
    );
    const result = JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        [
          resolve("test/coding_launch_pty.py"),
          process.execPath,
          parent,
          "interrupt",
        ],
        { encoding: "utf8", timeout: 15000 },
      ),
    );
    assert.equal(result.sent, true);
    assert.equal(result.status, 130);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run command validates readiness, cwd and the native argument boundary without launching in dry-run", async () => {
  const { spawnSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "coding-command-"));
  try {
    const entry = join(root, "pi.mjs"),
      harness = join(root, "run.mjs"),
      marker = join(root, "called.json");
    await writeFile(
      entry,
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY);process.stdin.once('data',()=>process.exit(9));`,
    );
    const url = pathToFileURL(resolve("dist/commands/run.js")).href;
    await writeFile(
      harness,
      `import {createRunCommand} from ${JSON.stringify(url)};const command=createRunCommand(async()=>{if(process.env.NOT_READY==='1')throw Error('not ready');return {node:process.execPath,pi:${JSON.stringify(entry)},agent:${JSON.stringify(join(root, "coding.md"))},skills:${JSON.stringify(["a", "b", "c"].map((name) => join(root, name)))},recheck:async()=>{}}});command.exitOverride();await command.parseAsync(process.argv);`,
    );
    const denied = spawnSync(
      process.execPath,
      [harness, "coding", "--dry-run", "--json"],
      { env: { ...process.env, NOT_READY: "1" }, encoding: "utf8" },
    );
    assert.equal(denied.status, 1);
    assert.match(denied.stdout, /not ready/);
    const blocked = spawnSync(
      process.execPath,
      [harness, "coding", "--dry-run", "--json", "--", "--mode", "rpc"],
      { encoding: "utf8" },
    );
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /interactive text mode/);
    const args = ["--model", "test/model", "space value"];
    const allowed = spawnSync(
      process.execPath,
      [harness, "coding", "--cwd", root, "--dry-run", "--json", "--", ...args],
      { encoding: "utf8" },
    );
    assert.equal(allowed.status, 0, allowed.stderr);
    const plan = JSON.parse(allowed.stdout);
    assert.equal(plan.cwd, root);
    assert.deepEqual(plan.args, args);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const nonterminal = spawnSync(
      process.execPath,
      [harness, "coding", "--", ...args],
      { encoding: "utf8" },
    );
    assert.equal(nonterminal.status, 1);
    assert.match(nonterminal.stderr, /interactive terminal/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    if (process.platform !== "win32") {
      const { execFileSync } = await import("node:child_process");
      const parent = join(root, "terminal.mjs");
      await writeFile(
        parent,
        `process.env.TERM='xterm-256color';process.argv=${JSON.stringify([process.execPath, harness, "coding", "--cwd", root, "--", ...args])};await import(${JSON.stringify(pathToFileURL(harness).href)});`,
      );
      const terminal = JSON.parse(
        execFileSync(
          "/usr/bin/python3",
          [resolve("test/coding_launch_pty.py"), process.execPath, parent],
          { encoding: "utf8", timeout: 15000 },
        ),
      );
      assert.equal(terminal.status, 9, terminal.output);
      const actual = JSON.parse(await readFile(marker, "utf8"));
      assert.equal(
        actual.cwd,
        await import("node:fs/promises").then((fs) => fs.realpath(root)),
      );
      assert.deepEqual(actual.args.slice(-3), args);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal Ctrl-C is not immediately forwarded twice", {
  skip: process.platform === "win32",
}, async () => {
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "coding-pty-count-"));
  try {
    const entry = join(root, "pi.mjs"),
      parent = join(root, "parent.mjs");
    await writeFile(
      entry,
      `let count=0;process.on('SIGINT',()=>{count++;setTimeout(()=>{console.log('SIGNALS:'+count);process.exit(130)},900)});console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY);process.stdin.resume();`,
    );
    const url = pathToFileURL(resolve("dist/adapters/coding-launch.js")).href;
    await writeFile(
      parent,
      `import {launchCodingPi} from ${JSON.stringify(url)};const c=new AbortController();process.once('SIGINT',()=>c.abort());process.exitCode=await launchCodingPi({node:${JSON.stringify(process.execPath)},pi:${JSON.stringify(entry)},agent:${JSON.stringify(join(root, "coding.md"))},skills:${JSON.stringify(["a", "b", "c"].map((name) => join(root, name)))},args:[],signal:c.signal});`,
    );
    const result = JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        [
          resolve("test/coding_launch_pty.py"),
          process.execPath,
          parent,
          "interrupt",
        ],
        { encoding: "utf8", timeout: 15000 },
      ),
    );
    assert.equal(result.status, 130);
    assert.match(result.output, /SIGNALS:1(?:\r?\n)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parent-only SIGINT reaches a child with a controlling terminal", {
  skip: process.platform === "win32",
}, async () => {
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "coding-pty-count-"));
  try {
    const entry = join(root, "pi.mjs"),
      parent = join(root, "parent.mjs");
    await writeFile(
      entry,
      `let count=0;process.on('SIGINT',()=>{count++;setTimeout(()=>{console.log('SIGNALS:'+count);process.exit(130)},900)});console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY);process.stdin.resume();`,
    );
    const url = pathToFileURL(resolve("dist/adapters/coding-launch.js")).href;
    await writeFile(
      parent,
      `import {launchCodingPi} from ${JSON.stringify(url)};const c=new AbortController();process.once('SIGINT',()=>c.abort());process.exitCode=await launchCodingPi({node:${JSON.stringify(process.execPath)},pi:${JSON.stringify(entry)},agent:${JSON.stringify(join(root, "coding.md"))},skills:${JSON.stringify(["a", "b", "c"].map((name) => join(root, name)))},args:[],signal:c.signal});`,
    );
    const result = JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        [
          resolve("test/coding_launch_pty.py"),
          process.execPath,
          parent,
          "parent-sigint",
        ],
        { encoding: "utf8", timeout: 15000 },
      ),
    );
    assert.equal(result.status, 130);
    assert.match(result.output, /SIGNALS:1(?:\r?\n)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real CLI refuses coding without a verified binding before executing Pi", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdir } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "coding-not-ready-"));
  try {
    const bin = join(root, "bin"),
      marker = join(root, "called");
    await mkdir(bin);
    await writeFile(
      join(bin, "pi"),
      `#!/bin/sh\nprintf called > '${marker}'\n`,
      { mode: 0o755 },
    );
    const cli = resolve("dist/cli.js");
    const result = spawnSync(
      process.execPath,
      [cli, "--repo", root, "run", "coding"],
      {
        env: { ...process.env, HOME: root, USERPROFILE: root, PATH: bin },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /completed coding setup/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    await mkdir(join(root, ".agent-stack"));
    await writeFile(join(root, ".agent-stack", "operation.lock"), "active");
    const pending = spawnSync(
      process.execPath,
      [cli, "--repo", root, "run", "coding"],
      {
        env: { ...process.env, HOME: root, USERPROFILE: root, PATH: bin },
        encoding: "utf8",
      },
    );
    assert.equal(pending.status, 1, pending.stderr);
    assert.match(
      pending.stderr,
      /completed coding setup|setup or recovery is pending/,
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
