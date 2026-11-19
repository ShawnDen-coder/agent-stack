import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { verifyCodingRuntime } from "../dist/adapters/coding-runtime.js";

for (const cancel of ["none", "early", "shutdown"])
  test(`runtime waits for Pi shutdown before cleanup (${cancel})`, {
    skip: process.platform !== "darwin",
    timeout: 20000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-lifecycle-"));
    try {
      const agent = join(root, "agent.md"),
        extension = join(root, "extension.ts"),
        pi = join(root, "fake-pi.mjs"),
        started = join(root, "started.json"),
        finished = join(root, "finished.json");
      const skills = ["shape", "implement", "verify"].map((x) => join(root, x));
      await writeFile(agent, "Fixture agent");
      await writeFile(extension, "// fixture");
      for (const path of skills) {
        await mkdir(path);
        await writeFile(join(path, "SKILL.md"), "fixture");
      }
      await writeFile(
        pi,
        `import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {createConnection} from 'node:net';import {pathToFileURL} from 'node:url';
const started=${JSON.stringify(started)}, finished=${JSON.stringify(finished)};
const skillPaths=JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR+'/settings.json')).skills;
const handlers={};const api={on:(name,fn)=>handlers[name]=fn,getCommands:()=>skillPaths.map(path=>({source:'skill',sourceInfo:{path:path+'/SKILL.md'}}))};
const ctx={mode:'tui',ui:{onTerminalInput(){}},getSystemPrompt:()=> 'Fixture agent',shutdown(){setTimeout(()=>{mkdirSync(process.env.TMPDIR+'/node-compile-cache',{recursive:true});writeFileSync(process.env.TMPDIR+'/node-compile-cache/flushed','yes');writeFileSync(finished,JSON.stringify({pid:process.pid,root:process.env.TMPDIR}));process.exit(0)},700)}};
await (await import(pathToFileURL(process.argv[process.argv.indexOf('-e')+1]).href)).default(api);handlers.session_start({},ctx);
writeFileSync(started+'.tmp',JSON.stringify({pid:process.pid,root:process.env.TMPDIR}));renameSync(started+'.tmp',started);
if(${JSON.stringify(cancel)}!=='early') for(const [id,method] of [[1,'pane.report_agent_session'],[2,'pane.report_agent']]){const socket=createConnection(process.env.HERDR_SOCKET_PATH);socket.on('connect',()=>socket.write(JSON.stringify({id,method,params:{pane_id:process.env.HERDR_PANE_ID,agent:'pi',source:'herdr:pi',state:'idle'}})+'\\n'));socket.on('data',()=>socket.end());}
setInterval(()=>{},1000);`,
      );
      const controller = new AbortController();
      const promise = verifyCodingRuntime({
        node: process.execPath,
        pi,
        agent,
        skills,
        extension,
        signal: controller.signal,
      });
      if (cancel !== "none") {
        let runtimeRoot;
        for (let i = 0; i < 150; i++) {
          try {
            runtimeRoot = JSON.parse(await readFile(started, "utf8")).root;
            break;
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
            await delay(20);
          }
        }
        assert.ok(runtimeRoot, "fake Pi did not start");
        if (cancel === "shutdown") {
          let requested = false;
          for (let i = 0; i < 250; i++) {
            try {
              await access(join(runtimeRoot, "shutdown.request"));
              requested = true;
              break;
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
              await delay(10);
            }
          }
          assert.ok(requested, "graceful shutdown was not requested");
        }
        controller.abort();
        await assert.rejects(promise, /Cancelled/);
      } else assert.equal((await promise).mode, "tui");
      const result = JSON.parse(await readFile(finished, "utf8"));
      assert.throws(() => process.kill(result.pid, 0), { code: "ESRCH" });
      await assert.rejects(
        readFile(join(result.root, "node-compile-cache", "flushed")),
        { code: "ENOENT" },
      );
      await assert.rejects(access(result.root), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
