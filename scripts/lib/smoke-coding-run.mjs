import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Active acceptance only: a private HOME and test-owned Herdr server/pane.
// No prompt or model request is submitted. Caller supplies an already-installed CLI.
export async function smokeCodingRun({ root, home, repo, env, cliCommand }) {
  const herdr = join(home, ".agent-stack", "bin", "herdr");
  const terminalEnv = { ...env, SHELL: "/bin/sh", TERM: "xterm-256color" };
  const invoke = (file, args, context = terminalEnv) =>
    new Promise((done, fail) => {
      execFile(
        file,
        args,
        {
          cwd: root,
          env: context,
          encoding: "utf8",
          timeout: 120000,
          maxBuffer: 1024 * 1024,
          killSignal: "SIGKILL",
        },
        (error, stdout, stderr) =>
          error
            ? fail(Error(`${file}: ${error.message}\n${stdout}\n${stderr}`))
            : done(stdout),
      );
    });
  const session = "coding-acceptance";
  const run = (args) => invoke(herdr, ["--session", session, ...args]);
  const server = spawn(herdr, ["--session", session, "server"], {
    cwd: root,
    env: terminalEnv,
    stdio: "ignore",
  });
  server.on("error", () => {});
  try {
    let live = false;
    for (let index = 0; index < 80; index++) {
      try {
        if ((await run(["status", "server"])).includes("status: running")) {
          live = true;
          break;
        }
      } catch {}
      await delay(100);
    }
    assert(live, "Test Herdr server must become reachable");
    const result = JSON.parse(
      await run(["workspace", "create", "--cwd", root, "--label", session]),
    ).result;
    const pane = result.root_pane.pane_id;
    const cwd = join(root, "project"),
      probe = join(root, "probe.ts"),
      output = join(root, "run-probe.json"),
      exit = join(root, "run-exit");
    await mkdir(cwd, { recursive: true });
    await rm(output, { force: true });
    await rm(exit, { force: true });
    const agent = (
      await readFile(join(repo, "stack", "agents", "coding.md"), "utf8")
    ).trim();
    const required = ["shape", "implement", "verify"].map((name) =>
      join(repo, "stack", "skills", name, "SKILL.md"),
    );
    await writeFile(
      probe,
      `import {writeFileSync} from 'node:fs'; export default function(pi) { let timer; pi.on('session_start',(_e,ctx)=>{timer=setInterval(()=>{const commands=pi.getCommands();const required=${JSON.stringify(required)};const skills=required.filter(path=>commands.some(c=>c.source==='skill'&&c.sourceInfo?.path===path));const agent=ctx.getSystemPrompt().includes(${JSON.stringify(agent)});if(skills.length===3&&agent){writeFileSync(${JSON.stringify(output)},JSON.stringify({tui:ctx.mode==='tui',agent,skills,cwd:ctx.cwd}));clearInterval(timer)}},100)});pi.on('session_shutdown',()=>clearInterval(timer));}`,
    );
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [
      "/usr/bin/env",
      ...Object.entries(terminalEnv).map(([key, value]) => `${key}=${value}`),
      ...cliCommand,
      "run",
      "coding",
      "--repo",
      repo,
      "--cwd",
      cwd,
      "--",
      "--no-session",
      "--extension",
      probe,
    ]
      .map(quote)
      .join(" ");
    const launch = join(root, "launch.sh");
    await writeFile(
      launch,
      `#!/bin/sh\n${command}\nstatus=$?\nprintf '%s\\n' "$status" > ${quote(exit)}\nexit "$status"\n`,
      { mode: 0o600 },
    );
    // Herdr enforces the terminal's canonical line limit. Keep this input short;
    // the test-owned script carries the fully quoted environment and argv.
    await run(["pane", "run", pane, `/bin/sh ${quote(launch)}`]);
    let probeResult;
    for (let index = 0; index < 1200; index++) {
      try {
        probeResult = JSON.parse(await readFile(output, "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(100);
    }
    if (!probeResult)
      throw Error(
        `No Pi resource probe: ${await run(["pane", "read", pane, "--lines", "100"])}`,
      );
    assert.equal(probeResult.tui, true);
    assert.equal(probeResult.agent, true);
    assert.equal(probeResult.cwd, cwd);
    assert.deepEqual(probeResult.skills, required);
    let agentState;
    for (let index = 0; index < 100; index++) {
      const agents = JSON.parse(await run(["agent", "list"])).result.agents;
      agentState = agents.find(
        (item) =>
          item.pane_id === pane &&
          item.agent === "pi" &&
          item.agent_status === "idle" &&
          item.agent_session?.source === "herdr:pi",
      );
      if (agentState) break;
      await delay(100);
    }
    assert(
      agentState?.agent_session?.value,
      "Herdr must receive the actual Pi session and idle status",
    );
    await run(["pane", "send-keys", pane, "ctrl+c"]);
    await delay(200);
    await run(["pane", "send-keys", pane, "ctrl+c"]);
    let code;
    for (let index = 0; index < 200; index++) {
      try {
        code = (await readFile(exit, "utf8")).trim();
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(100);
    }
    assert.equal(
      code,
      "0",
      "Native Pi Ctrl-C exit status must reach the calling shell",
    );
    const doctor = JSON.parse(
      await invoke(
        cliCommand[0],
        [
          ...cliCommand.slice(1),
          "doctor",
          "--profile",
          "coding",
          "--repo",
          repo,
          "--json",
        ],
        env,
      ),
    );
    assert.equal(
      doctor.readiness.ready,
      true,
      "Pi startup bookkeeping must not invalidate readiness",
    );
    return {
      tui: true,
      agent: true,
      skills: 3,
      herdr: "live local session and idle",
      cwd: true,
      exit: Number(code),
      doctorAfterRun: true,
    };
  } finally {
    await run(["server", "stop"]).catch(() => server.kill("SIGKILL"));
  }
}
