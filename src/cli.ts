#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { createDoctorCommand } from "./commands/doctor.js";
import { createValidateCommand } from "./commands/validate.js";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const program = new Command()
  .name("agent-stack")
  .description(
    "Manage a personal, composable agent environment from a Git repository",
  )
  .version(version)
  .addCommand(createValidateCommand())
  .addCommand(createDoctorCommand());

if (process.argv.length === 2) {
  program.outputHelp();
} else {
  await program.parseAsync();
}
