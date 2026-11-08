// Call any Trust Task on your VTA as your app identity and print the reply or the refusal.
//   npm run vta:call                                  # list the tasks this VTA serves
//   npm run vta:call -- --search memory               # only the ones whose name contains a word
//   npm run vta:call -- --schema vta/memory/put/0.1   # the request and response fields (offline, from the shipped bindings)
//   npm run vta:call -- vta/contexts/list/1.0         # a slug under https://trusttasks.org/spec/ (or a full URI)
//   npm run vta:call -- vta/memory/put/0.1 '{"key":"k","value":"v"}'
import "./lib/cli.js";
import { TrustTaskError, VtaClient } from "@starter/vta-client";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { die, env, mode, reachable } from "./env.js";
import { parseJsonArg } from "./lib/cli.js";
import { extractPayloadInterfaces, parseCallArgs, searchTasks, slugOf, taskType } from "./lib/tasks.js";

const args = parseCallArgs(process.argv.slice(2));
if (args.error) die(args.error);

if (args.schema) {
  // Offline: the generated bindings that ship with @openvtc/trust-tasks hold every field and its description.
  const slug = slugOf(taskType(args.schema));
  if (slug.includes("..") || slug.startsWith("/")) die("--schema takes a task name such as vta/memory/put/0.1.");
  const pkgDir = resolve("node_modules/@openvtc/trust-tasks");
  const file = join(pkgDir, "src", slug, "payload.ts");
  const text = existsSync(file) ? extractPayloadInterfaces(readFileSync(file, "utf8")) : undefined;
  if (!text) die(`no bundled schema for "${slug}" (it may be newer than the installed bindings). The spec is at ${taskType(slug)} (needs a network).`);
  console.log(`// ${slug}: request payload, then response payload\n${text}`);
  process.exit(0);
}

const cred = env("VTA_CREDENTIAL");
if (!cred) die("no VTA_CREDENTIAL in .env. Run `npm run up` first.");
const vta = await reachable("VTA", env("VTA_URL") ?? "the VTA", () => VtaClient.fromCredential(cred, env("VTA_URL"), undefined, { resolveDid: mode() !== "farm" }));
await vta.authenticate();
const { slug, json } = args;
if (!slug) {
  const all = await vta.discover();
  const tasks = args.search ? searchTasks(all, args.search) : all;
  console.log(`${tasks.length}${args.search ? ` of ${all.length}` : ""} Trust Tasks ${args.search ? `matching "${args.search}"` : "served"} (pass one as the first argument; --schema <task> shows its fields):`);
  for (const t of tasks) console.log("  " + slugOf(t));
} else {
  const type = taskType(slug);
  let payload: Record<string, unknown> = {};
  if (json) {
    const parsed = parseJsonArg(json, "the payload");
    if (!parsed.ok) die(parsed.message);
    payload = parsed.value as Record<string, unknown>;
  }
  try {
    console.log(JSON.stringify(await vta.call(type, payload), null, 2));
  } catch (e) {
    if (!(e instanceof TrustTaskError)) throw e;
    const p = (e.body as any)?.payload;
    console.log(`refused (HTTP ${e.status}): ${p?.code ?? "?"}: ${p?.message ?? JSON.stringify(e.body)}`);
    process.exitCode = 1;
  }
}
