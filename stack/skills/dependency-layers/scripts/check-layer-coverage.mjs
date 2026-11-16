import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const extensions = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const normalize = (path) => path.split(sep).join("/");
const within = (path, root) => path.startsWith(`${root}/`);

async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Source symlink needs an explicit scope decision: ${path}`,
      );
    }
    if (entry.isDirectory()) files.push(...(await sources(path)));
    else if (entry.isFile() && extensions.test(entry.name)) files.push(path);
  }
  return files;
}

async function check() {
  const [reportPath, scopeArg, ...moduleArgs] = process.argv.slice(2);
  if (!reportPath || !scopeArg || moduleArgs.length === 0) {
    throw new Error(
      "Usage: node check-layer-coverage.mjs report.json source-root module-root...",
    );
  }
  const local = (path) => {
    const result = normalize(relative(process.cwd(), resolve(path)));
    if (!result || result === ".." || result.startsWith("../")) {
      throw new Error(
        `Use a project-relative source or module directory: ${path}`,
      );
    }
    return result;
  };
  const scope = local(scopeArg);
  const modules = moduleArgs.map(local);
  if (modules.some((module) => !within(module, scope))) {
    throw new Error("Every module root must be inside the source root");
  }
  const report = JSON.parse(
    (await readFile(reportPath, "utf8")).replace(/^\uFEFF/, ""),
  );
  if (!Array.isArray(report.modules)) {
    throw new Error("Expected a dependency-cruiser JSON report with modules");
  }
  if (!Number.isSafeInteger(report.summary?.error)) {
    throw new Error("Dependency graph has no valid error summary");
  }
  if (report.summary.error > 0 || report.summary.advisedExitCode > 0) {
    throw new Error("Dependency rules failed; inspect the reported violations");
  }
  const issues = report.summary?.environment?.issues;
  if (
    Array.isArray(issues) &&
    issues.some(
      (issue) => issue.severity === "warn" || issue.severity === "error",
    )
  ) {
    throw new Error(
      "Dependency graph has environment warnings; inspect its coverage",
    );
  }
  const graph = new Set();
  for (const module of report.modules) {
    if (typeof module.source !== "string") {
      throw new Error("A dependency graph module has no source path");
    }
    graph.add(normalize(module.source).replace(/^\.\//, ""));
  }
  const files = await sources(scope);
  if (files.length === 0)
    throw new Error(`No production sources found: ${scope}`);
  for (const file of files) {
    const owners = modules.filter((module) => within(file, module));
    if (owners.length !== 1) {
      throw new Error(
        `Expected one module owner, found ${owners.length}: ${file}`,
      );
    }
    if (!graph.has(file)) throw new Error(`Source missing from graph: ${file}`);
  }
  for (const module of modules) {
    if (!files.some((file) => within(file, module))) {
      throw new Error(`Required module has no sources: ${module}`);
    }
  }
  process.stdout.write(`Layer coverage passed: ${files.length} source files\n`);
}

try {
  await check();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
