import { stripVTControlCharacters } from "node:util";
import {
  cancel,
  intro,
  isCancel,
  outro,
  select,
  spinner,
} from "@clack/prompts";
import stringWidth from "fast-string-width";
import { wrapAnsi } from "fast-wrap-ansi";
import { createColors } from "picocolors";
import type { assess } from "../core/doctor.js";
import type { ResolutionReport } from "../core/resolution-report.js";
import type { Profile, ValidationReport } from "../core/schema.js";

const interactive = () =>
  Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
      process.stderr.isTTY &&
      !process.env.CI &&
      process.env.TERM !== "dumb",
  );
const colors = createColors(
  Boolean(
    process.stdout.isTTY &&
      !process.env.CI &&
      process.env.TERM !== "dumb" &&
      process.env.NO_COLOR === undefined,
  ),
);
const clean = (value: string) =>
  stripVTControlCharacters(value).replace(/[\r\n]/g, " ");
function columns() {
  return Math.max(20, process.stdout.isTTY ? process.stdout.columns || 80 : 80);
}
function line(value = "", indent = "", exact = false) {
  const width = Math.max(1, columns() - stringWidth(indent));
  const wrapped = wrapAnsi(value, width, {
    hard: true,
    wordWrap: !exact,
    trim: false,
  });
  for (const row of wrapped.split("\n")) console.log(indent + row);
}
function pair(left: string, right: string) {
  if (stringWidth(`    ${left}  |  ${right}`) <= columns())
    line(`${left}  |  ${right}`, "    ");
  else {
    line(left, "    ");
    line(right, "    ");
  }
}

export async function chooseProfile(
  profiles: { id: string; description: string }[],
): Promise<string | null> {
  if (!interactive()) return null;
  const value = await select({
    message: "Choose a profile",
    input: process.stdin,
    output: process.stderr,
    options: profiles.map(({ id, description }) => ({
      value: id,
      label: clean(id),
      hint: clean(description),
    })),
  });
  if (isCancel(value)) {
    cancel("Cancelled.", { output: process.stderr });
    process.exitCode = 130;
    return null;
  }
  return value;
}
export function start(title: string, json: boolean) {
  if (json) return;
  if (interactive()) intro(title, { output: process.stderr });
  line();
  line(title);
  line();
}
export function progress(
  message: string,
  json: boolean,
): (interrupted?: boolean) => void {
  if (json || !interactive()) return () => {};
  const task = spinner({ accessible: true, output: process.stderr });
  task.start(message);
  return (interrupted) =>
    task.stop(interrupted ? "Inspection interrupted" : "Checks complete");
}
export function finish(message: string, json: boolean) {
  if (json) return;
  line();
  line(message);
  if (interactive()) outro("Report complete.", { output: process.stderr });
}
export function validation(
  report: ValidationReport,
  repo: string,
  json: boolean,
) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  start("Agent Stack · Validate", false);
  line("Repository:");
  line(clean(repo), "  ", true);
  const { components, integrations, profiles } = report.checked;
  line();
  line(
    `${report.valid ? colors.green("[OK]") : colors.red("[ERROR]")} Definitions: ${components} components, ${integrations} integrations, ${profiles} profiles`,
  );
  if (report.issues.length) {
    line();
    line("Issues:");
    for (const issue of report.issues) {
      line(`[ERROR] ${clean(issue.file)}`, "  ");
      line(clean(issue.message), "    ");
    }
    finish("Fix the reported definitions and run validate again.", false);
  } else
    finish(
      "Tool installation, versions, and runtime compatibility have not been checked.",
      false,
    );
}
type DoctorReport = {
  profile: string;
  platform: string;
  checks: Array<
    ReturnType<typeof assess> & {
      name: string;
      channel: "stable" | "beta" | null;
    }
  >;
  unchecked: { components: Profile["components"]; integrations: string[] };
  scope: string;
};
export function helpStyle(json: boolean) {
  return { styleTitle: (text: string) => (json ? text : colors.bold(text)) };
}
export function doctor(report: DoctorReport, repo: string, json: boolean) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  line("Repository:");
  line(clean(repo), "  ", true);
  line(`Profile: ${clean(report.profile)} · ${clean(report.platform)}`);
  line();
  line("Toolchain");
  const failedStatuses = new Set([
    "not_found",
    "version_mismatch",
    "nonzero_exit",
    "execution_error",
    "timeout",
    "output_limit",
  ]);
  let matched = 0;
  let observed = 0;
  let failed = 0;
  let unknown = 0;
  for (const item of report.checks) {
    const failedCheck = failedStatuses.has(item.status);
    const matchedCheck =
      item.status === "ok" && !item.channel && item.requirement !== null;
    const observedCheck =
      item.status === "ok" && !item.channel && item.requirement === null;
    if (failedCheck) failed++;
    else if (matchedCheck) matched++;
    else if (observedCheck) observed++;
    else unknown++;
    const mark = failedCheck
      ? colors.red("[FAIL]")
      : matchedCheck
        ? colors.green("[MATCH]")
        : observedCheck
          ? "[OBSERVED]"
          : colors.yellow("[UNKNOWN]");
    const status =
      item.status === "ok" && item.channel
        ? "channel not assessed"
        : item.status;
    line();
    line(`${mark} ${clean(item.name)} · ${clean(status)}`, "  ");
    pair(
      `Observed: ${clean(item.version ?? "unknown")}`,
      `Required: ${clean(item.requirement ?? (item.channel ? `channel ${item.channel} (not assessed)` : "none"))}`,
    );
    line("Path:", "    ");
    line(clean(item.path ?? "unknown"), "      ", true);
    pair(
      `Evidence: ${clean(item.evidence ?? "none")}`,
      `Source: ${clean(item.source)}`,
    );
  }
  line();
  line("Not checked");
  line(
    `Components: ${report.unchecked.components.map((item) => item.component).join(", ") || "none"}`,
    "  ",
  );
  line(
    `Integrations: ${report.unchecked.integrations.map(clean).join(", ") || "none"}`,
    "  ",
  );
  line();
  line("Summary");
  line(`Matched: ${matched}  Observed: ${observed}`, "  ");
  line(`Failed: ${failed}  Unknown: ${unknown}`, "  ");
  if (report.checks.some((item) => item.status === "not_found"))
    line(
      "Next: Check PATH or install missing tools through their native channels.",
    );
  if (report.checks.some((item) => item.status === "version_mismatch"))
    line("Next: Compare installed versions with the requirements.");
  if (unknown) line("Next: Inspect unknown entries and unresolved channels.");
  line("Package metadata does not prove a program can run.");
  finish(`${report.scope}.`, false);
}
export function failure(message: string, json: boolean) {
  if (json) console.log(JSON.stringify({ error: message }));
  else
    console.error(
      `\n[ERROR] ${clean(message)}\n  Check the repository and arguments, then retry.`,
    );
}

export function resolution(report: ResolutionReport, json: boolean) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  line(`Profile: ${clean(report.profile)}`);
  line(`Node: ${clean(report.node)}`);
  let blocked = 0;
  for (const item of report.components) {
    line();
    if ("error" in item) {
      blocked++;
      line(`${colors.red("[BLOCKED]")} ${clean(item.component)}`);
      line(clean(item.error), "  ");
    } else {
      line(
        `${colors.green("[CANDIDATE]")} ${clean(item.component)}: ${clean(item.package)}@${clean(item.version)}`,
      );
      line(`Required: ${clean(item.requirement)}`, "  ");
      for (const [label, value] of [
        ["Metadata", item.metadata],
        ["Tarball", item.tarball],
        ["Expected integrity", item.integrity],
      ] as const) {
        line(`${label}:`, "  ");
        line(clean(value), "    ", true);
      }
    }
  }
  line();
  line(
    `Candidates: ${report.components.length - blocked}  Blocked: ${blocked}`,
  );
  if (blocked) line("Next: Review blocked sources or metadata and retry.");
  finish(clean(report.scope), false);
}
