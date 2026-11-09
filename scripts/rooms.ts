// Data rooms from the command line, as the app identity that is a member of your community (the VTC in .env).
//   npm run rooms:status                       # where you stand, and the one command to run next
//   npm run rooms:list                         # rooms offered to you, and rooms you hold
//   npm run rooms:accept -- <room DID>         # accept an offer (open: the accept; sealed: key-package, accept, welcome, as the persona)
//   npm run rooms:info   -- <room DID>         # tier, epoch, limits (read-only)
//   npm run rooms:post   -- <room DID> "text"  [--markdown] [--name "Display Name"] [--avatar <png|jpg|gif|webp, at most 64 KiB>]
//   npm run rooms:read   -- <room DID> [--follow]
//   npm run rooms:note   -- <room DID> "Title" "body" [--id <note id>]    # save a note (--id saves a new version of that note)
//   npm run rooms:upload -- <room DID> <file path> [--type text/plain]    # add a file
//   npm run rooms:search -- <room DID> "words" [--names]                  # full text, or file names with --names
//   npm run rooms:download -- <room DID> <item id> [out path]             # a file's bytes (checked against its SHA-256)
// Add --app to any command to act as the app did:key although ROOM_PERSONA is set (open rooms offered to it).
// <room DID> may be left out when ROOM_ID=<room DID> is in .env. Walkthrough and what is verified: docs/ROOMS.md.
import "./lib/cli.js";
import { TrustTaskError, VtaClient } from "@starter/vta-client";
import { VtcClient } from "@starter/vtc-client";
import { HostClient, RoomSession, VtaKeyOracle, joinFromOffer, offerFallbackPresenter, vtcTransport, type RoomOfferLike } from "@starter/rooms-client";
import { ADMIN_FILE, die, env, loadAdmin, mode, reachable, refusal, vtcUrl } from "./env.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { memberIdentity } from "./lib/member.js";
import { flag, option, positionals } from "./lib/rooms-args.js";
import { communityNext, statusLines } from "./lib/rooms-status.js";

const [cmd, ...rest] = process.argv.slice(2);
const USAGE = "usage: npm run rooms:<status|list|info|accept|post|read|note|upload|search|download> [-- <room DID> [args]]   (docs/ROOMS.md)";
if (!cmd || !["status", "list", "info", "accept", "post", "read", "note", "upload", "search", "download"].includes(cmd)) die(USAGE);

const cred = env("VTA_CREDENTIAL");
if (!cred) die("VTA_CREDENTIAL not set. Run `npm run up` (local) or `npm run farm:setup` + `npm run vta:provision` (farm) first.");
const url = vtcUrl();
// The member is the app did:key, or, with ROOM_PERSONA=<did> in .env (npm run rooms:persona), a persona DID the VTA holds and signs for.
const vta = await VtaClient.fromCredential(cred, env("VTA_URL") ?? die("VTA_URL not set"), undefined, { resolveDid: mode() !== "farm" });
try { await vta.authenticate(); } catch { /* rooms/keys/* are signed documents; a session is not required for them */ }
const persona = flag(rest, "app") ? undefined : env("ROOM_PERSONA"); // --app: act as the app did:key even when ROOM_PERSONA is set
const me = persona ? vta.personaIdentity(persona) : memberIdentity(cred);
const keys = new VtaKeyOracle(vta);
const vtc = await reachable("VTC", url, () => VtcClient.connect(url, me, undefined, env("VTC_DID")));
// Room calls (rooms/info, records, blobs) go through rooms/keys/act: the VTA completes the request as the persona (issuer, presentation,
// proof), so the persona is the one author the room sees. Membership calls (offers, accept) are the persona's own via keys/sign-document.
const appMe = persona ? vta.actIdentity(persona) : memberIdentity(cred);
const appVtc = persona ? await reachable("VTC", url, () => VtcClient.connect(url, appMe, undefined, env("VTC_DID"))) : vtc;
const pos = positionals(rest);
const roomId = pos[0] ?? env("ROOM_ID");

const need = (): string => roomId ?? die(`name the room: npm run rooms:${cmd} -- <room DID>   (or ROOM_ID=<room DID> in .env). \`npm run rooms:list\` shows the ones offered to you.`);

/** Run a Trust Task call; a refusal becomes one line, not a stack trace. */
async function call<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TrustTaskError) die(`${what}: the host refused (HTTP ${e.status}): ${refusal(e.body)}${hint(refusal(e.body))}`);
    if (e instanceof Error) die(`${what}: ${e.message}`);
    throw e;
  }
}

function hint(text: string): string {
  if (/notAMember/.test(text)) return "\nhint: this identity is not an active member of the community yet. `npm run vtc:join`, then an admin approves it (docs/ROOMS.md, step 1).";
  if (/no open or recently accepted offer/.test(text)) return "\nhint: no offer to this room is addressed to you. Ask the room's owner to add this DID, wait a minute, then `npm run rooms:list` (docs/ROOMS.md, step 2).";
  if (/holds no AuthorityCredential/.test(text)) {
    return persona
      ? "\nhint: your VTA does not hold this room's credentials. `npm run rooms:accept -- <room DID>` stores them in its vault and joins (docs/ROOMS.md, \"Attributed and private rooms\")."
      : "\nhint: your VTA refused to present for this room because the room admitted your app did:key, which the VTA does not hold as a persona. Open rooms work anyway (the offer's own credentials are used). Sealed rooms need a persona DID the VTA holds: `npm run rooms:persona -- setup` (docs/ROOMS.md, \"Attributed and private rooms\").";
  }
  if (/already been used/.test(text)) return "\nhint: this offer was already used to join. `npm run rooms:status` shows whether the VTA holds the room.";
  return "";
}

const offersOf = async (): Promise<RoomOfferLike[]> => ((await call("rooms/offers/list", () => vtc.roomOffers())) as { items?: RoomOfferLike[] }).items ?? [];
let cache: Promise<RoomOfferLike[]> | undefined;
const lookup = async (id: string) => (await (cache ??= offersOf())).find((o) => o.roomId === id);

/** With act the VTA inserts the presentation itself; HostClient still wants one to attach, and actIdentity drops it before signing. */
const actPresenter = async () => ({ presentation: { membership: "", authority: [] as string[] } });

/** HostClient whose presenter asks the member's VTA, and for an open room falls back to the offer's own credentials. */
const hostClient = (): HostClient => new HostClient(vtcTransport(appVtc), persona ? actPresenter : offerFallbackPresenter((r, a) => keys.present(r, a), lookup));

const heldRooms = async (): Promise<Set<string>> => {
  try { return new Set((await keys.held()).filter((h) => h.member === me.did).map((h) => h.roomId)); } catch { return new Set(); }
};

if (cmd === "status") {
  const offers = (await offersOf()) as (RoomOfferLike & { label?: string })[];
  let member = true;
  try { await vtc.myCard(); } catch (e) { if (e instanceof TrustTaskError) member = false; else throw e; }
  console.log(`community ${vtc.vtcDid}\nidentity  ${me.did}  (${persona ? "a persona the VTA holds" : "the app did:key"})\nmember    ${member ? "yes" : "no"}`);
  const first = communityNext({ persona: !!persona, member });
  if (first) { console.log(`\nnext: ${first}`); process.exit(0); }
  const lines = statusLines({ persona: !!persona, member, offers, held: await heldRooms() });
  if (!lines.length) console.log("\nno rooms offered to this identity. Ask a room owner to add this DID (docs/ROOMS.md, step 2).");
  for (const l of lines) console.log(`\n${l.label}  [${l.visibility}]  ${l.status}\n  ${l.roomId}\n  next: ${l.next}`);
  process.exit(0);
}

if (cmd === "list") {
  const offers = await offersOf();
  const held = (((await call("rooms/memberships/list", () => vtc.roomMemberships())) as { items?: any[] }).items) ?? [];
  console.log(`community ${vtc.vtcDid}\nidentity  ${me.did}${persona ? "  (a persona the VTA holds)" : "  (the app did:key)"}\n`);
  if (!offers.length) console.log("no rooms offered to this identity. Ask a room owner to add its DID (docs/ROOMS.md, step 2).");
  for (const o of offers as any[]) console.log(`offer   ${String(o.state).padEnd(9)} ${String(o.visibility).padEnd(10)} ${o.label ?? ""}\n        ${o.roomId}  actions=${(o.actions ?? []).join(",")}${o.validUntil ? `  until ${o.validUntil}` : ""}`);
  for (const m of held) console.log(`holding ${String(m.state).padEnd(9)} ${String(m.visibility).padEnd(10)} ${m.label ?? ""}\n        ${m.roomId}`);
  process.exit(0);
}

/**
 * A sealed room's presentation is minted by the VTA from the room's credentials, which it must hold in its vault. In production the VTC
 * delivers them over messaging (off here), so we hand it the ones in the offer: vault/credentials/receive. The application role has no
 * VaultWrite, so this falls back to the admin key (.vta/admin.json) and says so. It writes only to your own VTA.
 */
async function storeRoomCredentials(offer: RoomOfferLike) {
  const T = "https://trusttasks.org/spec/vault/credentials/receive/0.1";
  const context = env("VTA_CONTEXT") ?? "my-app";
  let writer: VtaClient = vta;
  for (const k of ["authority", "membership"] as const) {
    const raw = offer.credentials?.[k];
    if (!raw) die(`the offer carries no ${k} credential to store`);
    const body = { credential: JSON.parse(raw), contextId: context };
    try {
      await writer.call(T, body);
    } catch (e) {
      const text = e instanceof TrustTaskError ? refusal(e.body) : "";
      if (/already|exists|conflict/i.test(text)) continue;
      if (e instanceof TrustTaskError && /VaultWrite/.test(text) && writer === vta) {
        if (!existsSync(ADMIN_FILE)) die(`your VTA needs the offer's credentials in its vault, and the app identity may not write there (no VaultWrite). ${ADMIN_FILE} (the admin key) is missing, so this cannot be done from here.`);
        console.log("note: the app role cannot write to the vault, using the admin key for this one step (your own VTA).");
        writer = await VtaClient.connect(env("VTA_URL")!, loadAdmin(), undefined, mode() === "farm" ? env("VTA_DID") : undefined);
        await writer.authenticate();
        await writer.call(T, body);
        continue;
      }
      if (e instanceof TrustTaskError) die(`store the ${k} credential in the VTA vault: refused (HTTP ${e.status}): ${text}`);
      throw e;
    }
  }
}

if (cmd === "accept") {
  const id = need();
  const offer = await lookup(id);
  if (!offer) die(`no offer to ${id} is addressed to ${me.did}.${hint("no open or recently accepted offer")}`);
  if (offer.visibility !== "open" && !persona) {
    die(`${id} is ${offer.visibility}, a sealed room. Joining one needs the member's VTA to mint an MLS KeyPackage, and it refuses when the member is the app did:key (not a persona it holds). Make a persona and have the room offered to it: docs/ROOMS.md, "Attributed and private rooms". Not attempted.`);
  }
  if (offer.visibility !== "open" && (await heldRooms()).has(id)) {
    console.log(`already joined: your VTA holds this room as ${me.did}.\nnext: npm run rooms:post -- ${id} "hello"`);
    process.exit(0);
  }
  if (offer.visibility !== "open") await storeRoomCredentials(offer as RoomOfferLike);
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
const name = option(rest, "name") ?? (cmd === "post" || cmd === "note" || cmd === "upload" ? await cardName() : undefined);
const MEDIA: Record<string, string> = { ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".pdf": "application/pdf" };
const avatarPath = option(rest, "avatar");
if (avatarPath && !existsSync(avatarPath)) die(`${avatarPath}: no such file`);
if (avatarPath && !name) die("--avatar needs a display name: pass --name \"...\" (or set your directory card's displayName)");
const avatar = avatarPath ? { mediaType: MEDIA[extname(avatarPath).toLowerCase()] ?? "application/octet-stream", bytes: new Uint8Array(readFileSync(avatarPath)) } : undefined;
const room = await call("open the room", () => RoomSession.open({ roomId: id, host, keys, self: appMe.did, ...(name ? { profile: { displayName: name, ...(avatar ? { avatar } : {}) } } : {}), start: cmd === "read" && flag(rest, "follow") }));
const label = (did?: string) => (did ? room.profiles.resolveSync(did).label : "?");
const line = (i: any) => {
  const e = i.envelope;
  const what = e?.kind === "note" ? `note "${e.title}" (${String(e.body).length} chars)` : e?.kind === "file" ? `file ${e.name} (${e.mediaType}, ${e.size} bytes)` : e?.text ?? `(${i.kind})`;
  return `[${i.version}] ${i.id}  ${label(i.author)}: ${what}`;
};

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

if (cmd === "note") {
  const [title, body] = [pos[1], pos.slice(2).join(" ")];
  if (!title || !body) die('npm run rooms:note -- <room DID> "Title" "body" [--id <note id>]');
  const item = await call("save note", () => room.saveNote(title, body, option(rest, "id")));
  await room.feed.sync();
  console.log(`saved note ${item.id} at version ${item.version}\nread back: ${line(room.item(item.id) ?? item)}`);
  room.close();
  process.exit(0);
}

if (cmd === "upload") {
  const path = pos[1] ?? die("npm run rooms:upload -- <room DID> <file path> [--type text/plain]");
  if (!existsSync(path)) die(`${path}: no such file`);
  const bytes = new Uint8Array(readFileSync(path));
  const type = option(rest, "type") ?? MEDIA[extname(path).toLowerCase()] ?? "application/octet-stream";
  const item = await call("upload", () => room.upload(basename(path), type, bytes));
  await room.feed.sync();
  console.log(`uploaded ${item.id} at version ${item.version}\nread back: ${line(room.item(item.id) ?? item)}`);
  room.close();
  process.exit(0);
}

if (cmd === "search") {
  const q = pos.slice(1).join(" ") || die('npm run rooms:search -- <room DID> "words" [--names]');
  const names = flag(rest, "names");
  const hits: any[] = names ? await room.search(q, "names") : await room.search(q, "text");
  console.log(`${hits.length} ${names ? "file-name" : "full-text"} hit(s) for "${q}"`);
  for (const h of hits) console.log(`  ${line(h.item)}${h.snippet ? `\n      ...${h.snippet}...` : ""}`);
  room.close();
  process.exit(0);
}

if (cmd === "download") {
  const itemId = pos[1] ?? die("npm run rooms:download -- <room DID> <item id> [out path]");
  const item = room.item(itemId);
  if (!item || (item.envelope as any).kind !== "file") die(`${itemId} is not a file in this room. \`npm run rooms:read -- <room DID>\` lists the ids.`);
  const bytes = await call("download", () => room.fileBytes(item as any));
  const out = pos[2];
  if (out) { writeFileSync(out, bytes); console.log(`wrote ${bytes.length} bytes to ${out} (SHA-256 matched the envelope)`); }
  else console.log(`${bytes.length} bytes, SHA-256 matched the envelope. Add an out path to save them.`);
  room.close();
  process.exit(0);
}

for (const i of room.items()) console.log(line(i));
{
  const who = [...new Set(room.items().map((i) => i.author).filter((a): a is string => !!a))];
  for (const did of who) {
    const p = await room.profiles.resolve(did);
    console.log(`author ${p.label}${p.isSelf ? " (you)" : ""}: ${p.source}${p.displayName ? `, name "${p.displayName}"` : ""}${p.avatarUrl ? `, avatar ${p.avatarUrl.slice(5, p.avatarUrl.indexOf(";"))} ${Math.round((p.avatarUrl.length - p.avatarUrl.indexOf(",") - 1) * 0.75)} bytes` : ", no avatar"}  ${did}`);
  }
}
if (!flag(rest, "follow")) { room.close(); process.exit(0); }
console.log("-- following (Ctrl-C to stop) --");
const src = room.feed.source as any;
if (src) src.onStatus = (st: string, err?: unknown) => { if (st !== "live") console.log(`-- feed ${st}${err ? `: ${String((err as Error).message ?? err).slice(0, 200)}` : ""}`); };
room.onChange((c) => {
  for (const i of [...c.added, ...c.updated]) console.log(line(i));
  for (const f of c.failed) console.log(`-- could not read ${f.key} (version ${f.version}): ${String((f.error as Error)?.message ?? f.error).slice(0, 300)}`);
  if (c.removed.length) console.log(`-- removed: ${c.removed.join(", ")}`);
});
