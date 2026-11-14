import {
  cancel,
  intro,
  isCancel,
  outro,
  select,
  spinner,
} from "@clack/prompts";
import { createColors } from "picocolors";
import type { assess } from "../core/doctor.js";
import type { Profile, ValidationReport } from "../core/schema.js";

const interactive = () =>
  Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
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

export async function chooseProfile(
  profiles: { id: string; description: string }[],
): Promise<string | null> {
  if (!interactive()) return null;
  const value = await select({
    message: "Choose a profile",
    options: profiles.map(({ id, description }) => ({
      value: id,
      label: id,
      hint: description,
    })),
  });
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exitCode = 130;
    return null;
  }
  return value;
}
export function start(title: string, json: boolean) {
  if (json) return;
  if (interactive()) intro(title);
  else console.log(`\n${title}\n`);
}
export function progress(
  message: string,
  json: boolean,
): (interrupted?: boolean) => void {
  if (json || !interactive()) return () => {};
  const task = spinner({ accessible: true });
  task.start(message);
  return (interrupted) =>
    task.stop(interrupted ? "Inspection interrupted" : "Checks complete");
}
export function finish(message: string, json: boolean) {
  if (json) return;
  if (interactive()) outro(message);
  else console.log(`\n${message}`);
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
  console.log(`Repository: ${repo}`);
  const { components, integrations, profiles } = report.checked;
  console.log(
    `\n${report.valid ? colors.green("[OK]") : colors.red("[ERROR]")} Definitions: ${components} components, ${integrations} integrations, ${profiles} profiles`,
  );
  if (report.issues.length) {
    console.log("\nIssues:");
    for (const issue of report.issues)
      console.log(`  [ERROR] ${issue.file}\n    ${issue.message}`);
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
  console.log(
    `Repository: ${repo}\nProfile: ${report.profile} · ${report.platform}\n\nToolchain`,
  );
  for (const item of report.checks) {
    const mark =
      item.status === "ok" && !item.channel
        ? colors.green("[OK]")
        : colors.yellow("[CHECK]");
    console.log(`\n  ${mark} ${item.name} · ${item.status}`);
    console.log(
      `    Observed: ${item.version ?? "unknown"}  |  Required: ${item.requirement ?? (item.channel ? `channel ${item.channel} (not assessed)` : "none")}`,
    );
    console.log(`    Path: ${item.path ?? "unknown"}`);
    console.log(
      `    Evidence: ${item.evidence ?? "none"}  |  Source: ${item.source}`,
    );
  }
  console.log(
    `\nNot checked\n  Components: ${report.unchecked.components.map((item) => item.component).join(", ") || "none"}\n  Integrations: ${report.unchecked.integrations.join(", ") || "none"}`,
  );
  finish(
    `${report.scope}. Review checks above and rerun doctor after resolving issues.`,
    false,
  );
}
export function failure(message: string, json: boolean) {
  if (json) console.log(JSON.stringify({ error: message }));
  else
    console.error(
      `\n[ERROR] ${message}\n  Check the repository and arguments, then retry.`,
    );
}
