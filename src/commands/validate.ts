import { resolve } from "node:path";
import { Command } from "commander";
import { readRepository } from "../adapters/repository.js";
import type { ValidationReport } from "../core/schema.js";
import { validateRepository } from "../core/validate.js";

export function createValidateCommand(): Command {
  return new Command("validate")
    .description(
      "Validate repository definitions without installing tools or writing configuration",
    )
    .option("--repo <directory>", "Configuration repository directory", ".")
    .option("--json", "Print a machine-readable report")
    .action(async (options: { repo: string; json?: boolean }) => {
      let report: ValidationReport;
      try {
        report = validateRepository(
          await readRepository(resolve(options.repo)),
        );
      } catch (error) {
        report = {
          valid: false,
          checked: { components: 0, integrations: 0, profiles: 0 },
          issues: [
            {
              file: "repository",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else if (report.valid) {
        const { components, integrations, profiles } = report.checked;
        console.log(
          `Definitions valid: ${components} components, ${integrations} integrations, ${profiles} profiles.`,
        );
        console.log(
          "Tool installation, versions, and runtime compatibility have not been checked.",
        );
      } else {
        for (const issue of report.issues)
          console.error(`${issue.file}: ${issue.message}`);
      }

      if (!report.valid) process.exitCode = 1;
    });
}
