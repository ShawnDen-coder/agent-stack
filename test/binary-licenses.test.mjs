import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeBinaryLicenses } from "../scripts/lib/binary-licenses.mjs";

test("binary notices include declared transitive dependencies and fail closed on missing license", () => {
  const root = mkdtempSync(join(tmpdir(), "binary-licenses-"));
  const prior = process.env.NODE_LICENSE_FILE;
  try {
    delete process.env.NODE_LICENSE_FILE;
    const write = (path, data) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, data);
    };
    write(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { foo: "1.0.0" } }),
    );
    write(join(root, "LICENSE"), "Node license");
    write(join(root, "bin", "node"), "node");
    for (const [name, deps] of [
      ["foo", { bar: "1.0.0" }],
      ["bar", {}],
    ]) {
      const dir = join(root, "node_modules", name);
      write(
        join(dir, "package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          main: "index.js",
          dependencies: deps,
        }),
      );
      write(join(dir, "index.js"), "module.exports = 1");
      write(join(dir, "LICENSE"), `${name} license`);
    }
    write(join(root, "node_modules", "bar", "NOTICE"), "bar notice");
    const args = {
      inputs: { "node_modules/foo/index.js": {} },
      root,
      nodeExecutable: join(root, "bin", "node"),
      destination: join(root, "out"),
    };
    writeBinaryLicenses(args);
    const index = readFileSync(join(args.destination, "INDEX.txt"), "utf8");
    assert.match(index, /foo@1\.0\.0/);
    assert.match(index, /bar@1\.0\.0/);
    const bar = index.match(/^(\d+) bar@1\.0\.0$/m)[1];
    assert.equal(
      readFileSync(join(args.destination, bar, "NOTICE"), "utf8"),
      "bar notice",
    );
    rmSync(args.destination, { recursive: true });
    rmSync(join(root, "node_modules", "bar", "LICENSE"));
    assert.throws(() => writeBinaryLicenses(args), /Missing license for bar/);
  } finally {
    if (prior === undefined) delete process.env.NODE_LICENSE_FILE;
    else process.env.NODE_LICENSE_FILE = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
