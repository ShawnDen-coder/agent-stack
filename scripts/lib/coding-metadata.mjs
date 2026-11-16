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
