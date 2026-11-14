import semver from "semver";
import { z } from "zod";
import type { Candidate } from "./npm-candidate.js";

const targetFieldsSchema = z.object({
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
  libc: z.array(z.string()).optional(),
});
const dependenciesSchema = z.record(z.string(), z.string());

const targets: Record<string, { os: string; cpu: string; native: string }> = {
  "darwin-arm64": {
    os: "darwin",
    cpu: "arm64",
    native: "@pnpm/exe.darwin-arm64",
  },
  "darwin-x64": { os: "darwin", cpu: "x64", native: "@pnpm/exe.darwin-x64" },
  "win32-x64": { os: "win32", cpu: "x64", native: "@pnpm/exe.win32-x64" },
};
function allowed(
  values: string[] | undefined,
  expected: string,
  field: string,
) {
  if (!values?.length) return;
  if (values.includes(`!${expected}`))
    throw new Error(`Target ${field} ${expected} is excluded`);
  const positive = values.filter((value) => !value.startsWith("!"));
  if (positive.length && !positive.includes(expected))
    throw new Error(`Target ${field} ${expected} is not supported`);
}
export function checkNpmTarget(candidate: Candidate, target: string) {
  const platform = targets[target];
  if (!platform) throw new Error(`npm asset target ${target} is not supported`);
  const fields = targetFieldsSchema.parse(candidate);
  allowed(fields.os, platform.os, "os");
  allowed(fields.cpu, platform.cpu, "cpu");
  if (fields.libc?.length)
    throw new Error("Cannot determine libc for this target");
}
export function pnpmNative(candidate: Candidate, target: string) {
  if (
    candidate.name !== "pnpm" ||
    !semver.satisfies(candidate.version, ">=12.15.0 <13.0.0")
  )
    throw new Error(
      `Unsupported pnpm native distribution series: ${candidate.version}`,
    );
  const platform = targets[target];
  if (!platform)
    throw new Error(`pnpm native target ${target} is not supported`);
  const spec = dependenciesSchema.parse(candidate.optionalDependencies ?? {})[
    platform.native
  ];
  if (!spec || semver.valid(spec) !== spec || spec !== candidate.version)
    throw new Error(
      `Missing or unsupported exact native dependency ${platform.native}`,
    );
  return { name: platform.native, version: spec };
}
export function npmAsset(
  component: string,
  target: string,
  candidate: Candidate,
  role: "top-level" | "native",
) {
  checkNpmTarget(candidate, target);
  if (role === "native") {
    const platform = targets[target];
    const fields = targetFieldsSchema.parse(candidate);
    if (
      !platform ||
      fields.os?.length !== 1 ||
      fields.os[0] !== platform.os ||
      fields.cpu?.length !== 1 ||
      fields.cpu[0] !== platform.cpu
    )
      throw new Error(
        "Native package os/cpu metadata does not match the expected target",
      );
  }
  return {
    component,
    target,
    identity: `${candidate.name}@${candidate.version}`,
    packageName: candidate.name,
    packageVersion: candidate.version,
    url: candidate.dist.tarball,
    integrity: candidate.dist.integrity,
    digestSource: `https://registry.npmjs.org/${encodeURIComponent(candidate.name)}`,
    format: "npm-tarball" as const,
    role,
  };
}
