import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../stack/", import.meta.url));

test("Pi package declares the intended checkout resources", async () => {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.deepEqual(manifest.pi.skills, [
    "./skills/shape",
    "./skills/implement",
    "./skills/verify",
  ]);
  assert.deepEqual(manifest.pi.extensions, [
    "./configs/pi/extensions/coding-agent.ts",
  ]);
  for (const path of manifest.pi.skills)
    assert.ok((await stat(join(root, path, "SKILL.md"))).isFile());
  for (const path of manifest.pi.extensions)
    assert.ok((await stat(join(root, path))).isFile());
});

test("Agent hook preserves Pi prompt and does not repeat managed Agent", async () => {
  let handler;
  const extension = await import(
    pathToFileURL(join(root, "configs/pi/extensions/coding-agent.ts"))
  );
  extension.default({
    on(name, callback) {
      assert.equal(name, "before_agent_start");
      handler = callback;
    },
  });
  const agent = await readFile(join(root, "agents/coding.md"), "utf8");
  const result = await handler({ systemPrompt: "Pi and user instructions" });
  assert.equal(result.systemPrompt, `Pi and user instructions\n\n${agent}`);
  assert.equal(await handler({ systemPrompt: result.systemPrompt }), undefined);
  assert.equal(
    await handler({ systemPrompt: `Managed Pi\n${agent.trim()}` }),
    undefined,
  );
});
