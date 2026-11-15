import assert from "node:assert/strict";
import test from "node:test";

import {
  outputLinePresent,
  stopServerCleanly,
} from "../scripts/lib/herdr-smoke-checks.mjs";

test("Herdr runtime output requires a complete line, not a command echo", () => {
  for (const marker of [
    "agent_stack_smoke_before",
    "agent_stack_smoke_after",
  ]) {
    assert.equal(
      outputLinePresent(`shell$ printf '${marker}\\n'\r\n`, marker),
      false,
    );
    assert.equal(outputLinePresent(`prefix_${marker}\n`, marker), false);
    assert.equal(outputLinePresent(`${marker}_suffix\n`, marker), false);
    assert.equal(
      outputLinePresent(`shell$ command\r\n${marker}\r\nshell$ `, marker),
      true,
    );
    assert.equal(outputLinePresent("", marker), false);
  }
});

test("Herdr normal stop waits for a successful server exit", async () => {
  const server = { exitCode: null, signalCode: null };
  let stopped = false,
    waited = false;
  await stopServerCleanly(
    server,
    async () => {
      stopped = true;
    },
    async (exited) => {
      assert.equal(stopped, true);
      assert.equal(exited(), false);
      server.exitCode = 0;
      assert.equal(exited(), true);
      waited = true;
    },
  );
  assert.equal(waited, true);
});

test("Herdr normal stop rejects a server that already exited or was killed", async () => {
  for (const server of [
    { exitCode: 7, signalCode: null },
    { exitCode: null, signalCode: "SIGKILL" },
  ]) {
    let stopped = false;
    await assert.rejects(
      stopServerCleanly(
        server,
        async () => {
          stopped = true;
        },
        async () => {},
      ),
    );
    assert.equal(stopped, false);
  }
});

test("Herdr normal stop rejects an unsuccessful exit after the stop request", async () => {
  for (const outcome of [
    { exitCode: 7, signalCode: null },
    { exitCode: null, signalCode: "SIGKILL" },
  ]) {
    const server = { exitCode: null, signalCode: null };
    await assert.rejects(
      stopServerCleanly(
        server,
        async () => {},
        async (exited) => {
          Object.assign(server, outcome);
          assert.equal(exited(), true);
        },
      ),
    );
  }
});

test("Herdr normal stop propagates stop and exit-wait failures", async () => {
  for (const failStop of [true, false]) {
    const error = new Error(failStop ? "stop failed" : "exit timed out");
    await assert.rejects(
      stopServerCleanly(
        { exitCode: null, signalCode: null },
        async () => {
          if (failStop) throw error;
        },
        async () => {
          throw error;
        },
      ),
      (caught) => caught === error,
    );
  }
});
