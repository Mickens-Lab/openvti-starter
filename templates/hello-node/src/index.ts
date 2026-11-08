// Hello, VTA: sign in with your app identity, ask who you are, store one value and list what is stored.
//   npm run up                         # once, at the repo root
//   npm start -w <this package>        # or: npx tsx src/index.ts
import { VtaClient } from "@starter/vta-client";
import { loadEnv } from "./env.js";

const env = loadEnv();
if (!env.VTA_CREDENTIAL) throw new Error("no VTA_CREDENTIAL: run `npm run up` at the repo root first (it writes .env).");

const vta = await VtaClient.fromCredential(env.VTA_CREDENTIAL, env.VTA_URL);
await vta.authenticate();
console.log("I am", vta.me.did);
console.log("whoami:", JSON.stringify(await vta.whoami()));

// Any Trust Task is vta.call(type, payload). `npm run vta:call` at the repo root lists them all.
const contextId = env.VTA_CONTEXT ?? "my-app";
const type = "https://trusttasks.org/spec/vta/memory/put/0.1";
await vta.call(type, { contextId, key: "hello", value: `hello from ${new Date().toISOString()}` });
console.log("memory/list:", JSON.stringify(await vta.call("https://trusttasks.org/spec/vta/memory/list/0.1", { contextId })));
