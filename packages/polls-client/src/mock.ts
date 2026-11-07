// An in-process stand-in for the three poll parties on one node:http server, for tests and the offline demo:
//   /vtc  the community (registrar):  GET /vtc/.well-known/did.jsonl, POST /vtc/v1/trust-tasks
//   /vta  the member's VTA (voter):   GET /vta/.well-known/did.jsonl, POST /vta/trust-tasks (auth is accepted for anyone)
//   /box  the ballot box:             GET /box/did.jsonl (did:webvh path form, TrustTaskHTTPS service), POST /box/trust-tasks
// It applies the election RULES (who may create, ticket window, one ticket each, revote, early close, notTallied,
// private boards) and the slug-scoped refusal codes, but NO cryptography: proofs are not checked, tickets and tags are
// random, a cast's attestation is the string "mock". It proves the client's wiring and error handling, not the protocol.
// Node only.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { newIdentity, rfc3339 } from "@buildathon/vta-client";
import { signTrustTask } from "@openvtc/trust-tasks-proof";
import { validateSelections, type Ballot, type Selections } from "./ballot.js";
import { validateManifest, type Manifest } from "./manifest.js";
import type { QuestionResult } from "./results.js";
import { POLL_TASK } from "./tasks.js";

const ERROR_TYPE = "https://trusttasks.org/spec/trust-task-error/0.5";
const T = "https://trusttasks.org/spec";

export interface MockOpts {
  port?: number;
  /** Signers allowed `vtc.elections.manage`; `"any"` lets every signer manage. Default `"any"`. */
  managers?: string[] | "any";
  /** DIDs the community holds as members (for the `members` roll). Default: everyone is a member. */
  members?: string[] | "any";
  /** The clock; tests move it. */
  now?: () => Date;
}

interface Election { manifest: Manifest; digest: string; closed?: "closed" | "cancelled"; tickets: Set<string>; casts: Map<string, { ballot: Ballot; json: string }>; leaves: number }

export interface PollsMock {
  url: string; vtcUrl: string; vtaUrl: string; boxUrl: string;
  vtcDid: string; vtaDid: string; boxDid: string;
  elections: Map<string, Election>;
  close(): Promise<void>;
}

class Refusal extends Error {
  constructor(readonly code: string, readonly status = 422, readonly details?: Record<string, unknown>) { super(code); }
}

const digestOf = (m: unknown) => "u" + createHash("sha256").update(JSON.stringify(m)).digest("base64url");
const body = (req: IncomingMessage) => new Promise<string>((ok, no) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => ok(s)); req.on("error", no); });

export async function startPollsMock(o: MockOpts = {}): Promise<PollsMock> {
  const now = o.now ?? (() => new Date());
  const managers = o.managers ?? "any";
  const members = o.members ?? "any";
  const elections = new Map<string, Election>();
  // VTA side: tickets by `${contextId}|${electionId}`, and the registration in flight.
  const vtaTickets = new Map<string, string>();
  const pending = new Set<string>();
  const server: Server = createServer();
  await new Promise<void>((ok) => server.listen(o.port ?? 0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const host = `127.0.0.1%3A${port}`;
  const vtcDid = `did:webvh:Qmfakevtc:${host}:vtc`;
  const vtaDid = `did:webvh:Qmfakevta:${host}:vta`;
  const boxDid = `did:webvh:Qmfakebox:${host}:box`;
  const isManager = (d: string) => managers === "any" || managers.includes(d);
  const isMember = (d: string) => members === "any" || members.includes(d);

  const get = (id: unknown): Election => {
    const e = elections.get(String(id));
    if (!e) throw new Refusal("electionUnknown", 404);
    return e;
  };
  const t = (s: string) => Date.parse(s);
  const stateOf = (e: Election): string => {
    if (e.closed === "cancelled") return "cancelled";
    if (e.closed || now().getTime() >= t(e.manifest.votingClosesAt)) return "tallied";
    return now().getTime() >= t(e.manifest.votingOpensAt) ? "voting" : "registration";
  };
  const onRoll = (e: Election, did: string) => {
    const r = e.manifest.roll;
    const listed = r.listed?.includes(did) ?? false;
    return r.rule === "listed" ? listed : r.rule === "membersAndListed" ? listed || isMember(did) : isMember(did);
  };
  const shown = (e: Election) => ({
    manifest: e.manifest, manifestDigest: e.digest, state: stateOf(e),
    parameters: { suite: "ps-ddh-bls12381", votingKey: "mock" },
    disclosure: { ballotBox: e.manifest.ballotBox, ballotBoxOperator: "mock", sameOperator: true, boardVisibility: e.manifest.board.visibility, auditors: e.manifest.board.auditors, revote: e.manifest.revote, coercionResistance: false },
    checkpoints: [],
  });

  const vtc = (doc: any): unknown => {
    const p = doc.payload ?? {}, who = String(doc.issuer);
    switch (doc.type) {
      case POLL_TASK.create: {
        if (!isManager(who)) throw new Refusal("permissionDenied", 403);
        const m = p.manifest as Manifest;
        const problems = m ? validateManifest(m) : ["no manifest"];
        if (problems.length) throw new Refusal("invalidManifest", 422, { reason: problems.join("; ") });
        if (m.community !== vtcDid) throw new Refusal("communityMismatch");
        if (m.ballotBox !== boxDid) throw new Refusal("ballotBoxNotTrusted");
        if (elections.has(m.electionId)) throw new Refusal("electionExists", 409);
        const e: Election = { manifest: m, digest: digestOf(m), tickets: new Set(), casts: new Map(), leaves: 0 };
        elections.set(m.electionId, e);
        return { electionId: m.electionId, manifestDigest: e.digest, state: "registered" };
      }
      case POLL_TASK.list: {
        const items = [...elections.values()].filter((e) => isManager(who) || onRoll(e, who)).map((e) => ({
          electionId: e.manifest.electionId, state: stateOf(e), votingOpensAt: e.manifest.votingOpensAt, votingClosesAt: e.manifest.votingClosesAt,
          binding: e.manifest.binding, ticketHeld: e.tickets.has(who), ...(e.manifest.title ? { title: e.manifest.title } : {}),
        }));
        return { elections: p.state ? items.filter((i) => i.state === p.state) : items };
      }
      case POLL_TASK.show: {
        const e = get(p.electionId);
        if (!isManager(who) && !onRoll(e, who)) throw new Refusal("electionUnknown", 404);
        return shown(e);
      }
      case POLL_TASK.close:
      case POLL_TASK.cancel: {
        if (!isManager(who)) throw new Refusal("permissionDenied", 403);
        const e = get(p.electionId);
        if (["tallied", "cancelled"].includes(stateOf(e))) throw new Refusal("notOpen");
        if (doc.type === POLL_TASK.cancel) {
          if (!p.reason) throw new Refusal("malformedRequest", 400);
          e.closed = "cancelled";
        } else {
          if (now().getTime() < t(e.manifest.votingClosesAt) && !e.manifest.allowEarlyClose) throw new Refusal("earlyCloseNotAllowed");
          e.closed = "closed";
        }
        return { electionId: e.manifest.electionId, state: stateOf(e) };
      }
      case POLL_TASK.ballotBoxes:
        if (!isManager(who)) throw new Refusal("permissionDenied", 403);
        return { ballotBoxes: [{ did: boxDid, operator: "mock", sameOperator: true }] };
      case POLL_TASK.ticketsIssue: {
        const e = get(p.electionId);
        if (p.manifestDigest !== e.digest) throw new Refusal("manifestMismatch");
        const n = now().getTime();
        if (e.closed || n < t(e.manifest.registrationOpensAt) || n >= t(e.manifest.votingClosesAt)) throw new Refusal("notOpen");
        if (!onRoll(e, who)) throw new Refusal("notEligible", 403);
        if (e.tickets.has(who)) throw new Refusal("alreadyIssued", 409);
        e.tickets.add(who);
        return { electionId: e.manifest.electionId, label: `voter/${e.manifest.electionId}`, preCredential: "mock" };
      }
      default:
        throw new Refusal("unsupportedType", 400);
    }
  };

  // A document "signed by the member": the VTA holds the member key upstream; the mock VTC checks no proof.
  const asMember = (member: string, type: string, payload: unknown) => ({ id: randomUUID(), type, issuer: member, recipient: vtcDid, issuedAt: rfc3339(now()), payload });

  const vta = (doc: any): unknown => {
    const p = doc.payload ?? {};
    if (doc.type === `${T}/auth/challenge/0.1` || /\/auth\/challenge\//.test(doc.type)) return { challenge: randomUUID(), sessionId: randomUUID() };
    if (/\/auth\/authenticate\//.test(doc.type)) return { tokens: { accessToken: "mock-token" } };
    const key = `${p.contextId}|${p.electionId ?? p.manifest?.electionId ?? p.ballot?.electionId}`;
    switch (doc.type) {
      case POLL_TASK.voterRead:
        if (!p.member) throw new Refusal("memberNotHeld");
        return { document: asMember(p.member, p.read === "list" ? POLL_TASK.list : POLL_TASK.show, p.payload ?? {}) };
      case POLL_TASK.voterRegister: {
        if (vtaTickets.has(key)) throw new Refusal("ticketHeld", 409);
        if (digestOf(p.manifest) !== get(p.manifest?.electionId).digest) throw new Refusal("electionChanged");
        pending.add(key);
        const manifestDigest = digestOf(p.manifest);
        return { electionId: p.manifest.electionId, manifestDigest, request: {}, ticketDocument: asMember(p.member, POLL_TASK.ticketsIssue, { electionId: p.manifest.electionId, manifestDigest, request: { label: `voter/${p.manifest.electionId}`, id: randomUUID(), request: { proof: "mock" } } }) };
      }
      case POLL_TASK.voterAccept:
        if (!pending.delete(key)) throw new Refusal("noRequestInFlight");
        if (p.response?.preCredential !== "mock") throw new Refusal("credentialInvalid");
        vtaTickets.set(key, randomUUID());
        return { electionId: p.electionId, ticketHeld: true };
      case POLL_TASK.vote: {
        const tag = vtaTickets.get(key);
        if (!tag) throw new Refusal("notFound", 404);
        const m = p.manifest as Manifest, b = p.ballot as Ballot;
        if (b.manifestDigest !== digestOf(m)) throw new Refusal("manifestMismatch");
        const once = newIdentity(); // a one-time did:key per cast, as upstream
        const castDocument = signTrustTask({ id: randomUUID(), type: POLL_TASK.cast, issuer: once.did, recipient: m.ballotBox, issuedAt: rfc3339(now()), payload: { community: p.community, electionId: m.electionId, cast: { ballot: b, tag, attestation: "mock" } } } as any, once.signer, { proofPurpose: "authentication" });
        return { castDocument, tag };
      }
      case POLL_TASK.voterReceipt:
        return { status: "included", leafIndex: p.receipt?.leafIndex ?? 0 };
      default:
        throw new Refusal("unsupportedType", 400);
    }
  };

  const tally = (e: Election): QuestionResult[] => e.manifest.questions.map((q) => {
    const r: QuestionResult = { question: q.key, abstained: 0, choice: {} };
    if (q.type === "choice") for (const o of q.options) r.choice![o.key] = 0;
    for (const { ballot } of e.casts.values()) {
      const a = ballot.answers.find((x) => x.question === q.key);
      if (!a || a.abstain) r.abstained++;
      else for (const c of a.choice ?? []) r.choice![c] = (r.choice![c] ?? 0) + 1;
    }
    return r;
  });

  const box = (doc: any): unknown => {
    const p = doc.payload ?? {};
    switch (doc.type) {
      case POLL_TASK.cast: {
        if (!String(doc.issuer).startsWith("did:key:")) throw new Refusal("castInvalid", 401);
        const e = get(p.electionId);
        const n = now().getTime();
        if (e.closed || n < t(e.manifest.votingOpensAt) || n >= t(e.manifest.votingClosesAt)) throw new Refusal("notOpen");
        const { ballot, tag } = p.cast ?? {};
        if (ballot?.manifestDigest !== e.digest) throw new Refusal("manifestMismatch");
        const sel: Selections = Object.fromEntries((ballot.answers ?? []).map((a: any) => [a.question, a.abstain ? "abstain" : a.choice ?? []]));
        if (validateSelections(e.manifest, sel).length) throw new Refusal("ballotInvalid");
        const json = JSON.stringify(ballot);
        const prev = e.casts.get(tag);
        let outcome: "counted" | "replaced" | "alreadyCounted" = "counted";
        if (prev) {
          if (prev.json === json) outcome = "alreadyCounted";
          else if (e.manifest.revote === "refuse") throw new Refusal("alreadyVoted", 409);
          else outcome = "replaced";
        }
        if (outcome !== "alreadyCounted") { e.casts.set(tag, { ballot, json }); e.leaves++; }
        return { electionId: e.manifest.electionId, outcome, leafIndex: e.leaves - 1, entryHash: digestOf(ballot), head: { size: e.leaves }, receiptToken: randomUUID() };
      }
      case POLL_TASK.resultShow: {
        const e = get(p.electionId);
        if (e.manifest.board.visibility === "private" && !isManager(String(doc.issuer)) && !e.manifest.board.auditors.includes(String(doc.issuer))) throw new Refusal("permissionDenied", 403);
        const state = stateOf(e);
        if (state === "cancelled") throw new Refusal("electionUnknown", 404);
        const done = state === "tallied";
        if (!done && !e.manifest.resultsBeforeClose) throw new Refusal("notTallied", 409);
        return { result: { electionId: e.manifest.electionId, manifestDigest: e.digest, ballotsCounted: e.casts.size, head: { size: e.leaves }, questions: tally(e) }, provisional: !done, state };
      }
      default:
        throw new Refusal("unsupportedType", 404);
    }
  };

  const slugOf = (type: string) => type.replace(`${T}/`, "").replace(/\/\d+\.\d+$/, "");
  const didLog = (id: string, service?: unknown[]) => JSON.stringify({ state: { id, ...(service ? { service } : {}) } }) + "\n";

  server.on("request", async (req, res) => {
    const send = (status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    try {
      if (req.method === "GET") {
        if (req.url === "/vtc/.well-known/did.jsonl") return void res.end(didLog(vtcDid));
        if (req.url === "/vta/.well-known/did.jsonl") return void res.end(didLog(vtaDid));
        if (req.url === "/box/did.jsonl") return void res.end(didLog(boxDid, [{ id: "#tt", type: "TrustTaskHTTPS", serviceEndpoint: `${url}/box` }]));
        return send(404, { error: "notFound" });
      }
      const route = req.url === "/vtc/v1/trust-tasks" ? vtc : req.url === "/vta/trust-tasks" ? vta : req.url === "/box/trust-tasks" ? box : undefined;
      if (!route) return send(404, { error: "notFound" });
      const doc = JSON.parse(await body(req));
      try {
        send(200, { id: randomUUID(), threadId: doc.id, type: `${doc.type}#response`, payload: route(doc) });
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        const framework = ["permissionDenied", "unsupportedType", "malformedRequest"].includes(e.code);
        send(e.status, { id: randomUUID(), threadId: doc.id, type: ERROR_TYPE, payload: { code: framework ? e.code : `${slugOf(doc.type)}:${e.code}`, message: e.code, ...(e.details ? { details: e.details } : {}) } });
      }
    } catch (e) {
      send(500, { error: "internal", message: e instanceof Error ? e.message : String(e) });
    }
  });

  return {
    url, vtcUrl: `${url}/vtc`, vtaUrl: `${url}/vta`, boxUrl: `${url}/box`, vtcDid, vtaDid, boxDid, elections,
    close: () => new Promise<void>((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
