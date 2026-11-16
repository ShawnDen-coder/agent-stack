import assert from "node:assert/strict";
import test from "node:test";
import { uvReleases, uvUrl } from "../dist/adapters/releases.js";
import { codingMetadataPreload } from "../scripts/lib/coding-metadata.mjs";

test("CI metadata authentication follows the actual uv first page and validated pagination only", async () => {
  const previous = globalThis.fetch,
    oldToken = process.env.AGENT_STACK_TEST_GITHUB_TOKEN;
  const calls = [];
  const next =
    "https://api.github.com/repositories/699532645/releases?per_page=100&page=2";
  const manifest = {
    source: "https://herdr.dev/latest.json",
    version: "0.9.5",
  };
  process.env.AGENT_STACK_TEST_GITHUB_TOKEN = "test-only-not-a-credential";
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options?.headers) });
    return new Response("[]", {
      headers:
        String(url) === `${uvUrl}?per_page=100&page=1`
          ? { link: `<${next}>; rel="next"` }
          : {},
    });
  };
  try {
    const source = codingMetadataPreload(manifest);
    assert(!source.includes(process.env.AGENT_STACK_TEST_GITHUB_TOKEN));
    new Function(source)();
    await uvReleases(new AbortController().signal);
    assert.deepEqual(
      calls.map((c) => c.url),
      [`${uvUrl}?per_page=100&page=1`, `${uvUrl}?per_page=100&page=2`],
    );
    for (const call of calls)
      assert.equal(
        call.headers.get("authorization"),
        "Bearer test-only-not-a-credential",
      );
    await fetch(next);
    assert.equal(
      calls.at(-1).headers.get("authorization"),
      "Bearer test-only-not-a-credential",
    );
    calls.length = 0;
    for (const url of [
      "https://api.github.com/repos/other/repo/releases",
      "https://api.github.com/repositories/1/releases",
      "https://github.com/astral-sh/uv/releases/download/file",
      "https://registry.npmjs.org/pnpm",
      "https://example.invalid/repos/astral-sh/uv/releases",
    ]) {
      await fetch(url);
      assert.equal(calls.at(-1).headers.get("authorization"), null);
    }
    const before = calls.length;
    assert.equal(
      (await (await fetch(manifest.source)).json()).version,
      "0.9.5",
    );
    assert.equal(calls.length, before);
    delete process.env.AGENT_STACK_TEST_GITHUB_TOKEN;
    await fetch(uvUrl);
    assert.equal(calls.at(-1).headers.get("authorization"), null);
  } finally {
    globalThis.fetch = previous;
    if (oldToken === undefined)
      delete process.env.AGENT_STACK_TEST_GITHUB_TOKEN;
    else process.env.AGENT_STACK_TEST_GITHUB_TOKEN = oldToken;
  }
});
