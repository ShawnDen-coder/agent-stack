import semver from "semver";
export type Observation = {
  path: string | null;
  version: string | null;
  failure: string | null;
  evidence:
    | "running_process"
    | "version_command"
    | "package_metadata"
    | "installation_receipt"
    | null;
};

export function assess(observation: Observation, requirement: string | null) {
  if (observation.failure)
    return {
      ...observation,
      requirement,
      status: observation.failure,
      source: "unknown",
    };
  if (!observation.version || !semver.valid(observation.version))
    return {
      ...observation,
      requirement,
      status: "unparseable_version",
      source: "unknown",
    };
  if (requirement && !semver.validRange(requirement))
    return {
      ...observation,
      requirement,
      status: "unparseable_requirement",
      source: "unknown",
    };
  return {
    ...observation,
    requirement,
    status:
      requirement && !semver.satisfies(observation.version, requirement)
        ? "version_mismatch"
        : "ok",
    source: "unknown",
  };
}
