import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { isAbsolute } from "node:path";

export function assertCodingPiArgs(args: string[]): void {
  const forbidden = new Set([
    "--print",
    "-p",
    "--no-extensions",
    "-ne",
    "--no-skills",
    "-ns",
    "--export",
    "--list-models",
    "--help",
    "-h",
    "--version",
    "-v",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") break;
    const name = arg.split("=", 1)[0] ?? "";
    if (forbidden.has(name))
      throw new Error(
        `Pi argument ${name} bypasses the required interactive integration`,
      );
    if (name === "--mode") {
      const mode = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : args[++i];
      if (mode !== "text")
        throw new Error("Coding requires Pi interactive text mode");
    }
  }
  if (
    [
      "install",
      "remove",
      "uninstall",
      "update",
      "list",
      "config",
      "auth",
      "mcp",
    ].includes(args[0] ?? "")
  )
    throw new Error("Pi management commands cannot run as coding");
}

// Readiness and entry ownership must be verified by the caller immediately
// before launch. The native Node process inherits the caller's terminal and env.
export async function launchCodingPi(input: {
  node: string;
  pi: string;
  agent: string;
  skills: string[];
  args: string[];
  cwd?: string;
  signal: AbortSignal;
}): Promise<number> {
  if (
    ![
      input.node,
      input.pi,
      input.agent,
      input.cwd ?? process.cwd(),
      ...input.skills,
    ].every(isAbsolute) ||
    input.skills.length !== 3
  )
    throw new Error("Coding launch requires verified absolute resource paths");
  assertCodingPiArgs(input.args);
  if (input.signal.aborted) return 130;
  const args = [
    input.pi,
    "--append-system-prompt",
    input.agent,
    ...input.skills.flatMap((path) => ["--skill", path]),
    ...input.args,
  ];
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(input.node, args, {
      stdio: "inherit",
      env: process.env,
      cwd: input.cwd ?? process.cwd(),
      windowsHide: false,
    });
    let failed: Error | undefined;
    let interruptTimer: ReturnType<typeof setTimeout> | undefined;
    const forwardInterrupt = () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGINT");
    };
    const abort = () => {
      // A controlling terminal normally sends Ctrl-C to both processes. Give
      // the child a chance to exit before forwarding a parent-only interrupt.
      if (process.stdin.isTTY)
        interruptTimer = setTimeout(forwardInterrupt, 500);
      else forwardInterrupt();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    child.once("error", () => {
      failed = new Error("Cannot launch the Pi entry");
    });
    child.once("close", (code, signal) => {
      input.signal.removeEventListener("abort", abort);
      if (interruptTimer) clearTimeout(interruptTimer);
      if (failed) reject(failed);
      else if (code !== null) resolve(code);
      else
        resolve(
          signal && osConstants.signals[signal]
            ? 128 + osConstants.signals[signal]
            : 1,
        );
    });
  });
}
