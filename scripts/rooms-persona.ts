// A persona DID for data rooms. A sealed room's keys live in your VTA, and the VTA only acts for a DID it holds (a "persona"), never for
// the app did:key. So for attributed and private rooms the community member (and the room's invitee) must be a DID the VTA holds.
//   npm run rooms:persona -- setup [--name "Display Name"]          # create (if none yet) then join: the whole persona setup in one command
//   npm run rooms:persona -- create [--server <id>] [--label "..."]   # mint a did:webvh in your app's context (needs the admin key)
//   npm run rooms:persona -- use <did>                                # adopt a DID the VTA already holds
//   npm run rooms:persona -- join [--name "Display Name"]             # apply to the community as the persona (the VTA signs)
//   npm run rooms:persona -- status
// The persona is saved as ROOM_PERSONA in .env; npm run rooms:* then act as it. Walkthrough: docs/ROOMS.md.
import "./lib/cli.js";
import { TrustTaskError, VtaClient } from "@buildathon/vta-client";
import { VtcClient, pickCriterion } from "@buildathon/vtc-client";
import { die, env, loadAdmin, mode, reachable, refusal, updateEnv, vtcUrl } from "./env.js";
import { flag, option, positionals } from "./lib/rooms-args.js";

const [cmd0, ...rest] = process.argv.slice(2);
if (!cmd0 || !["setup", "create", "use", "join", "status"].includes(cmd0)) die("usage: npm run rooms:persona -- <setup|create|use <did>|join|status>   (docs/ROOMS.md)");
let cmd = cmd0 === "setup" ? (process.env.ROOM_PERSONA || env("ROOM_PERSONA") ? "join" : "create") : cmd0;
const vtaUrl = env("VTA_URL") ?? die("VTA_URL not set");
const context = env("VTA_CONTEXT") ?? "my-app";
const known = mode() === "farm" ? env("VTA_DID") : undefined;
const asApp = async () => {
  const cred = env("VTA_CREDENTIAL") ?? die("VTA_CREDENTIAL not set. Run `npm run vta:provision` first.");
  const vta = await VtaClient.fromCredential(cred, vtaUrl, undefined, { resolveDid: mode() !== "farm" });
  await reachable("VTA", vtaUrl, () => vta.authenticate());
  return vta;
};
const fail = (what: string, e: unknown): never => {
  if (e instanceof TrustTaskError) return die(`${what}: refused (HTTP ${e.status}): ${refusal(e.body)}`);
  throw e;
};

if (cmd === "create") {
  if (env("ROOM_PERSONA") && !flag(rest, "force")) die(`ROOM_PERSONA is already ${env("ROOM_PERSONA")}. Pass --force to mint another.`);
  // The application role does not carry KeyMint, so the admin key (the one you gave the portal, .vta/admin.json) mints the DID inside the app's context.
  const admin = await reachable("VTA", vtaUrl, () => VtaClient.connect(vtaUrl, loadAdmin(), undefined, known));
  await reachable("VTA", vtaUrl, () => admin.authenticate());
  try {
    const servers = ((await admin.call("https://trusttasks.org/spec/vta/webvh/servers/list/1.0", {})) as { servers?: { id: string }[] }).servers ?? [];
    const serverId = option(rest, "server") ?? servers[0]?.id;
    if (!serverId) die("this VTA has no DID hosting server registered (vta/webvh/servers/list is empty), so it cannot publish a did:webvh. Pass --server <id> if you know one.");
    const r = (await admin.call("https://trusttasks.org/spec/vta/webvh/dids/create/1.2", { contextId: context, serverId, label: option(rest, "label") ?? "rooms persona", portable: true })) as { did?: string };
    if (!r.did) die(`the VTA created a DID but returned none: ${JSON.stringify(r).slice(0, 300)}`);
    updateEnv({ ROOM_PERSONA: r.did });
    process.env.ROOM_PERSONA = r.did;
    console.log(`persona ${r.did}\nsaved as ROOM_PERSONA.`);
  } catch (e) { fail("create the persona DID", e); }
  if (cmd0 !== "setup") { console.log("Next: npm run rooms:persona -- join"); process.exit(0); }
  cmd = "join";
}

if (cmd === "use") {
  const did = positionals(rest)[0] ?? die("npm run rooms:persona -- use <did>");
  const vta = await asApp();
  try {
    const held = ((await vta.call("https://trusttasks.org/spec/vta/webvh/dids/list/1.0", { contextId: context })) as { dids?: { did: string }[] }).dids ?? [];
    if (!held.some((d) => d.did === did)) die(`${did} is not one of the DIDs your VTA holds in context "${context}" (${held.map((d) => d.did).join(", ") || "none"}).`);
  } catch (e) { fail("list the VTA's DIDs", e); }
  updateEnv({ ROOM_PERSONA: did });
  console.log(`ROOM_PERSONA=${did}`);
  process.exit(0);
}

const persona = process.env.ROOM_PERSONA ?? env("ROOM_PERSONA") ?? die("no persona yet: npm run rooms:persona -- setup");
const vta = await asApp();
const me = vta.personaIdentity(persona);
const url = vtcUrl();
const vtc = await reachable("VTC", url, () => VtcClient.connect(url, me, undefined, env("VTC_DID")));
console.log(`community ${vtc.vtcDid}\npersona   ${persona}`);

try {
  if (cmd === "join") {
    let requestId = env("ROOM_PERSONA_REQUEST_ID");
    if (requestId) {
      console.log(`reusing request ${requestId} (delete ROOM_PERSONA_REQUEST_ID from .env to resubmit)`);
    } else {
      const m = await vtc.manifest();
      const criterion = pickCriterion(m)?.requirementsDigest;
      const name = option(rest, "name");
      const wanted = m.requestedAttributes ?? [];
      const attributes = name && wanted.some((a) => a.type === "name.display") ? [{ type: "name.display", value: name }] : [];
      const missing = wanted.filter((a) => a.required !== false && !attributes.some((x) => x.type === a.type));
      if (missing.length) die(`the community requires attributes: ${missing.map((a) => a.type).join(", ")}. Pass --name "..." for name.display.`);
      const r = await vtc.submitJoin({ criterion, attributes });
      requestId = r.requestId;
      updateEnv({ ROOM_PERSONA_REQUEST_ID: requestId });
      console.log("submitted; verdict:", JSON.stringify(r.verdict));
    }
    const s = await vtc.joinStatus(requestId);
    console.log("status:", JSON.stringify(s));
    if (s.status === "pending") console.log(`pending: an administrator must approve ${persona} in the community's admin console.`);
    if (s.status === "approved") console.log(`approved. Give the room owner this DID to offer a sealed room to: ${persona}\nthen: npm run rooms:status`);
  } else {
    const id = env("ROOM_PERSONA_REQUEST_ID");
    if (id) console.log("join:", JSON.stringify(await vtc.joinStatus(id)));
    try { console.log("card:", JSON.stringify(((await vtc.myCard()) as any).card?.values ?? {})); console.log("member: yes"); } catch (e) { console.log(`member: no (${e instanceof TrustTaskError ? refusal(e.body) : String(e)})`); }
  }
} catch (e) { fail("the community", e); }
