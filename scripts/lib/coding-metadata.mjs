import { lstat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { uvUrl } from "../../dist/adapters/releases.js";

// CI-only metadata request authentication. The package consumers determine the
// canonical first page; the numeric repository path is its validated pagination.
export function codingMetadataPreload(manifest) {
  const uvPaths = [new URL(uvUrl).pathname, "/repositories/699532645/releases"];
  return `const original=globalThis.fetch;globalThis.fetch=async(u,o)=>{
 if(String(u)===${JSON.stringify(manifest.source)})return new Response(${JSON.stringify(JSON.stringify(manifest))});
 const url=new URL(String(u));const token=process.env.AGENT_STACK_TEST_GITHUB_TOKEN;
 if(token&&url.origin==='https://api.github.com'&&${JSON.stringify(uvPaths)}.includes(url.pathname)){
  const headers=new Headers(o?.headers);headers.set('Authorization','Bearer '+token);return original(u,{...o,headers});
 }
 return original(u,o);
};`;
}

// Only the metadata lock operation may retry, and only after this exact CLI failure.
export async function retryCodingMetadataLock({
  lockPath,
  call,
  wait = () => delay(1000),
}) {
  try {
    return await call("lock-1");
  } catch (error) {
    let report;
    try {
      report = JSON.parse(error?.stdout);
    } catch {
      throw error;
    }
    if (
      error?.code !== 1 ||
      error?.signal != null ||
      error?.killed ||
      !report ||
      typeof report !== "object" ||
      Array.isArray(report) ||
      Object.keys(report).length !== 1 ||
      report.error !== "Release metadata request timed out"
    )
      throw error;
    await wait();
    try {
      await lstat(lockPath);
    } catch (checkError) {
      if (checkError?.code === "ENOENT") return await call("lock-2");
      throw checkError;
    }
    throw error;
  }
}
