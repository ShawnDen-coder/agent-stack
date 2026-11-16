import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

export async function inspectHerdrContext(input: {
  herdr: string;
  version: string;
  signal: AbortSignal;
}) {
  const pane = process.env.HERDR_PANE_ID,
    socket = process.env.HERDR_SOCKET_PATH;
  if (
    process.env.HERDR_ENV !== "1" ||
    !pane ||
    pane.length > 256 ||
    !socket ||
    !isAbsolute(socket)
  )
    return {
      ready: false,
      reason: "Run coding inside a local Herdr pane with its native context",
      scope: "current local Herdr pane and protocol",
    };
  try {
    if (!(await lstat(socket)).isSocket())
      throw Error("Herdr context endpoint is not a local socket");
    const command = (args: string[]) =>
      new Promise<string>((done, fail) => {
        const child = execFile(
          input.herdr,
          args,
          {
            cwd: process.cwd(),
            env: process.env,
            encoding: "utf8",
            timeout: 5000,
            maxBuffer: 65536,
            killSignal: "SIGKILL",
            signal: input.signal,
          },
          (error, stdout) =>
            error
              ? fail(Error("Current Herdr context is unreachable"))
              : done(stdout),
        );
        child.stdin?.end();
      });
    const status = await command(["status", "server"]);
    for (const line of [
      "status: running",
      `version: ${input.version}`,
      "endpoint_compatible: yes",
      "private_protocol: 22",
      "private_protocol_compatible: yes",
    ])
      if (
        !status
          .split(/\r?\n/)
          .map((value) => value.trim())
          .includes(line)
      )
        throw Error(
          "Herdr server version or protocol does not match the verified coding integration",
        );
    const response = z
      .object({ result: z.object({ pane: z.object({ pane_id: z.string() }) }) })
      .parse(JSON.parse(await command(["pane", "get", pane])));
    if (response.result.pane.pane_id !== pane)
      throw Error("Herdr pane context does not match");
    return {
      ready: true,
      reason: null,
      scope: "current local Herdr pane and protocol",
    };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
      scope: "current local Herdr pane and protocol",
    };
  }
}
