import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { codingSkillNames } from "../core/coding-resources.js";

const probeSchema = z.strictObject({
  tui: z.literal(true),
  agent: z.literal(true),
  skills: z.array(z.string()).length(codingSkillNames.length),
});

// This is an active, isolated installation check. It creates a real PTY and
// starts Pi's TUI; it must never be used as a read-only doctor observation.
export async function verifyCodingRuntime(input: {
  node: string;
  pi: string;
  agent: string;
  skills: string[];
  extension: string;
  signal: AbortSignal;
}) {
  if (
    process.platform !== "darwin" ||
    ![
      input.node,
      input.pi,
      input.agent,
      input.extension,
      ...input.skills,
    ].every(isAbsolute) ||
    input.skills.length !== codingSkillNames.length
  )
    throw new Error(
      "Coding runtime verification requires native macOS and absolute resources",
    );
  if (input.signal.aborted) throw new Error("Cancelled");
  const root = await mkdtemp("/private/tmp/as-runtime-");
  const home = join(root, "home"),
    agentDir = join(root, "agent"),
    socketPath = join(root, "s.sock");
  const probePath = join(root, "probe.json"),
    probeExtension = join(root, "probe.ts"),
    shutdownPath = join(root, "shutdown.request");
  const sockets = new Set<Socket>();
  let session = false,
    idle = false;
  const pane = "agent-stack-installation-check";
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let bytes = "";
    socket.on("data", (data) => {
      bytes += data.toString("utf8");
      if (bytes.length > 16384) {
        socket.destroy();
        return;
      }
      const end = bytes.indexOf("\n");
      if (end < 0) return;
      try {
        const message = z
          .object({
            id: z.union([z.string(), z.number()]),
            method: z.string(),
            params: z.object({
              pane_id: z.string(),
              agent: z.string(),
              source: z.string(),
              state: z.string().optional(),
            }),
          })
          .parse(JSON.parse(bytes.slice(0, end)));
        if (
          message.params.pane_id !== pane ||
          message.params.agent !== "pi" ||
          message.params.source !== "herdr:pi"
        )
          throw Error("Unexpected Pi integration report");
        if (message.method === "pane.report_agent_session") session = true;
        if (
          message.method === "pane.report_agent" &&
          message.params.state === "idle"
        )
          idle = true;
        socket.end(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      } catch {
        socket.destroy();
      }
    });
  });
  server.maxConnections = 16;
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  let exited = false;
  let scriptResult: number | undefined;
  let scriptInvalid = false;
  let verified = false;
  let operationError: unknown;
  let shutdownError: Error | undefined;
  let outputFile: Awaited<ReturnType<typeof open>> | undefined;
  const kill = () => {
    if (
      child?.pid &&
      !exited &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  try {
    const agentText = await readFile(input.agent, "utf8");
    if (!agentText.trim()) throw Error("Coding agent is empty");
    await mkdir(home, { mode: 0o700 });
    await mkdir(join(agentDir, "extensions"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ skills: input.skills }),
    );
    await writeFile(
      join(agentDir, "extensions", "herdr-agent-state.ts"),
      await readFile(input.extension),
    );
    // The probe emits only booleans and canonical skill provenance. No system
    // prompt, model credentials, sessions or user configuration leave the TUI.
    await writeFile(
      probeExtension,
      `import {existsSync,writeFileSync} from "node:fs";
export default function(pi) {
 let timer, reported=false, stopping=false;
 pi.on("session_start",(_event,ctx) => {
  if(ctx.mode === "tui") ctx.ui.onTerminalInput(() => ({consume:true}));
  timer=setInterval(() => {
   if(existsSync(${JSON.stringify(shutdownPath)})) {if(!stopping){stopping=true;ctx.shutdown();}return;}
   if(reported)return;
   const commands=pi.getCommands();
   const required=${JSON.stringify(input.skills.map((path) => join(path, "SKILL.md")))};
   const skills=required.filter(path => commands.some(c => c.source === "skill" && c.sourceInfo?.path === path));
   const agent=ctx.getSystemPrompt().includes(${JSON.stringify(agentText.trim())});
   if(skills.length === 3 && agent) {writeFileSync(${JSON.stringify(probePath)},JSON.stringify({tui:ctx.mode === "tui",agent,skills}));reported=true;}
  },100);
 });
 pi.on("session_shutdown",()=>clearInterval(timer));
}
`,
    );
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(socketPath, () => {
        server.removeListener("error", fail);
        done();
      });
    });
    // script needs a POSIX pipe rather than Node's socket-backed stdin, and
    // it must stay open until the check finishes. Shell source is constant;
    // every executable/resource path is a separately quoted positional arg.
    outputFile = await open(join(root, "terminal.log"), "wx+", 0o600);
    child = spawn(
      "/bin/sh",
      [
        "-c",
        '/bin/sleep 30 | { /usr/bin/script -q /dev/null "$@" 3>&-; code=$?; printf "%s\\n" "$code" >&3; exit "$code"; }',
        "agent-stack-pty",
        input.node,
        input.pi,
        "--no-session",
        "--no-context-files",
        "-e",
        probeExtension,
        "--append-system-prompt",
        input.agent,
      ],
      {
        cwd: root,
        detached: true,
        stdio: ["ignore", outputFile.fd, outputFile.fd, "pipe"],
        env: {
          PATH: `${dirname(input.node)}:/usr/bin:/bin`,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: root,
          PI_CODING_AGENT_DIR: agentDir,
          TERM: "xterm-256color",
          LANG: "en_US.UTF-8",
          HERDR_ENV: "1",
          HERDR_SOCKET_PATH: socketPath,
          HERDR_PANE_ID: pane,
        },
      },
    );
    let failure: Error | undefined;
    child.on("error", () => {
      failure = new Error("Cannot start the Pi TUI verification");
    });
    let resultBytes = "";
    const resultPipe = child.stdio[3];
    if (!resultPipe || !("on" in resultPipe))
      throw Error("Missing Pi completion pipe");
    resultPipe.on("data", (chunk: Buffer) => {
      if (scriptInvalid) return;
      if (resultBytes.length + chunk.length > 16) {
        scriptInvalid = true;
        return;
      }
      resultBytes += chunk.toString("ascii");
      if (resultBytes.includes("\n")) {
        if (
          /^(0|[1-9][0-9]{0,2})\n$/.test(resultBytes) &&
          Number(resultBytes.trim()) <= 255
        )
          scriptResult = Number(resultBytes.trim());
        else scriptInvalid = true;
      }
    });
    resultPipe.on("end", () => {
      if (scriptResult === undefined) scriptInvalid = true;
    });
    closed = new Promise<void>((done) =>
      child?.once("close", () => {
        exited = true;
        done();
      }),
    );
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (input.signal.aborted) throw Error("Cancelled");
      if ((await outputFile.stat()).size > 2 * 1024 * 1024)
        throw Error("Pi verification output exceeded its limit");
      if (failure) throw failure;
      if (exited) throw Error("Pi TUI exited before resource verification");
      if (session && idle) {
        try {
          const result = probeSchema.parse(
            JSON.parse(await readFile(probePath, "utf8")),
          );
          if (
            JSON.stringify(result.skills) !==
            JSON.stringify(input.skills.map((path) => join(path, "SKILL.md")))
          )
            throw Error("Unexpected skill provenance");
          verified = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await delay(100);
    }
    if (!verified)
      throw Error(
        "Pi TUI resource loading or Herdr session/idle integration was not verified",
      );
  } catch (error) {
    operationError = error;
  } finally {
    if (child?.pid && !exited) {
      await writeFile(shutdownPath, "shutdown\n", {
        mode: 0o600,
        flag: "wx",
      }).catch(() => {});
      const deadline = Date.now() + 5000;
      while (
        scriptResult === undefined &&
        !scriptInvalid &&
        Date.now() < deadline
      )
        await delay(50);
    }
    kill();
    let closedInTime = !child?.pid;
    if (closed) {
      closedInTime = await Promise.race([
        closed.then(() => true),
        delay(2000).then(() => false),
      ]);
    }
    if (!closedInTime) {
      child?.stdio[3]?.destroy();
      child?.unref();
    }
    await outputFile?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => {
      if (server.listening) server.close(() => done());
      else done();
    });
    if ((!child?.pid || (scriptResult === 0 && !scriptInvalid)) && closedInTime)
      await rm(root, { recursive: true, force: true });
    if (child?.pid && (scriptResult !== 0 || scriptInvalid || !closedInTime))
      shutdownError = Error(
        `Pi TUI shutdown was not confirmed; temporary evidence retained at ${root}`,
      );
  }
  if (shutdownError) throw shutdownError;
  if (operationError) throw operationError;
  if (input.signal.aborted) throw Error("Cancelled");
  return {
    mode: "tui" as const,
    agent: true as const,
    skills: [...codingSkillNames],
    integration: "herdr-0.9.5-pi-v9" as const,
    session: true as const,
    idle: true as const,
  };
}
