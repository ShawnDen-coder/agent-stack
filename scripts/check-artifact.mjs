import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const [mode, file] = process.argv.slice(2);
if (!file || process.argv.length !== 4 || !["write", "verify"].includes(mode))
  throw new Error("Usage: check-artifact.mjs write|verify FILE");
const expected = `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${basename(file)}\n`;
if (mode === "write") writeFileSync(`${file}.sha256`, expected);
else if (readFileSync(`${file}.sha256`, "utf8") !== expected)
  throw new Error(`Checksum mismatch: ${file}`);
else console.log(`Verified checksum: ${file}`);
