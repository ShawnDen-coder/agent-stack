import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agent-stack-release-pack-"));
try {
  const result = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp],
      { encoding: "utf8" },
    ),
  );
  if (result.length !== 1 || !result[0].filename)
    throw new Error("npm pack did not produce one tarball");
  const source = join(tmp, result[0].filename);
  execFileSync(process.execPath, ["scripts/verify-package.mjs", source], {
    stdio: "inherit",
  });
  mkdirSync("release", { recursive: true });
  const destination = resolve("release", "package.tgz");
  copyFileSync(source, destination);
  execFileSync(
    process.execPath,
    ["scripts/check-artifact.mjs", "write", destination],
    { stdio: "inherit" },
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
