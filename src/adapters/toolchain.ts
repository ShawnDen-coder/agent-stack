import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import type { Observation } from "../core/doctor.js";

export async function observe(name: string): Promise<Observation> {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter((ext) => /^\.[a-z0-9]+$/i.test(ext))
      : [""];
  let path: string | null = null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = resolve(dir, `${name}${extension}`);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, constants.X_OK);
        path = candidate;
        break;
      } catch {
        /* try the next PATH entry */
      }
    }
    if (path) break;
  }
  if (!path) return { path, version: null, failure: "not_found" };
  // Never execute potentially auto-installing package-manager or agent shims.
  if (name === "pnpm" || name === "pi") {
    try {
      const target = await realpath(path);
      let directory = dirname(target);
      for (let depth = 0; depth < 5; depth++) {
        try {
          const manifest = JSON.parse(
            await readFile(join(directory, "package.json"), "utf8"),
          ) as {
            name?: string;
            version?: string;
            bin?: string | Record<string, string>;
          };
          const expected =
            name === "pnpm" ? "pnpm" : "@earendil-works/pi-coding-agent";
          const bin =
            typeof manifest.bin === "string"
              ? manifest.bin
              : manifest.bin?.[name];
          if (
            manifest.name === expected &&
            bin &&
            (await realpath(resolve(directory, bin))) === target &&
            manifest.version
          )
            return { path, version: manifest.version, failure: null };
          break;
        } catch {
          /* find a parent manifest */
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    } catch {
      /* unresolved entry point */
    }
    return { path, version: null, failure: "unverified_entrypoint" };
  }
  // cmd.exe requires shell parsing; do not interpret paths or arbitrary batch files.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(path))
    return { path, version: null, failure: "unsupported_wrapper" };
  const home = await mkdtemp(join(tmpdir(), "agent-stack-doctor-"));
  try {
    const result = await new Promise<{
      stdout: string;
      failure: string | null;
    }>((resolveResult) => {
      const child = spawn(path, ["--version"], {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          COREPACK_ENABLE_NETWORK: "0",
          COREPACK_ENABLE_PROJECT_SPEC: "0",
          COREPACK_ENABLE_AUTO_PIN: "0",
          COREPACK_ENV_FILE: "0",
          COREPACK_DEFAULT_TO_LATEST: "0",
          COREPACK_HOME: join(home, "corepack"),
          pnpm_config_pm_on_fail: "ignore",
          npm_config_manage_package_manager_versions: "false",
          PI_CODING_AGENT_DIR: join(home, "pi"),
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let settled = false;
      const finish = (failure: string | null, terminate = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (terminate) {
          child.kill("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        }
        resolveResult({
          stdout: Buffer.concat(chunks).toString("utf8"),
          failure,
        });
      };
      const timer = setTimeout(() => finish("timeout", true), 3000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutSize += chunk.length;
        if (stdoutSize > 16384) finish("output_limit", true);
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrSize += chunk.length;
        if (stderrSize > 16384) finish("output_limit", true);
      });
      child.once("error", () => finish("execution_error"));
      child.once("close", (code) => finish(code === 0 ? null : "nonzero_exit"));
    });
    if (result.failure) return { path, version: null, failure: result.failure };
    const match = result.stdout
      .trim()
      .match(
        /^(?:git version |uv |v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s.*)?$/,
      );
    return {
      path,
      version: match?.[1] ?? null,
      failure: match ? null : "unparseable_version",
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
