import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  recordManagedTree,
  removeManagedTree,
  verifyManagedTree,
} from "../dist/adapters/managed-tree.js";

const unix = { skip: process.platform === "win32" };
async function fixture(t) {
  const parent = await mkdtemp(
    join(await realpath(tmpdir()), "agent-stack-owned-tree-"),
  );
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "stage");
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(root, "node_modules", ".bin"));
  const entry = join(root, "node_modules", "pkg", "cli.js");
  await writeFile(entry, "console.log('owned');\n");
  await symlink("../pkg/cli.js", join(root, "node_modules", ".bin", "pi"));
  await writeFile(join(root, "package.json"), '{"private":true}\n');
  return { parent, root, entry };
}

test(
  "a recorded npm tree and its internal bin symlink can be verified and removed",
  unix,
  async (t) => {
    const f = await fixture(t);
    let journalReceipt;
    const receipt = await recordManagedTree(f.root, async (value) => {
      journalReceipt = value;
    });
    assert.deepEqual(receipt, journalReceipt);
    await verifyManagedTree(f.root, receipt);
    await removeManagedTree(f.root, receipt);
    await assert.rejects(readFile(f.entry), { code: "ENOENT" });
    await removeManagedTree(f.root, receipt);
  },
);

test(
  "tree drift and unrecorded files are preserved before cleanup",
  unix,
  async (t) => {
    const f = await fixture(t);
    const receipt = await recordManagedTree(f.root, async () => {});
    await writeFile(f.entry, "locally changed\n");
    await assert.rejects(verifyManagedTree(f.root, receipt), /manual recovery/);
    await assert.rejects(removeManagedTree(f.root, receipt), /manual recovery/);
    assert.equal(await readFile(f.entry, "utf8"), "locally changed\n");
    await writeFile(f.entry, "console.log('owned');\n");
    const extra = join(f.root, "node_modules", "pkg", "local.txt");
    await writeFile(extra, "retain me\n");
    await assert.rejects(removeManagedTree(f.root, receipt), /manual recovery/);
    assert.equal(await readFile(extra, "utf8"), "retain me\n");
    assert.equal(await readFile(f.entry, "utf8"), "console.log('owned');\n");
  },
);

test(
  "interrupted tree cleanup tolerates already removed files and dangling owned bin links",
  unix,
  async (t) => {
    const f = await fixture(t);
    const receipt = await recordManagedTree(f.root, async () => {});
    await unlink(f.entry);
    await removeManagedTree(f.root, receipt);
    await assert.rejects(readFile(join(f.root, "package.json")), {
      code: "ENOENT",
    });
  },
);

test(
  "a replaced stage directory is not taken over even with identical contents",
  unix,
  async (t) => {
    const f = await fixture(t);
    const receipt = await recordManagedTree(f.root, async () => {});
    await rename(f.root, join(f.parent, "original"));
    await mkdir(f.root);
    await writeFile(join(f.root, "package.json"), '{"private":true}\n');
    await assert.rejects(removeManagedTree(f.root, receipt), /manual recovery/);
    assert.equal(
      await readFile(join(f.root, "package.json"), "utf8"),
      '{"private":true}\n',
    );
  },
);

test(
  "a lexical internal link that resolves outside the npm tree is rejected",
  unix,
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.parent, "outside.txt"), "outside\n");
    await symlink(".", join(f.root, "alias"));
    await symlink("alias/../outside.txt", join(f.root, "escape"));
    await assert.rejects(
      recordManagedTree(f.root, async () => {}),
      /manual recovery/,
    );
    assert.equal(
      await readFile(join(f.parent, "outside.txt"), "utf8"),
      "outside\n",
    );
  },
);

test(
  "an incomplete ownership manifest is kept as evidence",
  unix,
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      recordManagedTree(f.root, async () => {
        throw Error("interrupted record");
      }),
      /interrupted/,
    );
    assert.equal(await readFile(join(f.root, ".ownership.json"), "utf8"), "");
    assert.equal(await readFile(f.entry, "utf8"), "console.log('owned');\n");
  },
);
