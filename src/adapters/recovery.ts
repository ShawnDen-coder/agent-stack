import { isSea } from "node:sea";

export function cliArgv(...args: string[]): string[] {
  return isSea()
    ? [process.execPath, ...args]
    : [process.execPath, process.argv[1] as string, ...args];
}

export function displayArgv(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (
    argv.some((arg) =>
      [...arg].some((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code < 32 || (code >= 127 && code <= 159);
      }),
    )
  )
    return null;
  const quoted = argv
    .map((arg) =>
      platform === "win32"
        ? `'${arg.replace(/'/g, "''")}'`
        : `'${arg.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");
  return platform === "win32" ? `& ${quoted}` : quoted;
}

export function lockRecovery(repo: string, path: string) {
  const argv = cliArgv("validate", "--repo", repo, "--lock", path);
  return {
    message: "Obtain or check the correct shared lock, then validate it.",
    argv,
  };
}

export function setupPreview(repo: string, lockPath: string) {
  return {
    message: "Review a fresh setup plan after recovery.",
    argv: cliArgv(
      "setup",
      "--repo",
      repo,
      "--profile",
      "coding",
      "--lock",
      lockPath,
      "--dry-run",
    ),
  };
}
