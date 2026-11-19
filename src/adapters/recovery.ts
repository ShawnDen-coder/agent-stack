import { isSea } from "node:sea";

export function cliArgv(...args: string[]): string[] {
  return isSea()
    ? [process.execPath, ...args]
    : [process.execPath, process.argv[1] as string, ...args];
}

export function displayArgv(argv: string[]): string {
  return argv
    .map((arg) =>
      process.platform === "win32"
        ? JSON.stringify(arg)
        : `'${arg.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");
}

export function lockRecovery(repo: string, path: string) {
  const argv = cliArgv("validate", "--repo", repo, "--lock", path);
  return {
    message: `Obtain or check the correct shared lock, then validate it: ${displayArgv(argv)}`,
    argv,
  };
}
