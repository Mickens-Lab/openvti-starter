// A Node REPL with your identities already loaded and top-level await:
//   vta    VtaClient, authenticated as your app identity      await vta.whoami()
//   vtc    VtcClient for the community (if one answers)       await vtc.joinStatus()
//   call   shorthand: await call("vta/memory/list/0.1", { contextId: "my-app" })
//   TT     the Trust Task base URI;  tasks()  the list of task names (search with tasks("memory"))
// Needs the stack up (`npm run up`). History is kept in .vta/repl-history. TRACE=1 logs every call (docs/CHEATSHEET.md).
import "./lib/cli.js";
import { mkdirSync } from "node:fs";
import repl from "node:repl";
import { decodeCredential, identityFromCredential, TT, VtaClient } from "@starter/vta-client";
import { VtcClient } from "@starter/vtc-client";
import { devBanner } from "./banner.js";
import { die, env, mode, reachable, vtcUrl } from "./env.js";
import { searchTasks, slugOf, taskType } from "./lib/tasks.js";

devBanner();
const cred = env("VTA_CREDENTIAL");
if (!cred) die("no VTA_CREDENTIAL in .env. Run `npm run up` first.");
const vta = await reachable("VTA", env("VTA_URL") ?? "the VTA", () => VtaClient.fromCredential(cred, env("VTA_URL"), undefined, { resolveDid: mode() !== "farm" }));
await vta.authenticate();

let vtc: VtcClient | undefined;
try {
  const url = vtcUrl();
  vtc = await VtcClient.connect(url, identityFromCredential(decodeCredential(cred)), undefined, env("VTC_DID"));
} catch {
  /* no community in this stack: vta still works */
}

let known: string[] | undefined;
const tasks = async (words?: string) => {
  known ??= await vta.discover();
  return (words ? searchTasks(known, words) : known).map(slugOf);
};
const call = (slug: string, payload: Record<string, unknown> = {}) => vta.call(taskType(slug), payload);

console.log(`connected as ${vta.me.did} (mode ${mode()}${vtc ? "" : "; no VTC reachable, vtc is undefined"}). Try: await vta.whoami()  |  await call("vta/memory/list/0.1", { contextId: "${env("VTA_CONTEXT") ?? "my-app"}" })  |  await tasks("memory")`);
const r = repl.start({ prompt: "vta> ", useGlobal: false });
Object.assign(r.context, { vta, vtc, call, tasks, TT });
mkdirSync(".vta", { recursive: true });
r.setupHistory(".vta/repl-history", () => {});
