import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { planCodingResources } from "../dist/adapters/coding-resources.js";
import { localSetupHome } from "../dist/adapters/setup-state.js";

const fixture = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`./fixtures/native-paths/${name}`, import.meta.url),
      "utf8",
    ),
  );
const plan = (home, env) =>
  planCodingResources({
    repo: resolve("."),
    home,
    env,
    profile: "coding",
    target: "darwin-x64",
    piVersion: "1.5.2",
    herdrVersion: "0.9.5",
  });

test("Pi native agent-directory fixtures drive the resource planner", {
  skip: process.platform === "win32",
}, async () => {
  const data = await fixture("pi-v1.5.2.json");
  for (const item of data.cases.filter(
    (c) => c.input.platform === "darwin" && c.expected.agentDir,
  )) {
    if (item.id === "relative-agent-dir-is-not-made-absolute-by-getAgentDir") {
      await assert.rejects(
        plan(item.input.homedir, item.input.env),
        /Pi agent directory must be absolute/,
        item.id,
      );
    } else {
      const result = await plan(item.input.homedir, item.input.env);
      assert.equal(
        result.files[0].target,
        join(item.expected.agentDir, "settings.json"),
        item.id,
      );
      assert.equal(
        result.files[2].target,
        join(item.expected.agentDir, "extensions", "herdr-agent-state.ts"),
        item.id,
      );
    }
  }
});

test("Herdr native config-file fixtures drive the resource planner with explicit relative-path rejection", {
  skip: process.platform === "win32",
}, async () => {
  const data = await fixture("herdr-v0.9.5.json");
  for (const item of data.cases.filter((c) => c.input.platform === "darwin")) {
    const home = item.input.env.HOME;
    if (!home) continue; // HOME availability is checked by the CLI context below.
    if (!item.expected.configFile.startsWith("/")) {
      await assert.rejects(
        plan(home, item.input.env),
        /Herdr config path must be absolute/,
        item.id,
      );
    } else {
      const result = await plan(home, item.input.env);
      assert.equal(result.files[1].target, item.expected.configFile, item.id);
    }
  }
  await assert.rejects(
    plan("/fixture/home", { HERDR_CONFIG_PATH: "relative/config.toml" }),
    /must be absolute/,
  );
});

test("CLI HOME selection never silently adopts the native Herdr temporary fallback", () => {
  const before = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  try {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    assert.equal(localSetupHome(), undefined);
    process.env.HOME = "";
    assert.equal(localSetupHome(), "");
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// Session selection remains Pi's native responsibility. The wrapper forwards
// these arguments unchanged and does not take ownership of sessions or caches.
test.todo(
  "Native Windows/WSL coding resource paths and Pi session selection require platform acceptance",
);
test.todo(
  "Otty documented config paths/overrides: no production coding consumer yet",
);
