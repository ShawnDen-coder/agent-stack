import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeHerdrConfig,
  mergePiMcp,
  mergePiSettings,
} from "../dist/core/coding-resources.js";

test("Pi MCP preserves unrelated servers and protects local reui", () => {
  const url = "https://mcp.reui.io";
  const first = mergePiMcp(
    '{"mcpServers":{"local":{"command":"x"}}}',
    url,
    null,
  );
  assert.equal(first.owned, true);
  assert.equal(JSON.parse(first.text).mcpServers.local.command, "x");
  assert.equal(mergePiMcp(first.text, url, url).text, first.text);
  assert.throws(
    () =>
      mergePiMcp(
        '{"mcpServers":{"reui":{"url":"https://other.invalid"}}}',
        url,
        null,
      ),
    /conflicts/,
  );
  assert.throws(
    () => mergePiMcp('{"mcpServers":{}}', url, url),
    /changed locally/,
  );
});

test("Pi model defaults respect owned values and protect local changes", () => {
  const desired = {
    defaultProvider: "openai-codex",
    defaultModel: "gpt-6.1-sol",
  };
  const first = mergePiSettings('{"theme":"custom"}', [], [], desired, {});
  assert.deepEqual(first.ownedDefaults, desired);
  assert.equal(JSON.parse(first.text).theme, "custom");
  assert.equal(JSON.parse(first.text).defaultModel, "gpt-6.1-sol");
  const next = { ...desired, defaultModel: "next-model" };
  const updated = mergePiSettings(
    first.text,
    [],
    [],
    next,
    first.ownedDefaults,
  );
  assert.equal(JSON.parse(updated.text).defaultModel, "next-model");
  assert.throws(
    () => mergePiSettings('{"defaultModel":"local"}', [], [], desired, {}),
    /conflicts/,
  );
  const drift = JSON.parse(first.text);
  drift.defaultModel = "local";
  assert.throws(
    () =>
      mergePiSettings(JSON.stringify(drift), [], [], next, first.ownedDefaults),
    /changed locally/,
  );
});

test("Pi skills preserve unowned entries and detect managed drift", () => {
  const first = mergePiSettings(
    '{"theme":"local","skills":["/local"]}',
    ["/repo/shape"],
    [],
  );
  assert.deepEqual(JSON.parse(first.text), {
    theme: "local",
    skills: ["/local", "/repo/shape"],
  });
  assert.deepEqual(first.owned, ["/repo/shape"]);
  const next = mergePiSettings(first.text, ["/new/shape"], first.owned);
  assert.deepEqual(JSON.parse(next.text).skills, ["/local", "/new/shape"]);
  assert.throws(
    () =>
      mergePiSettings('{"skills":["/local"]}', ["/repo/shape"], first.owned),
    /changed locally/,
  );
  assert.deepEqual(
    mergePiSettings('{"skills":["/repo/shape"]}', ["/repo/shape"], []).owned,
    [],
  );
  const unchanged = '{ "skills" : ["/repo/shape"], "theme": "mine" }';
  assert.equal(mergePiSettings(unchanged, ["/repo/shape"], []).text, unchanged);
  assert.throws(
    () => mergePiSettings('{"skills":["/local"]}', ["/new/shape"], first.owned),
    /changed locally/,
  );
  assert.doesNotThrow(() =>
    mergePiSettings('{"skills":["/new/shape"]}', ["/new/shape"], first.owned),
  );
});

test("Herdr field insertion preserves unrelated text and rejects conflicts", () => {
  const raw =
    "# personal comment\nonboarding = true\n\n[update]\n# custom\nauto_update = false\n";
  const result = mergeHerdrConfig(raw, {});
  assert.match(result.text, /# personal comment/);
  assert.match(result.text, /# custom/);
  assert.match(result.text, /version_check = false/);
  assert.deepEqual(result.owned, {
    version_check: false,
    manifest_check: false,
  });
  assert.equal(mergeHerdrConfig(result.text, result.owned).text, result.text);
  assert.throws(
    () => mergeHerdrConfig("[update]\nversion_check = true\n", {}),
    /conflicts/,
  );
  assert.throws(
    () => mergeHerdrConfig("[update]\n", result.owned),
    /changed locally/,
  );
});

test("resource plan is read-only and detects local extension conflict", async () => {
  const { cp, mkdir, mkdtemp, readFile, rm, writeFile } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { planCodingResources, inspectCodingResources } = await import(
    "../dist/adapters/coding-resources.js"
  );
  const root = await mkdtemp(join(tmpdir(), "coding-resources-"));
  try {
    const repo = join(root, "repo"),
      home = join(root, "home"),
      pi = join(home, ".pi", "agent");
    await mkdir(repo);
    await mkdir(join(pi, "extensions"), { recursive: true });
    await cp(resolve("stack"), join(repo, "stack"), { recursive: true });
    const auth = join(pi, "auth.json");
    await writeFile(auth, '{"private":"unchanged"}');
    const input = {
      repo,
      home,
      profile: "coding",
      target: "darwin-x64",
      piVersion: "1.5.2",
      herdrVersion: "0.9.5",
      env: {},
    };
    await assert.rejects(
      planCodingResources({ ...input, env: { HERDR_CONFIG_PATH: "" } }),
      /absolute/,
    );
    await assert.rejects(
      planCodingResources({ ...input, env: { XDG_CONFIG_HOME: "" } }),
      /absolute/,
    );
    const plan = await planCodingResources(input);
    assert.equal((await inspectCodingResources(input)).ready, false);
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.files[0].action, "create");
    await assert.rejects(readFile(join(pi, "settings.json")), {
      code: "ENOENT",
    });
    assert.equal(await readFile(auth, "utf8"), '{"private":"unchanged"}');
    await writeFile(
      join(pi, "extensions", "herdr-agent-state.ts"),
      "local extension",
    );
    const conflict = await planCodingResources(input);
    assert(
      conflict.blockers.some((message) => /extension conflicts/.test(message)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Herdr insertion rejects a table-looking line inside a multiline value", () => {
  assert.throws(
    () => mergeHerdrConfig('note = """\n[update]\n"""\n', {}),
    /safely edit/,
  );
});

test("resource apply preserves unknown data and is idempotent", async () => {
  const { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { planCodingResources, applyCodingResources, inspectCodingResources } =
    await import("../dist/adapters/coding-resources.js");
  const root = await mkdtemp(join(await realpath(tmpdir()), "coding-apply-"));
  try {
    const repo = join(root, "repo"),
      home = join(root, "home"),
      pi = join(home, ".pi", "agent"),
      herdr = join(home, ".config", "herdr");
    await mkdir(repo);
    await mkdir(join(home, ".agent-stack"), { recursive: true });
    await mkdir(pi, { recursive: true });
    await mkdir(herdr, { recursive: true });
    await cp(resolve("stack"), join(repo, "stack"), { recursive: true });
    await writeFile(
      join(home, ".agent-stack", "binding.json"),
      "binding-unchanged",
    );
    await writeFile(join(pi, "auth.json"), "private-unchanged");
    await writeFile(
      join(pi, "mcp.json"),
      JSON.stringify({
        mcpServers: { personal: { command: "my-tool" } },
        custom: true,
      }),
    );
    await writeFile(
      join(pi, "settings.json"),
      '{"theme":"personal","skills":["/personal"]}',
    );
    await writeFile(
      join(herdr, "config.toml"),
      "# personal\nonboarding = true\n",
    );
    await chmod(join(pi, "settings.json"), 0o640);
    const originalMode = (await stat(join(pi, "settings.json"))).mode & 0o777;
    const input = {
      repo,
      home,
      profile: "coding",
      target: "darwin-x64",
      piVersion: "1.5.2",
      herdrVersion: "0.9.5",
      env: {},
    };
    const options = {
      signal: new AbortController().signal,
      recheck: async () => {},
      env: input.env,
    };
    const first = await planCodingResources(input);
    assert.deepEqual(first.blockers, []);
    const previousOverride = input.env.HERDR_CONFIG_PATH;
    try {
      input.env.HERDR_CONFIG_PATH = join(root, "changed.toml");
      await assert.rejects(
        applyCodingResources(first, options),
        /environment changed/,
      );
    } finally {
      if (previousOverride === undefined) delete input.env.HERDR_CONFIG_PATH;
      else input.env.HERDR_CONFIG_PATH = previousOverride;
    }
    const applied = await applyCodingResources(first, options);
    assert(applied.backupDirectory);
    const installedSettings = JSON.parse(
      await readFile(join(pi, "settings.json"), "utf8"),
    );
    assert.equal(installedSettings.defaultProvider, "openai-codex");
    assert.equal(installedSettings.defaultModel, "gpt-6.1-sol");
    assert.equal(installedSettings.theme, "personal");
    const installedMcp = JSON.parse(
      await readFile(join(pi, "mcp.json"), "utf8"),
    );
    assert.deepEqual(installedMcp.mcpServers.reui, {
      url: "https://mcp.reui.io",
    });
    assert.deepEqual(installedMcp.mcpServers.personal, { command: "my-tool" });
    assert.equal(installedMcp.custom, true);
    const backupMap = JSON.parse(
      await readFile(join(applied.backupDirectory, "backup-map.json"), "utf8"),
    );
    assert(
      backupMap.items.some((item) => item.target === join(pi, "settings.json")),
    );
    assert.equal(
      JSON.parse(
        await readFile(
          join(home, ".agent-stack", "coding-resources.json"),
          "utf8",
        ),
      ).backupDirectory,
      backupMap.directory,
    );
    const settings = JSON.parse(
      await readFile(join(pi, "settings.json"), "utf8"),
    );
    assert.equal(
      (await stat(join(pi, "settings.json"))).mode & 0o777,
      originalMode,
    );
    assert.equal(settings.theme, "personal");
    assert(settings.skills.includes("/personal"));
    assert.match(
      await readFile(join(herdr, "config.toml"), "utf8"),
      /# personal/,
    );
    assert.equal(
      await readFile(join(pi, "auth.json"), "utf8"),
      "private-unchanged",
    );
    assert.equal(
      await readFile(join(home, ".agent-stack", "binding.json"), "utf8"),
      "binding-unchanged",
    );
    const verified = await inspectCodingResources(input);
    assert.equal(verified.ready, true);
    const piSettings = join(pi, "settings.json");
    const withChangelog = JSON.parse(await readFile(piSettings, "utf8"));
    withChangelog.lastChangelogVersion = "1.5.2";
    await writeFile(piSettings, JSON.stringify(withChangelog));
    const afterChangelog = await inspectCodingResources(input);
    assert.equal(afterChangelog.ready, true);
    assert.equal(afterChangelog.verification, verified.verification);
    withChangelog.theme = "changed-personally";
    await writeFile(piSettings, JSON.stringify(withChangelog));
    assert.notEqual(
      (await inspectCodingResources(input)).verification,
      verified.verification,
    );
    withChangelog.theme = "personal";
    await writeFile(piSettings, JSON.stringify(withChangelog));
    const again = await planCodingResources(input);
    assert.deepEqual((await applyCodingResources(again, options)).files, []);
    const defaults = join(repo, "stack", "configs", "herdr", "config.toml");
    await writeFile(
      defaults,
      "[update]\nversion_check = true\nmanifest_check = false\n",
    );
    const movedHerdr = join(home, "other-herdr.toml");
    const personalTarget =
      "[update]\nversion_check = false\nmanifest_check = false\n";
    await writeFile(movedHerdr, personalTarget);
    const moved = await planCodingResources({
      ...input,
      env: { HERDR_CONFIG_PATH: movedHerdr },
    });
    assert(
      moved.blockers.some((message) => /conflicts/.test(message)),
      "old ownership must not authorize a different native config target",
    );
    assert.equal(await readFile(movedHerdr, "utf8"), personalTarget);
    const receiptPath = join(home, ".agent-stack", "coding-resources.json");
    const anchoredBytes = await readFile(receiptPath, "utf8");
    const anchored = JSON.parse(anchoredBytes);
    assert.equal(anchored.schemaVersion, 2);
    assert.equal(anchored.targets.herdr, join(herdr, "config.toml"));
    await writeFile(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        skills: anchored.skills,
        herdr: anchored.herdr,
        extensionHash: anchored.extensionHash,
      }),
    );
    assert(
      (await planCodingResources(input)).blockers.some((message) =>
        /conflicts/.test(message),
      ),
      "unanchored legacy receipts are not write grants",
    );
    await writeFile(receiptPath, anchoredBytes);
    const changedSource = await planCodingResources(input);
    assert.deepEqual(changedSource.blockers, []);
    const extensionPath = join(pi, "extensions", "herdr-agent-state.ts");
    const originalExtension = await readFile(extensionPath);
    let driftInjected = false;
    await assert.rejects(
      applyCodingResources(changedSource, {
        ...options,
        recheck: async () => {
          if (
            !driftInjected &&
            /version_check = true/.test(
              await readFile(join(herdr, "config.toml"), "utf8"),
            )
          ) {
            driftInjected = true;
            await writeFile(extensionPath, "local extension drift\n");
          }
        },
      }),
      /Unchanged coding resource target changed/,
    );
    assert.equal(driftInjected, true);
    assert.equal(
      await readFile(extensionPath, "utf8"),
      "local extension drift\n",
    );
    assert.match(
      await readFile(join(herdr, "config.toml"), "utf8"),
      /version_check = false/,
    );
    await writeFile(extensionPath, originalExtension);
    await applyCodingResources(changedSource, options);
    assert.match(
      await readFile(join(herdr, "config.toml"), "utf8"),
      /version_check = true/,
    );
    await writeFile(
      join(herdr, "config.toml"),
      (await readFile(join(herdr, "config.toml"), "utf8")).replace(
        "version_check = true",
        "version_check = false",
      ),
    );
    assert(
      (await planCodingResources(input)).blockers.some((item) =>
        /changed locally/.test(item),
      ),
    );
    await writeFile(
      defaults,
      "[update]\nversion_check = false\nmanifest_check = false\n",
    );
    assert.deepEqual((await planCodingResources(input)).blockers, []);
    const frozen = await planCodingResources(input);
    await writeFile(
      join(repo, "stack", "agents", "coding.md"),
      "new coding responsibilities\n",
    );
    await assert.rejects(applyCodingResources(frozen, options), /plan changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resource apply rolls back verified writes after a partial failure", async () => {
  const { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { planCodingResources, applyCodingResources } = await import(
    "../dist/adapters/coding-resources.js"
  );
  const root = await mkdtemp(join(await realpath(tmpdir()), "coding-failure-"));
  try {
    const repo = join(root, "repo"),
      home = join(root, "home"),
      pi = join(home, ".pi", "agent"),
      config = join(home, ".config", "herdr");
    await mkdir(repo);
    await mkdir(join(home, ".agent-stack"), { recursive: true });
    await mkdir(pi, { recursive: true });
    await mkdir(config, { recursive: true });
    await cp(resolve("stack"), join(repo, "stack"), { recursive: true });
    const original = '{"theme":"personal"}';
    await writeFile(join(pi, "settings.json"), original);
    await writeFile(join(config, "config.toml"), "onboarding = true\n");
    await writeFile(join(home, ".agent-stack", "binding.json"), "old-binding");
    const input = {
      repo,
      home,
      profile: "coding",
      target: "darwin-x64",
      piVersion: "1.5.2",
      herdrVersion: "0.9.5",
      env: {},
    };
    const plan = await planCodingResources(input);
    let triggered = false;
    const recheck = async () => {
      if (
        !triggered &&
        (await readFile(join(pi, "settings.json"), "utf8")) !== original
      ) {
        triggered = true;
        throw new Error("injected post-publication failure");
      }
    };
    await assert.rejects(
      applyCodingResources(plan, {
        signal: new AbortController().signal,
        recheck,
        env: input.env,
      }),
      /injected/,
    );
    assert.equal(triggered, true);
    assert.equal(await readFile(join(pi, "settings.json"), "utf8"), original);
    assert.equal(
      await readFile(join(config, "config.toml"), "utf8"),
      "onboarding = true\n",
    );
    assert.equal(
      await readFile(join(home, ".agent-stack", "binding.json"), "utf8"),
      "old-binding",
    );
    await assert.rejects(
      readFile(join(home, ".agent-stack", "resources.pending.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resource journal recovers a killed process before retry", {
  skip: process.platform === "win32",
}, async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { planCodingResources, applyCodingResources } = await import(
    "../dist/adapters/coding-resources.js"
  );
  const root = await mkdtemp(join(await realpath(tmpdir()), "coding-kill-"));
  try {
    const repo = join(root, "repo"),
      home = join(root, "home"),
      pi = join(home, ".pi", "agent"),
      config = join(home, ".config", "herdr");
    await mkdir(repo);
    await mkdir(join(home, ".agent-stack"), { recursive: true });
    await mkdir(pi, { recursive: true });
    await mkdir(config, { recursive: true });
    await cp(resolve("stack"), join(repo, "stack"), { recursive: true });
    const original = '{"theme":"personal"}';
    await writeFile(join(pi, "settings.json"), original);
    await writeFile(join(config, "config.toml"), "onboarding = true\n");
    await writeFile(join(home, ".agent-stack", "binding.json"), "old-binding");
    const input = {
      repo,
      home,
      profile: "coding",
      target: "darwin-x64",
      piVersion: "1.5.2",
      herdrVersion: "0.9.5",
      env: {},
    };
    const moduleUrl = pathToFileURL(
      resolve("dist/adapters/coding-resources.js"),
    ).href;
    const childScript = `import { readFile } from 'node:fs/promises';\nimport { planCodingResources, applyCodingResources } from ${JSON.stringify(moduleUrl)};\nconst input = ${JSON.stringify(input)};\nconst plan = await planCodingResources(input);\nawait applyCodingResources(plan, {signal: new AbortController().signal, env: input.env, recheck: async () => { if (await readFile(${JSON.stringify(join(pi, "settings.json"))}, 'utf8') !== ${JSON.stringify(original)}) process.kill(process.pid, 'SIGKILL'); }});`;
    const script = join(root, "child.mjs");
    await writeFile(script, childScript);
    const child = spawn(process.execPath, [script], { stdio: "ignore" });
    const [code, signal] = await once(child, "exit");
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    const pending = await planCodingResources(input);
    assert(pending.blockers.some((item) => /Pending/.test(item)));
    const options = {
      signal: new AbortController().signal,
      recheck: async () => {},
      env: input.env,
    };
    const changedTarget = join(pi, "settings.json");
    const published = await readFile(changedTarget, "utf8");
    await writeFile(changedTarget, '{"local":"edit"}');
    await assert.rejects(
      applyCodingResources(pending, options),
      /manual recovery required/,
    );
    assert.equal(await readFile(changedTarget, "utf8"), '{"local":"edit"}');
    assert.ok(
      await readFile(join(home, ".agent-stack", "resources.pending.json")),
    );
    await writeFile(changedTarget, published);
    await assert.rejects(
      applyCodingResources(pending, options),
      /recovered; replan/,
    );
    assert.equal(await readFile(join(pi, "settings.json"), "utf8"), original);
    assert.equal(
      await readFile(join(home, ".agent-stack", "binding.json"), "utf8"),
      "old-binding",
    );
    await applyCodingResources(await planCodingResources(input), options);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resource preparation interruption recovers without touching the target", {
  skip: process.platform === "win32",
}, async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { recoverCodingResources } = await import(
    "../dist/adapters/coding-resource-transaction.js"
  );
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "resource-prepare-"),
  );
  try {
    const home = join(root, "home"),
      state = join(home, ".agent-stack"),
      target = join(home, "settings.json");
    await mkdir(state, { recursive: true });
    await writeFile(target, "original");
    const url = pathToFileURL(
      resolve("dist/adapters/coding-resource-transaction.js"),
    ).href;
    const childScript = `import {readFile} from 'node:fs/promises'; import {publishCodingResources} from ${JSON.stringify(url)};\nawait publishCodingResources({home:${JSON.stringify(home)},files:[{target:${JSON.stringify(target)},before:Buffer.from('original'),beforeMode:0o644,after:Buffer.from('changed')}],signal:new AbortController().signal,recheck:async()=>{try{let j=JSON.parse(await readFile(${JSON.stringify(join(state, "resources.pending.json"))},'utf8'));if(j.phase==='preparing')process.kill(process.pid,'SIGKILL')}catch(e){if(e.code!=='ENOENT')throw e}}});`;
    const script = join(root, "child.mjs");
    await writeFile(script, childScript);
    const child = spawn(process.execPath, [script], { stdio: "ignore" });
    const [code, signal] = await once(child, "exit");
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    assert.equal(await recoverCodingResources(home, [target]), true);
    assert.equal(await readFile(target, "utf8"), "original");
    await assert.rejects(readFile(join(state, "resources.pending.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
