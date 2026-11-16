import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isNativeExecutable } from "./toolchain.js";

const runtimeSchema = z.strictObject({
  version: z.string(),
  platform: z.string(),
  arch: z.string(),
  runtime: z.literal("node"),
});

// Query the selected process, rather than inferring its architecture from the
// CLI's process or from a universal Mach-O header.
export async function assertNodeTarget(
  node: { path: string; version: string },
  target: string,
  signal: AbortSignal,
) {
  if (!(await isNativeExecutable(node.path)))
    throw Error("External Node is not a verified native entry");
  if (signal.aborted) throw Error("Cancelled");
  const home = await mkdtemp(
    join(await realpath(tmpdir()), "agent-stack-node-target-"),
  );
  try {
    const output = await new Promise<string>((done, fail) => {
      const child = execFile(
        node.path,
        [
          "--input-type=module",
          "--eval",
          "console.log(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,runtime:process.release.name}))",
        ],
        {
          cwd: home,
          env: {
            PATH: dirname(node.path),
            HOME: home,
            USERPROFILE: home,
            ...(process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
          },
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 4096,
          killSignal: "SIGKILL",
          signal,
        },
        (error, stdout) =>
          error
            ? fail(Error("Cannot verify external Node runtime target"))
            : done(stdout),
      );
      child.stdin?.end();
    });
    const runtime = runtimeSchema.parse(JSON.parse(output.trim()));
    if (runtime.version !== node.version)
      throw Error("External Node version changed after planning");
    if (`${runtime.platform}-${runtime.arch}` !== target)
      throw Error(
        "External Node version or architecture does not match the native setup target",
      );
    return runtime;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
