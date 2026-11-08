// MODE=local or MODE=tunnel, after `docker compose --profile vtc up -d vtc`: grant the VTC's setup
// did:key at the VTA (one-time hand-off), which unblocks the entrypoint's phase 2.
// The grant is an ordinary `acl/grant` Trust Task whose entry carries the hand-off
// marker (`ext["org.openvtc.handoff"]`), sent as the buildathon admin. (The VTA CLI
// cannot be used here: the running daemon holds the store lock.)
import "./lib/cli.js";
import { spawnSync } from "node:child_process";
import { VtaClient } from "@starter/vta-client";
import { LOCAL_VTA_URL, die, env, loadAdmin, mode, reachable } from "./env.js";
import { composeEnvNow } from "./lib/compose.js";
import { profileArgs } from "./lib/tunnel.js";

const m = mode();
if (m === "farm") die("vtc:up is for MODE=local or MODE=tunnel. In farm mode the portal provisions the VTC.");
const dc = (args: string[]) => spawnSync("docker", ["compose", ...profileArgs(m, true), ...args], { encoding: "utf8", env: composeEnvNow() });

const up = dc(["up", "-d", "vtc"]);
if (up.status !== 0) {
  die(`could not start the vtc service:\n${up.stderr}\nBuild the image (docker/vtc.Dockerfile) or set VTC_IMAGE. See docs/VTC.md.`);
}
let did = "";
for (let i = 0; i < 60 && !did; i++) {
  const r = dc(["exec", "-T", "vtc", "cat", "/var/lib/vtc/setup-key.json"]);
  did = r.stdout.match(/(did:key:z[A-Za-z0-9]+)/)?.[1] ?? "";
  if (!did) spawnSync("sleep", ["2"]);
}
if (!did) die("the VTC did not write its setup key in 2 minutes. See `docker compose --profile vtc logs vtc`.");
console.log(`VTC setup DID: ${did}`);

const baseUrl = (process.env.VTA_URL ?? (m === "tunnel" ? env("VTA_URL") : undefined) ?? LOCAL_VTA_URL).replace(/\/+$/, "");
const admin = await reachable("VTA", baseUrl, () => VtaClient.connect(baseUrl, loadAdmin(), undefined));
await reachable("VTA", baseUrl, () => admin.authenticate());
const ctx = process.env.VTC_CONTEXT ?? "vtc";
await admin.createContext(ctx, "VTC");
console.log((await admin.grantHandoff(did, ctx)) ? `granted one-time hand-off admin on "${ctx}" to ${did}` : `setup DID already granted`);
console.log("the VTC finishes setup within ~10s. Check: npm run vtc:hello");
