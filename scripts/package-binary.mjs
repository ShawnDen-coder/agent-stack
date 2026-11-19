import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as tar from "tar";

const [target] = process.argv.slice(2);
if (
  !/^(darwin-arm64|darwin-x64|linux-x64|win32-x64)$/.test(target ?? "") ||
  process.argv.length !== 3
)
  throw new Error("Expected supported native target");
if (`${process.platform}-${process.arch}` !== target)
  throw new Error("Build target must match native runtime");
const output = resolve("release", `agent-stack-${target}.tar.gz`);
const name = process.platform === "win32" ? "agent-stack.exe" : "agent-stack";
mkdirSync("release", { recursive: true });
await tar.create({ cwd: "binary", file: output, gzip: true }, [
  name,
  "licenses",
]);
const tmp = mkdtempSync(join(tmpdir(), "agent-stack-archive-"));
try {
  await tar.extract({ cwd: tmp, file: output, strict: true });
  execFileSync(process.execPath, ["scripts/verify-binary.mjs", tmp], {
    stdio: "inherit",
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
execFileSync(
  process.execPath,
  ["scripts/check-artifact.mjs", "write", output],
  { stdio: "inherit" },
);
