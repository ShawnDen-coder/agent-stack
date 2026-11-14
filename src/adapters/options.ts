import { type Command, InvalidArgumentError, Option } from "commander";

const seen = new Set<string>();
function once(name: string) {
  return (value: string) => {
    if (seen.has(name))
      throw new InvalidArgumentError(`${name} may only be specified once`);
    seen.add(name);
    return value;
  };
}
export function shared(command: Command): Command {
  return command
    .addOption(
      new Option(
        "--repo <directory>",
        "Configuration repository directory",
      ).argParser(once("--repo")),
    )
    .option("--json", "Print a machine-readable report");
}
export function profileOption(): Option {
  return new Option("--profile <id>", "Profile ID to check").argParser(
    once("--profile"),
  );
}
