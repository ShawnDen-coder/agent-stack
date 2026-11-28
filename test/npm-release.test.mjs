import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registryDecision } from "../scripts/lib/npm-release.mjs";

test("authenticated GitHub Packages lookup publishes missing versions and verifies retries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "registry-release-"));
  try {
    const tarball = join(dir, "package.tgz");
    const contents = Buffer.from("verified artifact");
    await writeFile(tarball, contents);
    const integrity = `sha512-${createHash("sha512").update(contents).digest("base64")}`;
    const args = {
      name: "@scope/example",
      version: "1.2.3",
      tarball,
      token: "test-token",
    };
    const query = (response) =>
      registryDecision({
        ...args,
        fetcher: async (url, options) => {
          assert.equal(url.href, "https://npm.pkg.github.com/@scope%2fexample");
          assert.equal(options.headers.authorization, "Bearer test-token");
          assert.equal(options.redirect, "error");
          return response;
        },
      });
    const published = (dist) =>
      Response.json({
        name: args.name,
        versions: {
          [args.version]: { name: args.name, version: args.version, dist },
        },
      });
    await assert.rejects(
      registryDecision({ ...args, token: undefined }),
      /NODE_AUTH_TOKEN/,
    );
    assert.equal(await query(new Response(null, { status: 404 })), "publish");
    assert.equal(
      await query(
        Response.json({ name: args.name, versions: { "1.2.2": {} } }),
      ),
      "publish",
    );
    assert.equal(await query(published({ integrity })), "skip");
    await assert.rejects(
      query(published({ integrity: "sha512-different" })),
      /integrity differs/,
    );
    await assert.rejects(query(published({})), /invalid/);
    await assert.rejects(
      query(Response.json({ name: args.name, version: args.version })),
      /invalid/,
    );
    for (const status of [401, 403, 429, 500])
      await assert.rejects(query(new Response(null, { status })), /HTTP/);
    await assert.rejects(
      registryDecision({
        ...args,
        fetcher: async () => {
          throw new Error("network failure");
        },
      }),
      /network failure/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
