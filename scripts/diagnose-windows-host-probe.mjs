// Native Windows diagnostic only. This mirrors the production probe while
// emitting timing markers to stderr; it does not change host acceptance.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { machine, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (index + 1 >= args.length || args.indexOf(name, index + 1) !== -1)
    throw new Error(`Invalid ${name}`);
  return args[index + 1];
}
for (let index = 0; index < args.length; index += 2) {
  if (!["--iterations", "--concurrency", "--env"].includes(args[index]))
    throw new Error(`Unknown option: ${args[index]}`);
}
const iterations = Number(option("--iterations", "3"));
const concurrency = Number(option("--concurrency", "1"));
const environment = option("--env", "minimal");
if (
  !Number.isInteger(iterations) ||
  iterations < 1 ||
  iterations > 100 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 16 ||
  ![
    "minimal",
    "inherited",
    "system-path",
    "module-path",
    "system-path-and-module-path",
    "windir",
    "comspec",
    "appdata",
    "local-appdata",
    "system-runtime",
  ].includes(environment)
)
  throw new Error(
    "Usage: node scripts/diagnose-windows-host-probe.mjs [--iterations 1..100] [--concurrency 1..16] [--env minimal|inherited|system-path|module-path|system-path-and-module-path|windir|comspec|appdata|local-appdata|system-runtime]",
  );
if (process.platform !== "win32" || !process.env.SystemRoot)
  throw new Error(
    "This diagnostic requires native Windows and SystemRoot; no platform simulation.",
  );

const script = `$ErrorActionPreference='Stop'
$watch=[System.Diagnostics.Stopwatch]::StartNew()
function Mark($name) { [Console]::Error.WriteLine("AGENT_STACK_STAGE $name $($watch.ElapsedMilliseconds)"); [Console]::Error.Flush() }
Mark 'powershell-started'
try {
 Mark 'add-type-start'
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentStackHostProbe {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool b, int p);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsWow64Process2(IntPtr h, out ushort p, out ushort n);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
 Mark 'add-type-complete'
 $h=[AgentStackHostProbe]::OpenProcess(0x1000,$false,$env:AGENT_STACK_PROBE_PID)
 if ($h -eq [IntPtr]::Zero) { $code=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "OpenProcess failed Win32=$code" }
 Mark 'open-process-complete'
 try {
  [UInt16]$p=0; [UInt16]$n=0
  Mark 'iswow64-start'
  $ok=[AgentStackHostProbe]::IsWow64Process2($h,[ref]$p,[ref]$n)
  if (-not $ok) { $code=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "IsWow64Process2 failed Win32=$code" }
  Mark 'iswow64-complete'
  [Console]::Out.WriteLine("$p,$n"); [Console]::Out.Flush()
 } finally { [void][AgentStackHostProbe]::CloseHandle($h) }
 Mark 'probe-complete'
} catch { [Console]::Error.WriteLine("AGENT_STACK_ERROR $($_.Exception.Message)"); [Console]::Error.Flush(); exit 1 }`;
const executable = join(
  process.env.SystemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const powershellArgs = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(script, "utf16le").toString("base64"),
];
const reports = new Array(iterations);
let next = 0;
async function run(index) {
  const home = await mkdtemp(join(tmpdir(), "agent-stack-probe-diag-"));
  const report = { iteration: index + 1 };
  try {
    const env = {
      ...(environment === "inherited" ? process.env : {}),
      SystemRoot: process.env.SystemRoot,
      TEMP: home,
      TMP: home,
      USERPROFILE: home,
      AGENT_STACK_PROBE_PID: String(process.pid),
    };
    if (
      environment === "system-path" ||
      environment === "system-path-and-module-path" ||
      environment === "system-runtime"
    )
      env.PATH = join(process.env.SystemRoot, "System32");
    if (
      environment === "module-path" ||
      environment === "system-path-and-module-path" ||
      environment === "system-runtime"
    )
      env.PSModulePath = join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "Modules",
      );
    if (environment === "windir" || environment === "system-runtime")
      env.windir = process.env.SystemRoot;
    if (environment === "comspec" || environment === "system-runtime")
      env.ComSpec = join(process.env.SystemRoot, "System32", "cmd.exe");
    if (environment === "appdata" || environment === "system-runtime") {
      env.APPDATA = join(home, "AppData", "Roaming");
      await mkdir(env.APPDATA, { recursive: true });
    }
    if (environment === "local-appdata" || environment === "system-runtime") {
      env.LOCALAPPDATA = join(home, "AppData", "Local");
      await mkdir(env.LOCALAPPDATA, { recursive: true });
    }
    const started = performance.now();
    const stages = [];
    let stderrPartial = "";
    const result = await new Promise((resolve) => {
      let closed = false,
        output,
        closeInfo,
        watchdogFired = false;
      const finish = () => {
        if (closed && output) {
          clearTimeout(watchdog);
          output.watchdogFired = watchdogFired;
          resolve(output);
        }
      };
      const child = execFile(
        executable,
        powershellArgs,
        {
          cwd: home,
          env,
          timeout: 30000,
          maxBuffer: 16384,
          killSignal: "SIGKILL",
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          output = {
            stdout: stdout.slice(0, 16384),
            stderr: stderr.slice(0, 16384),
            callbackMs: Math.round(performance.now() - started),
            error: error
              ? {
                  message: error.message.slice(0, 2048),
                  code: error.code ?? null,
                  signal: error.signal ?? null,
                  killed: error.killed ?? false,
                }
              : null,
          };
          if (closeInfo) Object.assign(output, closeInfo);
          finish();
        },
      );
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 35000);
      child.stderr?.on("data", (chunk) => {
        stderrPartial += chunk.toString();
        const lines = stderrPartial.split(/\r?\n/);
        stderrPartial = lines.pop();
        for (const line of lines) {
          const match = /^AGENT_STACK_STAGE (\S+) (\d+)$/.exec(line);
          if (match)
            stages.push({
              name: match[1],
              powershellMs: Number(match[2]),
              parentMs: Math.round(performance.now() - started),
            });
        }
      });
      child.once("close", (code, signal) => {
        closed = true;
        if (output)
          Object.assign(output, {
            closeCode: code,
            closeSignal: signal,
            closeMs: Math.round(performance.now() - started),
          });
        else
          closeInfo = {
            closeCode: code,
            closeSignal: signal,
            closeMs: Math.round(performance.now() - started),
          };
        finish();
      });
      child.stdin?.end();
    });
    Object.assign(report, result, { stages });
    return report;
  } finally {
    try {
      await rm(home, { recursive: true, force: true });
    } catch (error) {
      report.cleanupError = {
        code: String(error.code ?? "unknown").slice(0, 64),
        message: String(error.message ?? error).slice(0, 2048),
      };
    }
  }
}
async function worker() {
  while (true) {
    const index = next++;
    if (index >= iterations) return;
    reports[index] = await run(index);
    console.log(JSON.stringify(reports[index]));
  }
}
console.log(
  JSON.stringify({
    kind: "windows-host-probe-diagnostic",
    platform: process.platform,
    arch: process.arch,
    machine: machine(),
    node: process.version,
    iterations,
    concurrency,
    environment,
    timeoutMs: 30000,
    maxBuffer: 16384,
  }),
);
await Promise.all(
  Array.from({ length: Math.min(concurrency, iterations) }, worker),
);
if (
  reports.some(
    (item) =>
      item.error ||
      item.cleanupError ||
      item.watchdogFired ||
      item.closeCode !== 0 ||
      item.stdout.trim() !== "0,34404" ||
      !item.stages.some((stage) => stage.name === "probe-complete"),
  )
)
  process.exitCode = 1;
