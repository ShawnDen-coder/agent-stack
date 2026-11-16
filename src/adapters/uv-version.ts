import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function verifyUvVersion(
  path: string,
  name: "uv" | "uvx" | "herdr",
  version: string,
  home: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new Error("Cancelled");
  await new Promise<void>((resolve, reject) => {
    let closed = false;
    let result: Error | null | undefined;
    const finish = () => {
      if (!closed || result === undefined) return;
      if (result) reject(result);
      else resolve();
    };
    const child = execFile(
      path,
      ["--version"],
      {
        cwd: home,
        env: {
          PATH: "",
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          UV_NO_CONFIG: "1",
          UV_OFFLINE: "1",
        },
        timeout: 3000,
        maxBuffer: 16384,
        killSignal: "SIGKILL",
        encoding: "utf8",
      },
      (error, stdout) => {
        const prefix = `${name} ${version}`;
        result =
          error ||
          (stdout.trim() !== prefix && !stdout.trim().startsWith(`${prefix} `))
            ? new Error(`Cannot verify ${name} version`)
            : null;
        finish();
      },
    );
    const abort = () => {
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("close", () => {
      signal.removeEventListener("abort", abort);
      closed = true;
      finish();
    });
  });
}

export async function verifyObservedUv(
  path: string,
  name: "uv" | "uvx",
  version: string,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error("Cancelled");
  const home = await mkdtemp(join(tmpdir(), "agent-stack-uv-observe-"));
  try {
    await verifyUvVersion(path, name, version, home, signal);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
