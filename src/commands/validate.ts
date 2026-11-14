import { resolve } from "node:path";
import { Command } from "commander";
import { shared } from "../adapters/options.js";
import { validation } from "../adapters/presentation.js";
import { readRepository } from "../adapters/repository.js";
import type { ValidationReport } from "../core/schema.js";
import { validateRepository } from "../core/validate.js";

export function createValidateCommand(): Command {
  return shared(
    new Command("validate").description(
      "Validate repository definitions without installing tools or writing configuration",
    ),
  ).action(async (_options: unknown, command: Command) => {
    const options = command.optsWithGlobals() as {
      repo?: string;
      json?: boolean;
    };
    const repo = resolve(options.repo ?? ".");
    let report: ValidationReport;
    try {
      report = validateRepository(await readRepository(repo));
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

    validation(report, repo, Boolean(options.json));

    if (!report.valid) process.exitCode = 1;
  });
}
