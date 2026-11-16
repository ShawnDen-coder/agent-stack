import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tag = process.env.RELEASE_TAG;
const expected = process.env.EXPECTED_SHA;
const pattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const match = tag?.match(pattern);
if (
  !match ||
  match[4]
    ?.split(".")
    .some(
      (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"),
    )
)
  throw new Error("Release tag must be canonical bare SemVer");
if (!expected || !/^[0-9a-f]{40}$/.test(expected))
  throw new Error("Expected exact commit SHA");
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const head = git("rev-parse", "HEAD^{commit}");
const tagged = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
const master = git(
  "rev-parse",
  "--verify",
  "refs/remotes/origin/master^{commit}",
);
if (head !== expected || tagged !== expected)
  throw new Error("Checked-out SHA or tag differs from event SHA");
git("merge-base", "--is-ancestor", expected, master);
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.version !== tag)
  throw new Error("Tag differs from package version");
if (
  manifest.repository?.type !== "git" ||
  manifest.repository?.url !==
    "git+https://github.com/ShawnDen-coder/agent-stack.git"
)
  throw new Error(
    "Package repository must match the trusted publishing repository",
  );
console.log(expected);
