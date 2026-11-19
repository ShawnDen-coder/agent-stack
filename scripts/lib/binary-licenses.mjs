import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";

// Include declared runtime dependencies as some packages ship prebundled code.
export function writeBinaryLicenses({
  inputs,
  root,
  nodeExecutable,
  destination,
}) {
  const nodeModules = `${realpathSync(join(root, "node_modules"))}${sep}`;
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    if (input === "<define:SEA_PACKAGE_METADATA>") continue;
    const file = realpathSync(resolve(root, input));
    if (!file.startsWith(nodeModules)) continue;
    let directory = dirname(file);
    while (directory.startsWith(nodeModules)) {
      const manifestPath = join(directory, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.name && manifest.version) {
          packages.set(`${manifest.name}@${manifest.version}`, directory);
          break;
        }
      }
      directory = dirname(directory);
    }
    if (!directory.startsWith(nodeModules))
      throw new Error(`No package for bundled input: ${input}`);
  }
  if (!packages.size) throw new Error("No bundled dependencies found");
  const visited = new Set();
  const visit = (directory) => {
    const manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    const require = createRequire(join(directory, "package.json"));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      let path = dirname(realpathSync(require.resolve(name)));
      while (path.startsWith(nodeModules)) {
        const candidate = join(path, "package.json");
        if (existsSync(candidate)) {
          const dependency = JSON.parse(readFileSync(candidate, "utf8"));
          if (dependency.name === name && dependency.version) {
            const identity = `${name}@${dependency.version}`;
            packages.set(identity, path);
            if (!visited.has(path)) {
              visited.add(path);
              visit(path);
            }
            break;
          }
        }
        path = dirname(path);
      }
      if (!path.startsWith(nodeModules))
        throw new Error(`Cannot locate ${name}`);
    }
  };
  visit(root);
  mkdirSync(destination, { recursive: true });
  const nodeDir = dirname(nodeExecutable);
  const nodeLicense = [
    process.env.NODE_LICENSE_FILE,
    join(nodeDir, "LICENSE"),
    join(nodeDir, "..", "LICENSE"),
  ]
    .filter(Boolean)
    .find(existsSync);
  if (!nodeLicense) throw new Error("Node.js distribution LICENSE not found");
  copyFileSync(nodeLicense, join(destination, "NODE-LICENSE"));
  const entries = [];
  for (const [identity, directory] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const files = readdirSync(directory).filter((name) =>
      /^(licen[cs]e|copying|notice)(\..*)?$/i.test(name),
    );
    if (!files.some((name) => /^(licen[cs]e|copying)(\..*)?$/i.test(name)))
      throw new Error(`Missing license for ${identity}`);
    const target = String(entries.length + 1).padStart(3, "0");
    mkdirSync(join(destination, target));
    for (const file of files)
      copyFileSync(
        join(directory, file),
        join(destination, target, basename(file)),
      );
    entries.push(`${target} ${identity}`);
  }
  writeFileSync(
    join(destination, "INDEX.txt"),
    `Node.js ${process.versions.node}: NODE-LICENSE\n${entries.join("\n")}\n`,
  );
}
