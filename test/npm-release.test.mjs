import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registryDecision } from "../scripts/lib/npm-release.mjs";

test("registry release decisions fail closed except explicit 404", async () => {
  const dir = await mkdtemp(join(tmpdir(), "registry-release-"));
  try {
    const tarball = join(dir, "package.tgz");
    const contents = Buffer.from("verified artifact");
    await writeFile(tarball, contents);
    const integrity = `sha512-${createHash("sha512").update(contents).digest("base64")}`;
    const args = {
      registry: "https://registry.npmjs.org/",
      name: "@scope/example",
      version: "1.2.3",
      tarball,
    };
    const query = (response) =>
      registryDecision({ ...args, fetcher: async () => response });
    assert.equal(await query(new Response(null, { status: 404 })), "publish");
    assert.equal(
      await query(
        Response.json({
          name: args.name,
          version: args.version,
          dist: { integrity },
        }),
      ),
      "skip",
    );
    await assert.rejects(
      query(
        Response.json({
          name: args.name,
          version: args.version,
          dist: { integrity: "sha512-different" },
        }),
      ),
      /integrity differs/,
    );
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
