import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const repository = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });
  assert.ifError(result.error);
  return result;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agent-stack test "));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["components", "integrations", "profiles"]) {
    await cp(join(repository, directory), join(root, directory), {
      recursive: true,
    });
  }
  return root;
}

async function edit(root, file, change) {
  const path = join(root, file);
  const value = parseYaml(await readFile(path, "utf8"));
  change(value);
  await writeFile(path, stringifyYaml(value));
}

function validate(root) {
  const result = run(["validate", "--repo", root, "--json"]);
  return { ...result, report: JSON.parse(result.stdout) };
}

async function snapshot(root) {
  const entries = (await readdir(root, { recursive: true })).sort();
  const files = await Promise.all(
    entries
      .filter((entry) => /\.(json|yaml|yml)$/.test(entry))
      .map(async (entry) => [entry, await readFile(join(root, entry), "utf8")]),
  );
  return { entries, files };
}

test("the built CLI exposes help and its package version", async () => {
  assert.equal(run([]).status, 0);
  assert.equal(run(["--help"]).status, 0);
  assert.match(run(["--help"]).stdout, /validate/);
  const { version } = JSON.parse(
    await readFile(join(repository, "package.json"), "utf8"),
  );
  assert.equal(run(["--version"]).stdout.trim(), version);
});

test("both declared workspace combinations pass static validation", () => {
  const result = validate(repository);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.report.valid, true);
  assert.equal(result.report.checked.profiles, 2);
  assert.deepEqual(result.report.issues, []);
});

test("validation is read-only and accepts repository paths with spaces", async (t) => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const result = validate(root);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(await snapshot(root), before);
  assert.match(
    run(["validate", "--repo", root]).stdout,
    /have not been checked/,
  );
});

test("a missing selected component is reported with its profile", async (t) => {
  const root = await fixture(t);
  await edit(root, "profiles/coding.yaml", (value) => {
    value.components[0].component = "unknown-runtime";
  });
  const result = validate(root);
  assert.equal(result.status, 1);
  assert.ok(
    result.report.issues.some(
      (issue) =>
        issue.file === "profiles/coding.yaml" &&
        issue.message.includes("Unknown component: unknown-runtime"),
    ),
  );
});

test("a macOS-only component cannot silently enter a cross-platform profile", async (t) => {
  const root = await fixture(t);
  await edit(root, "profiles/coding.yaml", (value) => {
    value.components.push({ component: "otty", channel: "stable" });
  });
  const result = validate(root);
  assert.equal(result.status, 1);
  assert.ok(
    result.report.issues.some(
      (issue) => issue.message === "otty does not declare support for win32",
    ),
  );
  assert.ok(
    result.report.issues.some(
      (issue) => issue.message === "otty does not declare support for linux",
    ),
  );
});

test("replacing herdr preserves the original profile's capability requirements", async (t) => {
  const root = await fixture(t);
  await edit(root, "profiles/coding.yaml", (value) => {
    value.platforms = ["darwin"];
    value.components = value.components.map((item) =>
      item.component === "herdr" ? { component: "rex", channel: "beta" } : item,
    );
    value.integrations = ["pi-rex"];
  });
  const result = validate(root);
  assert.equal(result.status, 1);
  assert.ok(
    result.report.issues.some(
      (issue) =>
        issue.message === "Required capability is not provided: agent-status",
    ),
  );
});

test("stale integration references are rejected after a component replacement", async (t) => {
  const root = await fixture(t);
  await edit(root, "profiles/coding-rex.yaml", (value) => {
    value.integrations = ["pi-herdr"];
  });
  const result = validate(root);
  assert.equal(result.status, 1);
  assert.ok(
    result.report.issues.some(
      (issue) =>
        issue.message === "pi-herdr requires selected component: herdr",
    ),
  );
});

test("an integration with an unknown selected component cannot provide capabilities", async (t) => {
  const root = await fixture(t);
  await rm(join(root, "components/herdr.yaml"));
  const result = validate(root);
  assert.equal(result.status, 1);
  assert.ok(
    result.report.issues.some(
      (issue) =>
        issue.file === "profiles/coding.yaml" &&
        issue.message === "Required capability is not provided: agent-status",
    ),
  );
});

test("a renamed file must retain a matching definition ID", async (t) => {
  const root = await fixture(t);
  await edit(root, "components/pi.yaml", (value) => {
    value.id = "other-runtime";
  });
  const result = validate(root);
  assert.equal(result.status, 1);
  assert.match(
    result.report.issues[0].message,
    /components\/pi.yaml: id must match filename/,
  );
});

test("unsupported schema versions fail", async (t) => {
  const root = await fixture(t);
  await edit(root, "profiles/coding.yaml", (value) => {
    value.schemaVersion = 2;
  });
  const result = validate(root);
  assert.equal(result.status, 1);
  assert.equal(result.report.valid, false);
  assert.match(result.report.issues[0].message, /profiles\/coding.yaml/);
});

test("the same component cannot be selected twice", async (t) => {
  const root = await fixture(t);
  await edit(root, "profiles/coding.yaml", (value) => {
    value.components.push(value.components[0]);
  });
  const result = validate(root);
  assert.equal(result.status, 1);
  assert.match(
    result.report.issues[0].message,
    /A component can be selected only once/,
  );
});

test("a profile can select a runtime without any integration catalog", async (t) => {
  const root = await fixture(t);
  await rm(join(root, "integrations"), { recursive: true });
  await rm(join(root, "profiles/coding-rex.yaml"));
  await edit(root, "profiles/coding.yaml", (value) => {
    value.components = value.components.filter(
      (item) => item.component === "pi",
    );
    value.integrations = [];
    value.requires = ["agent-runtime"];
  });
  const result = validate(root);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.report.checked.integrations, 0);
});

test("malformed JSON and absent repositories return a failure report", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "components/pi.yaml"), "{");
  const malformed = validate(root);
  assert.equal(malformed.status, 1);
  assert.match(malformed.report.issues[0].message, /components\/pi.yaml/);
  const absent = validate(join(root, "missing"));
  assert.equal(absent.status, 1);
  assert.equal(absent.report.valid, false);
});

test("an unknown command fails rather than implying an installer exists", () => {
  const result = run(["tools", "install", "pi"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});

test("legacy JSON and yml declarations remain readable without shadowing", async (t) => {
  const root = await fixture(t);
  const source = join(root, "components/pi.yaml");
  const value = parseYaml(await readFile(source, "utf8"));
  await rm(source);
  await writeFile(join(root, "components/pi.json"), JSON.stringify(value));
  assert.equal(validate(root).status, 0);
  await writeFile(join(root, "components/pi.yml"), stringifyYaml(value));
  const duplicate = validate(root);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.report.issues[0].message, /duplicate definition/);
});

for (const [label, value] of [
  ["duplicate keys", "schemaVersion: 1\nschemaVersion: 1\n"],
  ["multiple documents", "id: pi\n---\nid: pi\n"],
  ["unknown tag", "id: !custom pi\n"],
])
  test(`YAML rejects ${label}`, async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "components/pi.yaml"), value);
    const result = validate(root);
    assert.equal(result.status, 1);
    assert.match(result.report.issues[0].message, /components\/pi.yaml/);
  });
