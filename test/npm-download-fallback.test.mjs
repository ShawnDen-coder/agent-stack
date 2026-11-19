import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { Readable } from "node:stream";
import test from "node:test";
import { downloadNpm } from "../dist/adapters/npm-archive.js";

const url = "https://registry.npmjs.org/example/-/example-1.0.0.tgz";
const payload = Buffer.from("locked bytes");
const integrity = `sha512-${createHash("sha512").update(payload).digest("base64")}`;

test("stalled fetch retries the same locked URL once through bounded HTTPS and still checks SRI", async (t) => {
  const fetch = globalThis.fetch;
  let calls = 0,
    status = 200,
    body = payload,
    declared = String(payload.length);
  t.after(() => {
    globalThis.fetch = fetch;
  });
  t.mock.method(https, "get", (actual, options, callback) => {
    calls++;
    assert.equal(actual, url);
    assert(options.signal instanceof AbortSignal);
    assert.equal(options.headers.accept, "application/octet-stream");
    const req = new EventEmitter(),
      res = Readable.from([body]);
    res.statusCode = status;
    res.headers = { "content-length": declared };
    queueMicrotask(() => callback(res));
    return req;
  });
  globalThis.fetch = async () => {
    throw new DOMException("stalled", "TimeoutError");
  };
  assert.deepEqual(
    await downloadNpm(url, integrity, new AbortController().signal),
    payload,
  );
  assert.equal(calls, 1);
  body = Buffer.from("drift");
  declared = String(body.length);
  await assert.rejects(
    downloadNpm(url, integrity, new AbortController().signal),
    /integrity mismatch/,
  );
  status = 302;
  await assert.rejects(
    downloadNpm(url, integrity, new AbortController().signal),
    /HTTP 302/,
  );
  status = 200;
  declared = String(128 * 1024 * 1024 + 1);
  await assert.rejects(
    downloadNpm(url, integrity, new AbortController().signal),
    /size limit/,
  );
  const before = calls;
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    downloadNpm(url, integrity, cancelled.signal),
    /Cancelled/,
  );
  assert.equal(calls, before);
});

test("HTTP errors, bad bytes, redirects and size violations never invoke the timeout retry", async (t) => {
  const fetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetch;
  });
  let calls = 0;
  t.mock.method(https, "get", () => {
    calls++;
    throw Error("Unexpected retry");
  });
  for (const response of [
    new Response("no", { status: 404 }),
    new Response("different bytes"),
    new Response("", {
      headers: { "content-length": String(128 * 1024 * 1024 + 1) },
    }),
  ]) {
    globalThis.fetch = async () => response;
    await assert.rejects(
      downloadNpm(url, integrity, new AbortController().signal),
    );
  }
  globalThis.fetch = async () => {
    throw new TypeError("redirect rejected");
  };
  await assert.rejects(
    downloadNpm(url, integrity, new AbortController().signal),
    /redirect rejected/,
  );
  assert.equal(calls, 0);
});

test("HTTPS retry enforces the streamed byte cap without a length header and propagates cancellation", async (t) => {
  const fetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetch;
  });
  globalThis.fetch = async () => {
    throw new DOMException("stalled", "TimeoutError");
  };
  let mode = "large",
    requests = 0;
  const controller = new AbortController();
  t.mock.method(https, "get", (_url, options, callback) => {
    requests++;
    const req = new EventEmitter();
    const chunk = Buffer.alloc(65536);
    const response =
      mode === "large"
        ? Readable.from(
            (function* () {
              for (let i = 0; i < 2050; i++) yield chunk;
            })(),
          )
        : new Readable({ read() {} });
    response.statusCode = 200;
    response.headers = {};
    options.signal.addEventListener(
      "abort",
      () => {
        req.emit("error", new DOMException("Cancelled", "AbortError"));
        response.destroy();
      },
      { once: true },
    );
    queueMicrotask(() => {
      callback(response);
      if (mode === "abort") controller.abort();
    });
    return req;
  });
  await assert.rejects(
    downloadNpm(url, integrity, new AbortController().signal),
    /size limit/,
  );
  mode = "abort";
  const before = requests;
  await assert.rejects(
    downloadNpm(url, integrity, controller.signal),
    (error) => error.name === "AbortError",
  );
  assert.equal(requests, before + 1);
});
