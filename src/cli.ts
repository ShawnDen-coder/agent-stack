#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { cliPackage } from "./adapters/cli-package.js";
import { shared } from "./adapters/options.js";
import { helpStyle } from "./adapters/presentation.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createLockCommand } from "./commands/lock.js";
import { createRunCommand } from "./commands/run.js";
import { createSetupCommand } from "./commands/setup.js";
import { createValidateCommand } from "./commands/validate.js";

if (process.env.NO_COLOR !== undefined) delete process.env.FORCE_COLOR;
const wrapperArguments = process.argv.slice(2);
const nativeArgumentsAt = wrapperArguments.indexOf("--");
const wantsJson = (
  nativeArgumentsAt < 0
    ? wrapperArguments
    : wrapperArguments.slice(0, nativeArgumentsAt)
).includes("--json");
let errorOutput = "";
let helpOutput = "";
const output = {
  writeErr: (text: string) => {
    errorOutput += text;
  },
  writeOut: (text: string) => {
    if (wantsJson) helpOutput += text;
    else process.stdout.write(text);
  },
};
const program = shared(new Command())
  .name("agent-stack")
  .description(
    "Manage a personal, composable agent environment from a Git repository",
  )
  .version(cliPackage.version)
  .configureOutput(output)
  .configureHelp(helpStyle(wantsJson))
  .addHelpText(
    "after",
    "\nFor an existing Pi: pi install <checkout>/stack, then run pi.\nRun agent-stack <command> --help for command details.",
  )
  .allowExcessArguments(false)
  .exitOverride()
  .addCommand(createValidateCommand())
  .addCommand(createDoctorCommand())
  .addCommand(createLockCommand())
  .addCommand(createSetupCommand())
  .addCommand(createRunCommand());
for (const command of program.commands) {
  command
    .configureOutput(output)
    .configureHelp(helpStyle(wantsJson))
    .allowExcessArguments(false)
    .exitOverride();
}
try {
  if (process.argv.length === 2) program.outputHelp();
  else {
    await program.parseAsync();
    if (program.args.length === 0) program.outputHelp();
  }
  if (wantsJson && helpOutput)
    console.log(JSON.stringify({ schemaVersion: 1, output: helpOutput }));
} catch (error) {
  if (!(error instanceof CommanderError)) throw error;
  if (error.exitCode === 0) {
    if (wantsJson && helpOutput)
      console.log(JSON.stringify({ schemaVersion: 1, output: helpOutput }));
    process.exitCode = 0;
  } else {
    const message = (errorOutput || error.message)
      .trim()
      .replace(/^error:\s*/i, "");
    if (wantsJson)
      console.log(
        JSON.stringify({ schemaVersion: 1, error: { kind: "usage", message } }),
      );
    else
      console.error(`[ERROR] ${message}\n  Run agent-stack --help for usage.`);
    process.exitCode = 2;
  }
}
