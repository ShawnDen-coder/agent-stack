import semver from "semver";
import { definitionDigests } from "./definition-digests.js";
import { freshLockSchema } from "./fresh-lock.js";
import { checkHerdrDistribution } from "./herdr-assets.js";
import { npmTargets } from "./npm-assets.js";
import { checkNpmDistribution } from "./npm-candidate.js";
import { lockValidationSummarySchema, type Repository } from "./schema.js";
import { checkUvDistribution } from "./uv-assets.js";

function insist(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function setEqual(a: string[], b: string[]) {
  return (
    a.length === b.length &&
    new Set(a).size === a.length &&
    same([...a].sort(), [...b].sort())
  );
}
export function validateLock(data: unknown, repository: Repository) {
  const parsed = freshLockSchema.safeParse(data);
  if (!parsed.success)
    throw new Error(
      "Invalid lock schema, version, algorithm or required field",
    );
  const lock = parsed.data;
  insist(semver.valid(lock.node) === lock.node, "Invalid exact Node version");
  const profile = repository.profiles.find((x) => x.id === lock.profile);
  insist(profile, "Lock profile is missing from repository");
  insist(
    setEqual(lock.integrations, profile.integrations),
    "Lock integration set does not match profile",
  );
  insist(
    setEqual(
      lock.components.map((x) => x.component),
      profile.components.map((x) => x.component),
    ),
    "Lock component set does not match profile",
  );
  const expectedDigests = definitionDigests(repository, profile);
  const digestMapEqual = (
    a: Record<string, string>,
    b: Record<string, string>,
  ) =>
    setEqual(Object.keys(a), Object.keys(b)) &&
    Object.keys(a).every((key) => a[key] === b[key]);
  insist(
    lock.definitionDigests.profile === expectedDigests.profile &&
      digestMapEqual(
        lock.definitionDigests.components,
        expectedDigests.components,
      ) &&
      digestMapEqual(
        lock.definitionDigests.integrations,
        expectedDigests.integrations,
      ),
    "Lock declaration digests do not match repository",
  );
  insist(
    new Set(lock.targets.map((x) => x.id)).size === lock.targets.length,
    "Duplicate lock target",
  );
  for (const target of lock.targets) {
    const t = npmTargets[target.id];
    insist(
      t &&
        target.os === t.os &&
        target.arch === t.cpu &&
        target.abi === "native",
      "Invalid target identity",
    );
    insist(
      profile.platforms.includes(target.os),
      "Target is not supported by profile",
    );
  }
  const selected = new Map(lock.components.map((x) => [x.component, x]));
  for (const item of lock.components) {
    const definition = repository.components.find(
      (x) => x.id === item.component,
    );
    const requirement = profile.components.find(
      (x) => x.component === item.component,
    );
    insist(definition && requirement, "Unknown lock component");
    insist(
      semver.valid(item.version) &&
        /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
          item.version,
        ),
      "Invalid exact component version",
    );
    if (item.source.type !== "npm")
      insist(
        semver.valid(item.version) === item.version &&
          !semver.prerelease(item.version),
        "Invalid stable release version",
      );
    if ("version" in requirement)
      insist(
        semver.validRange(requirement.version) &&
          semver.satisfies(item.version, requirement.version),
        "Component version does not satisfy profile",
      );
    else
      insist(
        item.component === "herdr" && requirement.channel === "stable",
        "Unsupported channel",
      );
    if (definition.source.type === "npm")
      insist(
        item.source.type === "npm" &&
          item.source.package === definition.source.package,
        "npm source does not match declaration",
      );
    else if (item.component === "uv")
      insist(
        definition.source.type === "release" &&
          definition.source.url ===
            "https://docs.astral.sh/uv/getting-started/installation/" &&
          item.source.type === "github-release" &&
          item.source.tag === item.version,
        "uv source identity does not match declaration",
      );
    else if (item.component === "herdr")
      insist(
        definition.source.type === "release" &&
          definition.source.url ===
            "https://github.com/herdrdev/herdr/releases" &&
          item.source.type === "channel-manifest" &&
          item.source.version === item.version,
        "herdr source identity does not match declaration",
      );
    else throw new Error("Unsupported lock source");
    for (const target of lock.targets)
      insist(
        definition.platforms.includes(target.os),
        "Target is not supported by component",
      );
  }
  const seen = new Set<string>();
  const uvIds = new Set<number>();
  const npmIdentities = new Map<string, string>();
  for (const asset of lock.assets) {
    const item = selected.get(asset.component);
    const target = npmTargets[asset.target];
    insist(
      item && target && lock.targets.some((t) => t.id === asset.target),
      "Asset references unknown component or target",
    );
    const a = asset.artifact;
    const role = a.type === "npm" ? a.role : "release";
    const key = `${asset.component}/${asset.target}/${role}`;
    insist(!seen.has(key), "Duplicate asset");
    seen.add(key);
    if (a.type === "npm") {
      insist(
        item.source.type === "npm" &&
          (item.component === "pi" || item.component === "pnpm"),
        "npm asset source mismatch",
      );
      const name = a.role === "top-level" ? item.source.package : target.native;
      insist(
        a.role === "top-level" || item.component === "pnpm",
        "Unexpected native asset",
      );
      if (a.role === "native")
        insist(
          semver.satisfies(item.version, ">=12.15.0 <13.0.0"),
          "Unsupported pnpm native series",
        );
      insist(
        a.packageName === name && a.packageVersion === item.version,
        "npm asset package identity mismatch",
      );
      insist(
        asset.format === "npm-tarball" &&
          asset.digest.algorithm === "sha512-sri" &&
          asset.digestSource ===
            `https://registry.npmjs.org/${encodeURIComponent(name)}`,
        "npm asset evidence mismatch",
      );
      const identity = `${a.packageName}@${a.packageVersion}`;
      const evidence = JSON.stringify([
        asset.url,
        asset.digest.value,
        asset.digestSource,
      ]);
      insist(
        !npmIdentities.has(identity) ||
          npmIdentities.get(identity) === evidence,
        "Conflicting npm asset evidence",
      );
      npmIdentities.set(identity, evidence);
      checkNpmDistribution(asset.url, asset.digest.value);
    } else if (a.type === "uv") {
      insist(
        item.component === "uv" &&
          item.source.type === "github-release" &&
          a.releaseId === item.source.releaseId,
        "uv release identity mismatch",
      );
      insist(!uvIds.has(a.assetId), "Duplicate uv asset identity");
      uvIds.add(a.assetId);
      insist(
        asset.digest.algorithm === "sha256",
        "Invalid uv digest algorithm",
      );
      const result = checkUvDistribution(
        asset.target,
        item.source.tag,
        a.assetName,
        asset.url,
        `sha256:${asset.digest.value}`,
      );
      insist(
        result.format === asset.format &&
          result.digestSource === asset.digestSource &&
          result.sha256 === asset.digest.value,
        "uv asset evidence mismatch",
      );
    } else {
      insist(
        item.component === "herdr" && item.source.type === "channel-manifest",
        "herdr asset source mismatch",
      );
      insist(
        asset.digest.algorithm === "sha256",
        "Invalid herdr digest algorithm",
      );
      const result = checkHerdrDistribution(
        item.version,
        asset.target,
        asset.url,
        asset.digest.value,
      );
      insist(
        result.assetKey === a.assetKey &&
          result.assetName === a.assetName &&
          result.format === asset.format &&
          result.digestSource === asset.digestSource &&
          result.sha256 === asset.digest.value,
        "herdr asset evidence mismatch",
      );
    }
  }
  for (const item of lock.components)
    for (const target of lock.targets) {
      const role = item.source.type === "npm" ? "top-level" : "release";
      insist(
        seen.has(`${item.component}/${target.id}/${role}`),
        "Missing asset",
      );
      if (item.component === "pnpm")
        insist(
          seen.has(`${item.component}/${target.id}/native`),
          "Missing pnpm native asset",
        );
    }
  return lockValidationSummarySchema.parse({
    profile: lock.profile,
    targets: lock.targets.length,
    assets: lock.assets.length,
  });
}
