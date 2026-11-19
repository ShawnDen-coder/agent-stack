import { join, resolve } from "node:path";
import { Command } from "commander";
import { LockReadError, readLock } from "../adapters/lock-reader.js";
import { shared } from "../adapters/options.js";
import { validation } from "../adapters/presentation.js";
import { lockRecovery } from "../adapters/recovery.js";
import { readRepository } from "../adapters/repository.js";
import type { ValidationReport } from "../core/schema.js";
import { validateRepository } from "../core/validate.js";
import { validateLock } from "../core/validate-lock.js";

export function createValidateCommand(): Command {
  return shared(
    new Command("validate").description(
      "Validate repository definitions without installing tools or writing configuration",
    ),
  )
    .option(
      "--lock [file]",
      "Validate a shared lock (default: stack/stack.lock.json)",
    )
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals() as {
        repo?: string;
        json?: boolean;
        lock?: boolean | string;
      };
      if (typeof options.lock === "string" && !options.lock.trim())
        command.error("error: --lock path must not be empty or whitespace");
      const repo = resolve(options.repo ?? ".");
      let report: ValidationReport;
      try {
        const repository = await readRepository(repo);
        report = validateRepository(repository);
        if (options.lock !== undefined) {
          const path =
            options.lock === true
              ? join(repo, "stack", "stack.lock.json")
              : resolve(options.lock as string);
          try {
            const info = validateLock(await readLock(path), repository);
            report.checked.lock = info;
          } catch (error) {
            report.valid = false;
            report.issues.push({
              file: "lock",
              message: error instanceof Error ? error.message : "Invalid lock",
              reason:
                error instanceof LockReadError ? error.reason : "lock_invalid",
              path,
              next: lockRecovery(repo, path),
            });
          }
        }
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
