// Data rooms from the command line, as the app identity that is a member of your community (the VTC in .env).
//   npm run rooms:list                         # rooms offered to you, and rooms you hold
//   npm run rooms:accept -- <room DID>         # accept an offer (open rooms; sealed rooms are explained, not attempted)
//   npm run rooms:info   -- <room DID>         # tier, epoch, limits (read-only)
//   npm run rooms:post   -- <room DID> "text"  [--markdown] [--name "Display Name"]
//   npm run rooms:read   -- <room DID> [--follow]
// <room DID> may be left out when ROOM_ID=<room DID> is in .env. Walkthrough and what is verified: docs/ROOMS.md.
import "./lib/cli.js";
import { TrustTaskError, VtaClient } from "@buildathon/vta-client";
import { VtcClient } from "@buildathon/vtc-client";
import { HostClient, RoomSession, VtaKeyOracle, joinFromOffer, offerFallbackPresenter, vtcTransport, type RoomOfferLike } from "@buildathon/rooms-client";
import { die, env, mode, reachable, refusal, vtcUrl } from "./env.js";
import { memberIdentity } from "./lib/member.js";
import { flag, option, positionals } from "./lib/rooms-args.js";

const [cmd, ...rest] = process.argv.slice(2);
const USAGE = "usage: npm run rooms:<list|info|accept|post|read> [-- <room DID> [text]]   (docs/ROOMS.md)";
if (!cmd || !["list", "info", "accept", "post", "read"].includes(cmd)) die(USAGE);

const cred = env("VTA_CREDENTIAL");
if (!cred) die("VTA_CREDENTIAL not set. Run `npm run up` (local) or `npm run farm:setup` + `npm run vta:provision` (farm) first.");
const url = vtcUrl();
// The member is the app did:key, or, with ROOM_PERSONA=<did> in .env (npm run rooms:persona), a persona DID the VTA holds and signs for.
const vta = await VtaClient.fromCredential(cred, env("VTA_URL") ?? die("VTA_URL not set"), undefined, { resolveDid: mode() !== "farm" });
try { await vta.authenticate(); } catch { /* rooms/keys/* are signed documents; a session is not required for them */ }
const persona = env("ROOM_PERSONA");
const me = persona ? vta.personaIdentity(persona) : memberIdentity(cred);
const keys = new VtaKeyOracle(vta);
const vtc = await reachable("VTC", url, () => VtcClient.connect(url, me, undefined, env("VTC_DID")));
const pos = positionals(rest);
const roomId = pos[0] ?? env("ROOM_ID");

const need = (): string => roomId ?? die(`name the room: npm run rooms:${cmd} -- <room DID>   (or ROOM_ID=<room DID> in .env). \`npm run rooms:list\` shows the ones offered to you.`);

/** Run a Trust Task call; a refusal becomes one line, not a stack trace. */
async function call<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TrustTaskError) die(`${what}: the host refused (HTTP ${e.status}): ${refusal(e.body)}${hint(refusal(e.body))}`);
    throw e;
  }
}

function hint(text: string): string {
  if (/notAMember/.test(text)) return "\nhint: this identity is not an active member of the community yet. `npm run vtc:join`, then an admin approves it (docs/ROOMS.md, step 1).";
  if (/no open or recently accepted offer/.test(text)) return "\nhint: no offer to this room is addressed to you. Ask the room's owner to add this DID, wait a minute, then `npm run rooms:list` (docs/ROOMS.md, step 2).";
  if (/holds no AuthorityCredential/.test(text)) {
    return "\nhint: your VTA refused to present for this room because the room admitted your app did:key, which the VTA does not hold as a persona. Open rooms work anyway (the offer's own credentials are used). Sealed rooms need a persona DID the VTA holds (docs/ROOMS.md, \"Attributed and private rooms\").";
  }
  return "";
}

const offersOf = async (): Promise<RoomOfferLike[]> => ((await call("rooms/offers/list", () => vtc.roomOffers())) as { items?: RoomOfferLike[] }).items ?? [];
let cache: Promise<RoomOfferLike[]> | undefined;
const lookup = async (id: string) => (await (cache ??= offersOf())).find((o) => o.roomId === id);

/** HostClient whose presenter asks the member's VTA, and for an open room falls back to the offer's own credentials. */
const hostClient = (): HostClient => new HostClient(vtcTransport(vtc), offerFallbackPresenter((r, a) => keys.present(r, a), lookup));

if (cmd === "list") {
  const offers = await offersOf();
  const held = (((await call("rooms/memberships/list", () => vtc.roomMemberships())) as { items?: any[] }).items) ?? [];
  console.log(`community ${vtc.vtcDid}\nidentity  ${me.did}${persona ? "  (a persona the VTA holds)" : "  (the app did:key)"}\n`);
  if (!offers.length) console.log("no rooms offered to this identity. Ask a room owner to add its DID (docs/ROOMS.md, step 2).");
  for (const o of offers as any[]) console.log(`offer   ${String(o.state).padEnd(9)} ${String(o.visibility).padEnd(10)} ${o.label ?? ""}\n        ${o.roomId}  actions=${(o.actions ?? []).join(",")}${o.validUntil ? `  until ${o.validUntil}` : ""}`);
  for (const m of held) console.log(`holding ${String(m.state).padEnd(9)} ${String(m.visibility).padEnd(10)} ${m.label ?? ""}\n        ${m.roomId}`);
  process.exit(0);
}

if (cmd === "accept") {
  const id = need();
  const offer = await lookup(id);
  if (!offer) die(`no offer to ${id} is addressed to ${me.did}.${hint("no open or recently accepted offer")}`);
  if (offer.visibility !== "open" && !persona) {
    die(`${id} is ${offer.visibility}, a sealed room. Joining one needs the member's VTA to mint an MLS KeyPackage, and it refuses when the member is the app did:key (not a persona it holds). Make a persona and have the room offered to it: docs/ROOMS.md, "Attributed and private rooms". Not attempted.`);
  }
  const r = await call("join", () => joinFromOffer(vtc, offer.visibility === "open" ? undefined : keys, offer));
  console.log(`joined (${r.steps.join(" > ")}), epoch ${r.epoch}\nnext: npm run rooms:post -- ${id} "hello"`);
  process.exit(0);
}

const host = hostClient();

if (cmd === "info") {
  const info = await call("rooms/info", () => host.info(need()));
  console.log(JSON.stringify(info, null, 1));
  process.exit(0);
}

// post / read: a session (history, then the feed). Name for a profile: --name, else the directory card's display name.
const id = need();
const cardName = async () => {
  try { return ((await vtc.myCard()) as any)?.card?.values?.displayName as string | undefined; } catch { return undefined; }
};
const name = option(rest, "name") ?? (cmd === "post" ? await cardName() : undefined);
const room = await call("open the room", () => RoomSession.open({ roomId: id, host, keys, self: me.did, ...(name ? { profile: { displayName: name } } : {}), start: cmd === "read" && flag(rest, "follow") }));
const label = (did?: string) => (did ? room.profiles.resolveSync(did).label : "?");
const line = (i: any) => `[${i.version}] ${label(i.author)}: ${i.envelope?.text ?? i.envelope?.title ?? i.envelope?.name ?? "(" + i.kind + ")"}`;

if (cmd === "post") {
  const text = pos.slice(1).join(" ");
  if (!text) die('give the message: npm run rooms:post -- <room DID> "text"');
  const item = await call("post", () => room.post(text, flag(rest, "markdown") ? "text/markdown" : "text/plain"));
  console.log(`posted ${item.id} at version ${item.version}`);
  await room.feed.sync();
  console.log("read back:", line(room.items().find((i) => i.id === item.id) ?? item));
  room.close();
  process.exit(0);
}

for (const i of room.items()) console.log(line(i));
if (!flag(rest, "follow")) { room.close(); process.exit(0); }
console.log("-- following (Ctrl-C to stop) --");
room.onChange((c) => { for (const i of [...c.added, ...c.updated]) console.log(line(i)); });
