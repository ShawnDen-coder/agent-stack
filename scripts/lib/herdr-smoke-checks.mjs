import assert from "node:assert/strict";

export function outputLinePresent(output, marker) {
  return output.replaceAll("\r", "").split("\n").includes(marker);
}

export async function stopServerCleanly(server, requestStop, waitFor) {
  assert.ok(server, "server must have been started");
  assert.equal(server.exitCode, null, "server exited before stop");
  assert.equal(server.signalCode, null, "server was killed before stop");
  await requestStop();
  await waitFor(
    () => server.exitCode !== null || server.signalCode !== null,
    "server exit",
  );
  assert.equal(server.signalCode, null, "server was killed during stop");
  assert.equal(server.exitCode, 0, "server stop must exit successfully");
}
