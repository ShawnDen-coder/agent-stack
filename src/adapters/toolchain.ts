import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import type { Observation } from "../core/doctor.js";
import {
  cmdShimVersion,
  isCorepackEntry,
  packageVersion,
} from "./package-metadata.js";

async function isNativeExecutable(path: string): Promise<boolean> {
  try {
    const file = await open(path, "r");
    try {
      const header = Buffer.alloc(4);
      if ((await file.read(header, 0, 4, 0)).bytesRead !== 4) return false;
      if (process.platform === "linux")
        return header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      if (process.platform === "win32")
        return header[0] === 0x4d && header[1] === 0x5a;
      if (process.platform === "darwin")
        return [
          "feedface",
          "cefaedfe",
          "feedfacf",
          "cffaedfe",
          "cafebabe",
          "bebafeca",
          "cafebabf",
          "bfbafeca",
        ].includes(header.toString("hex"));
      return false;
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

export async function observe(
  name: string,
  signal?: AbortSignal,
): Promise<Observation> {
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
  if (!path)
    return { path, version: null, failure: "not_found", evidence: null };
  // Batch wrappers are inspected as data, never executed.
  if (/\.(cmd|bat)$/i.test(path) && process.platform === "win32") {
    const version = ["npm", "pnpm", "pi"].includes(name)
      ? await cmdShimVersion(path, name)
      : null;
    return {
      path,
      version,
      failure: version ? null : "unverified_entrypoint",
      evidence: version ? "package_metadata" : null,
    };
  }
  if (name === "pnpm" || name === "pi") {
    const version = await packageVersion(path, name);
    return {
      path,
      version,
      failure: version ? null : "unverified_entrypoint",
      evidence: version ? "package_metadata" : null,
    };
  }
  if (name === "herdr" && !(await isNativeExecutable(path)))
    return {
      path,
      version: null,
      failure: "unverified_entrypoint",
      evidence: null,
    };
  if (name === "npm" && (await isCorepackEntry(path)))
    return {
      path,
      version: null,
      failure: "unverified_entrypoint",
      evidence: null,
    };
  if (signal?.aborted)
    return { path, version: null, failure: "cancelled", evidence: null };
  const home = await mkdtemp(join(tmpdir(), "agent-stack-doctor-"));
  try {
    if (signal?.aborted)
      return { path, version: null, failure: "cancelled", evidence: null };
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
        signal?.removeEventListener("abort", abort);
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
      const abort = () => finish("cancelled", true);
      const timer = setTimeout(() => finish("timeout", true), 3000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
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
    if (result.failure)
      return {
        path,
        version: null,
        failure: result.failure,
        evidence: "version_command",
      };
    const match = result.stdout
      .trim()
      .match(
        name === "herdr"
          ? /^herdr (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
          : /^(?:git version |uv |v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s.*)?$/,
      );
    return {
      path,
      version: match?.[1] ?? null,
      failure: match ? null : "unparseable_version",
      evidence: "version_command",
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
