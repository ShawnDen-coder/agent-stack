import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { cliPackage } from "./cli-package.js";

const manifestSchema = z.object({
  name: z.string(),
  version: z.string().min(1),
  bin: z.union([z.string(), z.record(z.string(), z.string())]),
});
export async function cliNodeRequirement(): Promise<string> {
  return cliPackage.engines.node;
}

export async function packageVersion(
  entry: string,
  name: string,
): Promise<string | null> {
  try {
    const target = await realpath(entry);
    if (!(await stat(target)).isFile()) return null;
    let directory = dirname(target);
    for (let depth = 0; depth < 5; depth++) {
      let contents: string;
      try {
        contents = await readFile(join(directory, "package.json"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
        continue;
      }
      const manifest = manifestSchema.parse(JSON.parse(contents));
      const names =
        name === "pi"
          ? ["@earendil-works/pi-coding-agent"]
          : name === "pnpm"
            ? ["pnpm", "@pnpm/exe"]
            : ["npm"];
      const bin =
        typeof manifest.bin === "string"
          ? manifest.name.split("/").at(-1) === name
            ? manifest.bin
            : undefined
          : manifest.bin[name];
      if (!names.includes(manifest.name) || !bin) return null;
      const binPath = resolve(directory, bin);
      if (!binPath.startsWith(`${directory}${sep}`)) return null;
      return (await realpath(binPath)) === target ? manifest.version : null;
    }
  } catch {
    /* malformed or absent metadata is not evidence */
  }
  return null;
}

// Corepack creates POSIX links into its own dist directory.
export async function isCorepackEntry(entry: string): Promise<boolean> {
  try {
    let directory = dirname(await realpath(entry));
    for (let depth = 0; depth < 5; depth++) {
      try {
        const manifest = z
          .object({ name: z.string() })
          .parse(
            JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
          );
        return manifest.name === "corepack";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
  } catch {
    /* missing or malformed entry */
  }
  return false;
}

// Exact cmd-shim template only; no batch syntax is evaluated.
export async function cmdShimVersion(
  path: string,
  name: string,
): Promise<string | null> {
  try {
    const wrapper = (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
    if (wrapper.length > 8192) return null;
    const head =
      "@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n";
    const match = wrapper.match(/"%dp0%\\([a-zA-Z0-9@._\\/-]+)"/g);
    if (!match) return null;
    const targetRef = match.at(-1);
    if (!targetRef) return null;
    const relative = targetRef.slice('"%dp0%\\'.length, -1);
    if (relative.split(/[\\/]/).some((part) => !part || part === "."))
      return null;
    const nodeTemplate = `${head}\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  ${targetRef} %*\n`;
    const nodeTemplateV8 = `${head}\nIF EXIST "%dp0%\\node.exe" (\n  SET "_prog=%dp0%\\node.exe"\n) ELSE (\n  SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ${targetRef} %*\n`;
    const directTemplate = `${head}${targetRef}   %*\n`;
    if (
      wrapper !== nodeTemplate &&
      wrapper !== nodeTemplateV8 &&
      wrapper !== directTemplate
    )
      return null;
    return await packageVersion(
      resolve(dirname(path), ...relative.split(/[\\/]/)),
      name,
    );
  } catch {
    return null;
  }
}
