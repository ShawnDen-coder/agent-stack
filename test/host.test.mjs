import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { observeHost } from "../dist/adapters/host.js";

test("host probe sends EOF to a real child before waiting for its result", async () => {
  const originalExecFile = cp.execFile;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const arch = Object.getOwnPropertyDescriptor(process, "arch");
  const systemRoot = process.env.SystemRoot;
  Object.defineProperty(process, "platform", { value: "win32" });
  Object.defineProperty(process, "arch", { value: "x64" });
  process.env.SystemRoot = systemRoot ?? "C:\\Windows";
  cp.execFile = (_file, _args, options, callback) => {
    let watchdog;
    const child = originalExecFile(
      process.execPath,
      [
        "-e",
        "process.stdin.resume();process.stdin.once('end',()=>process.stdout.write('0,34404'));",
      ],
      options,
      (error, stdout, stderr) => {
        clearTimeout(watchdog);
        callback(error, stdout, stderr);
      },
    );
    watchdog = setTimeout(() => child.kill("SIGKILL"), 4000);
    return child;
  };
  syncBuiltinESMExports();
  try {
    const host = await observeHost();
    assert.equal(host.native, true, JSON.stringify(host));
    assert.equal(host.evidence, "IsWow64Process2");
  } finally {
    cp.execFile = originalExecFile;
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  }
});

test("native Windows probes the actual Node process repeatedly without compilation", {
  skip: !(
    process.platform === "win32" &&
    process.arch === "x64" &&
    process.env.RUNNER_ARCH === "X64"
  ),
  timeout: 45000,
}, async () => {
  const observations = await Promise.all([
    observeHost(),
    observeHost(),
    observeHost(),
  ]);
  for (const observation of observations) {
    assert.equal(observation.target, "win32-x64");
    assert.equal(observation.native, true, JSON.stringify(observation));
    assert.equal(observation.evidence, "IsWow64Process2");
  }
});

test("native Windows fails closed when OpenProcess cannot open the target", {
  skip: !(
    process.platform === "win32" &&
    process.arch === "x64" &&
    process.env.RUNNER_ARCH === "X64"
  ),
  timeout: 45000,
}, async () => {
  const originalExecFile = cp.execFile;
  cp.execFile = (file, args, options, callback) =>
    originalExecFile(
      file,
      args,
      {
        ...options,
        env: { ...options.env, AGENT_STACK_PROBE_PID: "2147483647" },
      },
      callback,
    );
  syncBuiltinESMExports();
  try {
    const host = await observeHost();
    assert.equal(host.native, false, JSON.stringify(host));
    assert.equal(host.evidence, "probe-unknown");
  } finally {
    cp.execFile = originalExecFile;
    syncBuiltinESMExports();
  }
});
