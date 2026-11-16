import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type CodingResourcePlan,
  codingResourcePlanSchema,
  mergeHerdrConfig,
  mergePiSettings,
} from "../core/coding-resources.js";
import {
  publishCodingResources,
  recoverCodingResources,
} from "./coding-resource-transaction.js";

const receiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  skills: z.array(z.string()),
  herdr: z.record(z.string(), z.boolean()),
  extensionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function read(path: string, required = false): Promise<Buffer | null> {
  try {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024)
        throw new Error("Invalid coding resource file");
      const bytes = await file.readFile();
      const after = await file.stat();
      if (
        stat.dev !== after.dev ||
        stat.ino !== after.ino ||
        stat.size !== after.size ||
        stat.mtimeMs !== after.mtimeMs
      )
        throw new Error("Coding resource changed during reading");
      return bytes;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT")
      return null;
    throw error;
  }
}
const hash = (bytes: Buffer | null) => (bytes === null ? null : digest(bytes));
async function fileMode(path: string, exists: boolean) {
  if (!exists) return null;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Invalid coding resource file");
  return info.mode & 0o777;
}
function nativePath(value: string, label: string) {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return resolve(value);
}
export type CodingResourceInput = {
  repo: string;
  home: string;
  profile: string;
  target: string;
  piVersion: string;
  herdrVersion: string;
  env: NodeJS.ProcessEnv;
};
export async function planCodingResources(input: CodingResourceInput) {
  const repo = nativePath(input.repo, "Repository"),
    home = nativePath(input.home, "HOME");
  const piOverride = input.env.PI_CODING_AGENT_DIR;
  const piValue = !piOverride
    ? join(home, ".pi", "agent")
    : piOverride === "~"
      ? home
      : piOverride.startsWith("~/")
        ? join(home, piOverride.slice(2))
        : piOverride;
  const pi = nativePath(piValue, "Pi agent directory");
  const herdr = nativePath(
    input.env.HERDR_CONFIG_PATH ??
      join(
        input.env.XDG_CONFIG_HOME ?? join(home, ".config"),
        "herdr",
        "config.toml",
      ),
    "Herdr config path",
  );
  const statePath = join(home, ".agent-stack", "coding-resources.json");
  const stateBytes = await read(statePath);
  const previous = stateBytes
    ? receiptSchema.parse(JSON.parse(stateBytes.toString("utf8")))
    : { schemaVersion: 1 as const, skills: [], herdr: {}, extensionHash: null };
  const sources = [
    "stack/configs/pi/settings.json",
    "stack/configs/herdr/config.toml",
    "stack/configs/pi/extensions/herdr-agent-state.ts",
    "stack/agents/coding.md",
    ...["shape", "implement", "verify"].map(
      (name) => `stack/skills/${name}/SKILL.md`,
    ),
  ];
  const data = await Promise.all(
    sources.map((name) => read(join(repo, name), true)),
  );
  if (data.some((item) => item === null))
    throw new Error("Missing coding resource");
  const targets = [
    join(pi, "settings.json"),
    herdr,
    join(pi, "extensions", "herdr-agent-state.ts"),
    ...sources.slice(3).map((name) => join(repo, name)),
  ];
  const current = await Promise.all(targets.map((target) => read(target)));
  const modes = await Promise.all(
    targets.map((target, index) => fileMode(target, current[index] != null)),
  );
  const receiptMode = await fileMode(statePath, stateBytes !== null);
  const blockers: string[] = [];
  const writable = [...targets.slice(0, 3), statePath];
  if (new Set(writable).size !== writable.length)
    blockers.push("Coding resource targets overlap");
  if (
    writable.some((target) => {
      const path = relative(repo, target);
      return (
        path === "" ||
        (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
      );
    })
  )
    blockers.push("Coding resource target is inside the source checkout");
  if (await read(join(home, ".agent-stack", "resources.pending.json")))
    blockers.push("Pending resource operation requires recovery");
  if (input.profile !== "coding")
    blockers.push("Coding resources require the coding profile");
  if (!["darwin-arm64", "darwin-x64"].includes(input.target))
    blockers.push("Coding resources are not verified for this target");
  if (input.piVersion !== "1.5.2" || input.herdrVersion !== "0.9.5")
    blockers.push("Pi/Herdr resource version is not verified");
  const desiredSkills = ["shape", "implement", "verify"].map((name) =>
    join(repo, "stack", "skills", name),
  );
  let piText = "",
    herdrText = "",
    skills: string[] = [],
    herdrOwned: Record<string, boolean> = {};
  try {
    const defaults = JSON.parse(data[0]?.toString("utf8") ?? "");
    z.strictObject({ skills: z.array(z.string()).length(0) }).parse(defaults);
    const merged = mergePiSettings(
      current[0]?.toString("utf8") ?? null,
      desiredSkills,
      previous.skills,
    );
    piText = merged.text;
    skills = merged.owned;
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const defaults = z
      .strictObject({
        update: z.strictObject({
          version_check: z.boolean(),
          manifest_check: z.boolean(),
        }),
      })
      .parse(parseToml(data[1]?.toString("utf8") ?? ""));
    const merged = mergeHerdrConfig(
      current[1]?.toString("utf8") ?? null,
      previous.herdr,
      defaults.update,
    );
    herdrText = merged.text;
    herdrOwned = merged.owned;
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  const extension = data[2];
  if (!extension) throw new Error("Missing extension");
  if (
    digest(extension) !==
    "2c5272d732b475bbf91a027203b1f98d25fe43d2c1402530a442b288aeaca1e4"
  )
    blockers.push(
      "Pi extension does not match the verified Herdr 0.9.5 source",
    );
  if (!data[3]?.toString("utf8").trim()) blockers.push("Coding agent is empty");
  for (const [index, name] of ["shape", "implement", "verify"].entries()) {
    try {
      const source = data[index + 4]?.toString("utf8") ?? "";
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
      if (!match?.[1]) throw new Error("Missing skill front matter");
      const frontmatter = z
        .object({
          name: z.literal(name),
          description: z.string().trim().min(1),
        })
        .parse(parseYaml(match[1]));
      if (!frontmatter || !source.slice(match[0].length).trim())
        throw new Error("Empty skill body");
    } catch {
      blockers.push(`Invalid ${name} skill`);
    }
  }
  const currentExtension = current[2];
  const managedExtension =
    currentExtension === null || previous.extensionHash !== null;
  if (currentExtension === null && previous.extensionHash !== null)
    blockers.push("Managed Pi extension was removed locally");
  if (
    currentExtension &&
    !currentExtension.equals(extension) &&
    hash(currentExtension) !== previous.extensionHash
  )
    blockers.push("Pi extension conflicts with local content");
  const desired = [
    Buffer.from(piText),
    Buffer.from(herdrText),
    extension,
    ...data.slice(3),
  ];
  const files = sources.map((source, index) => {
    const sourceBytes = data[index],
      actual = current[index],
      next = desired[index],
      target = targets[index];
    if (!sourceBytes || !next || !target)
      throw new Error("Incomplete resource plan");
    return {
      source,
      target,
      sourceHash: digest(sourceBytes),
      targetHash: hash(actual ?? null),
      targetMode: modes[index] ?? null,
      action:
        actual == null
          ? "create"
          : actual.equals(next)
            ? "unchanged"
            : blockers.length
              ? "conflict"
              : "update",
    };
  });
  return codingResourcePlanSchema.parse({
    kind: "coding-resources-plan",
    repo,
    home,
    profile: input.profile,
    target: input.target,
    piVersion: input.piVersion,
    herdrVersion: input.herdrVersion,
    environment: {
      pi: input.env.PI_CODING_AGENT_DIR ?? null,
      herdr: input.env.HERDR_CONFIG_PATH ?? null,
      xdg: input.env.XDG_CONFIG_HOME ?? null,
    },
    receiptHash: hash(stateBytes),
    receiptMode,
    managedSkills: skills,
    managedHerdr: herdrOwned,
    managedExtension,
    files,
    blockers,
  });
}
export async function inspectCodingResources(input: CodingResourceInput) {
  const plan = await planCodingResources(input);
  return {
    ready:
      plan.receiptHash !== null &&
      !plan.blockers.length &&
      plan.files.every((file) => file.action === "unchanged"),
    scope:
      "files only; runtime resource loading and integration are not verified",
    plan,
  };
}

// The caller holds the shared setup operation lease. The plan is an in-memory
// snapshot; every source, target and receipt is re-read before publication.
export async function applyCodingResources(
  planInput: CodingResourcePlan,
  options: { signal: AbortSignal; recheck: () => Promise<void> },
) {
  const plan = codingResourcePlanSchema.parse(planInput);
  if (plan.files.length !== 7) throw new Error("Invalid coding resource plan");
  const piSettings = plan.files[0]?.target,
    herdr = plan.files[1]?.target,
    extensionPath = plan.files[2]?.target;
  if (!piSettings || !herdr || !extensionPath)
    throw new Error("Invalid coding resource targets");
  const receiptPath = join(plan.home, ".agent-stack", "coding-resources.json");
  const input: CodingResourceInput = {
    repo: plan.repo,
    home: plan.home,
    profile: plan.profile,
    target: plan.target,
    piVersion: plan.piVersion,
    herdrVersion: plan.herdrVersion,
    env: {
      ...(plan.environment.pi === null
        ? {}
        : { PI_CODING_AGENT_DIR: plan.environment.pi }),
      ...(plan.environment.herdr === null
        ? {}
        : { HERDR_CONFIG_PATH: plan.environment.herdr }),
      ...(plan.environment.xdg === null
        ? {}
        : { XDG_CONFIG_HOME: plan.environment.xdg }),
    },
  };
  const allowed = [piSettings, herdr, extensionPath, receiptPath];
  if (new Set(allowed).size !== allowed.length)
    throw new Error("Coding resource targets overlap");
  const verifyEnvironment = () => {
    if (
      (process.env.PI_CODING_AGENT_DIR ?? null) !== plan.environment.pi ||
      (process.env.HERDR_CONFIG_PATH ?? null) !== plan.environment.herdr ||
      (process.env.XDG_CONFIG_HOME ?? null) !== plan.environment.xdg
    )
      throw new Error("Coding resource environment changed after planning");
  };
  if (options.signal.aborted) throw new Error("Cancelled");
  verifyEnvironment();
  await options.recheck();
  if (await recoverCodingResources(plan.home, allowed))
    throw new Error(
      "Previous resource operation recovered; replan before retrying",
    );
  const fresh = await planCodingResources(input);
  if (JSON.stringify(fresh) !== JSON.stringify(plan))
    throw new Error("Coding resource plan changed before application");
  if (plan.blockers.length) throw new Error("Coding resource plan is blocked");
  const receiptBytes = await read(receiptPath);
  const previous = receiptBytes
    ? receiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")))
    : { schemaVersion: 1 as const, skills: [], herdr: {}, extensionHash: null };
  const before = await Promise.all(
    allowed.slice(0, 3).map((path) => read(path)),
  );
  const skills = ["shape", "implement", "verify"].map((name) =>
    join(plan.repo, "stack", "skills", name),
  );
  const pi = mergePiSettings(
    before[0]?.toString("utf8") ?? null,
    skills,
    previous.skills,
  );
  const defaults = await read(
    join(plan.repo, plan.files[1]?.source ?? ""),
    true,
  );
  if (!defaults) throw new Error("Missing Herdr defaults");
  const desired = z
    .strictObject({
      update: z.strictObject({
        version_check: z.boolean(),
        manifest_check: z.boolean(),
      }),
    })
    .parse(parseToml(defaults.toString("utf8"))).update;
  const config = mergeHerdrConfig(
    before[1]?.toString("utf8") ?? null,
    previous.herdr,
    desired,
  );
  const extension = await read(
    join(plan.repo, plan.files[2]?.source ?? ""),
    true,
  );
  if (!extension) throw new Error("Missing Pi extension");
  if (
    JSON.stringify(pi.owned) !== JSON.stringify(plan.managedSkills) ||
    JSON.stringify(config.owned) !== JSON.stringify(plan.managedHerdr)
  )
    throw new Error("Resource ownership changed after planning");
  const receipt = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      skills: pi.owned,
      herdr: config.owned,
      extensionHash: plan.managedExtension ? digest(extension) : null,
    }),
  );
  const after = [
    Buffer.from(pi.text),
    Buffer.from(config.text),
    extension,
    receipt,
  ];
  const prior = [...before, receiptBytes];
  const files = allowed.flatMap((target, index) => {
    const old = prior[index] ?? null,
      next = after[index];
    if (!next) throw new Error("Invalid resource output");
    const beforeMode =
      index === 3 ? plan.receiptMode : (plan.files[index]?.targetMode ?? null);
    return old?.equals(next)
      ? []
      : [{ target, before: old, beforeMode, after: next }];
  });
  const recheck = async () => {
    if (options.signal.aborted) throw new Error("Cancelled");
    verifyEnvironment();
    await options.recheck();
    for (const file of plan.files) {
      const source = await read(join(plan.repo, file.source), true);
      if (!source || digest(source) !== file.sourceHash)
        throw new Error("Coding resource source changed after planning");
    }
  };
  await recheck();
  if (files.length)
    await publishCodingResources({
      home: plan.home,
      files,
      signal: options.signal,
      recheck,
    });
  return {
    kind: "coding-resources-applied" as const,
    files: files.map((file) => file.target),
  };
}
