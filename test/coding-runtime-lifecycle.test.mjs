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

for (const cancel of ["none", "early", "shutdown", "corrupt"])
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
        finished = join(root, "finished.json"),
        staged = join(root, "staged"),
        release = join(root, "release");
      const skills = ["shape", "implement", "verify"].map((x) => join(root, x));
      await writeFile(agent, "Fixture agent");
      await writeFile(extension, "// fixture");
      for (const path of skills) {
        await mkdir(path);
        await writeFile(join(path, "SKILL.md"), "fixture");
      }
      await writeFile(
        pi,
        `import fs, {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {createConnection} from 'node:net';import {pathToFileURL} from 'node:url';
const started=${JSON.stringify(started)}, finished=${JSON.stringify(finished)}, staged=${JSON.stringify(staged)}, release=${JSON.stringify(release)};
if(${JSON.stringify(cancel)}==='none') {
 const original=fs.writeFileSync;
 fs.writeFileSync=(path,...args)=>{
  if(path===process.env.TMPDIR+'/probe.json.tmp'){const fd=fs.openSync(path,'wx',0o600);original(staged+'.tmp',process.env.TMPDIR);renameSync(staged+'.tmp',staged);while(!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);try{fs.writeFileSync(fd,args[0]);}finally{fs.closeSync(fd);}return;}
  return original(path,...args);
 };
 syncBuiltinESMExports();
}
const skillPaths=JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR+'/settings.json')).skills;
const handlers={};const api={on:(name,fn)=>handlers[name]=fn,getCommands:()=>${JSON.stringify(cancel)}==='corrupt'?[]:skillPaths.map(path=>({source:'skill',sourceInfo:{path:path+'/SKILL.md'}}))};
const ctx={mode:'tui',ui:{onTerminalInput(){}},getSystemPrompt:()=> 'Fixture agent',shutdown(){setTimeout(()=>{mkdirSync(process.env.TMPDIR+'/node-compile-cache',{recursive:true});writeFileSync(process.env.TMPDIR+'/node-compile-cache/flushed','yes');writeFileSync(finished,JSON.stringify({pid:process.pid,root:process.env.TMPDIR}));process.exit(0)},700)}};
await (await import(pathToFileURL(process.argv[process.argv.indexOf('-e')+1]).href)).default(api);
writeFileSync(started+'.tmp',JSON.stringify({pid:process.pid,root:process.env.TMPDIR}));renameSync(started+'.tmp',started);
if(${JSON.stringify(cancel)}==='corrupt') writeFileSync(process.env.TMPDIR+'/probe.json','{');
if(${JSON.stringify(cancel)}==='early') handlers.session_start({},ctx);
else {let acknowledged=0;for(const [id,method] of [[1,'pane.report_agent_session'],[2,'pane.report_agent']]){const socket=createConnection(process.env.HERDR_SOCKET_PATH);socket.on('connect',()=>socket.write(JSON.stringify({id,method,params:{pane_id:process.env.HERDR_PANE_ID,agent:'pi',source:'herdr:pi',state:'idle'}})+'\\n'));socket.on('data',()=>{socket.end();if(++acknowledged===2)handlers.session_start({},ctx)});}}
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
      if (cancel === "none") {
        let runtimeRoot;
        for (let i = 0; i < 150; i++) {
          try {
            runtimeRoot = await readFile(staged, "utf8");
            break;
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
            await delay(20);
          }
        }
        assert.ok(runtimeRoot, "probe did not stage its report");
        assert.equal(
          await readFile(join(runtimeRoot, "probe.json.tmp"), "utf8"),
          "",
        );
        await assert.rejects(access(join(runtimeRoot, "probe.json")), {
          code: "ENOENT",
        });
        assert.equal(
          await Promise.race([
            promise.then(
              () => false,
              () => false,
            ),
            delay(250).then(() => true),
          ]),
          true,
        );
        await writeFile(release, "continue");
        assert.equal((await promise).mode, "tui");
      } else if (cancel === "corrupt") {
        await assert.rejects(promise, SyntaxError);
      } else {
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
      }
      const result = JSON.parse(await readFile(finished, "utf8"));
      assert.throws(() => process.kill(result.pid, 0), { code: "ESRCH" });
      await assert.rejects(
        readFile(join(result.root, "node-compile-cache", "flushed")),
        { code: "ENOENT" },
      );
      await assert.rejects(access(result.root), { code: "ENOENT" });
    } finally {
      await writeFile(join(root, "release"), "continue").catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
