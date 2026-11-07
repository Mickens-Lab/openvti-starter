// PollsClient: a poll's whole life over the three parties.
//  - The community (VtcClient): create, list, show, close, cancel; it issues the voting ticket.
//  - The member's VTA (VtaClient, authenticated): reads as the member, takes the ticket, builds the cast. All PCS
//    crypto happens there; this client only carries the documents, byte for byte (re-serialising breaks digests).
//  - The ballot box (plain HTTPS POST of a signed document): counts the cast, shows the result.
// Sequence and rules: vta-cli-common/src/commands/elections.rs (upstream) and docs/plans/2026-11-07-polls-client-plan.md.
import { classifyReply, rfc3339, unwrapReply, type VtaClient } from "@buildathon/vta-client";
import type { VtcClient } from "@buildathon/vtc-client";
import { signTrustTask } from "@openvtc/trust-tasks-proof";
import { buildBallot, resolveOptions, type Selections } from "./ballot.js";
import { pollRefusal } from "./errors.js";
import { ManifestError, validateManifest, type Manifest } from "./manifest.js";
import type { PollState, ResultReply } from "./results.js";
import { POLL_TASK } from "./tasks.js";

export interface PollListItem { electionId: string; state: PollState | string; votingOpensAt: string; votingClosesAt: string; binding: boolean; ticketHeld: boolean; title?: string }
export interface PollList { elections: PollListItem[]; nextCursor?: string }
export interface PollShown {
  manifest: Manifest;
  manifestDigest: string;
  state: PollState | string;
  parameters: { suite: string; votingKey: string; [k: string]: unknown };
  disclosure: { ballotBox: string; boardVisibility?: string; revote?: string; auditors?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}
export interface Created { electionId: string; manifestDigest: string; state: string; actionId?: string }
export interface CastReceipt { electionId: string; outcome: "counted" | "replaced" | "alreadyCounted"; leafIndex: number; entryHash?: string; head?: unknown; receiptToken?: string }
export interface VoteOutcome { electionId: string; outcome: CastReceipt["outcome"]; tag: string; ticketTaken: boolean; receipt: CastReceipt; kept?: string }

export interface PollsClientOpts {
  /** Signs community calls. Create/close/cancel need `vtc.elections.manage` on this signer. */
  vtc: VtcClient;
  /** The member's VTA, already authenticated; needed to vote and to read as the member. */
  vta?: VtaClient;
  /** The VTA context the member's keys live in. */
  contextId?: string;
  /** The member DID (held by the VTA) the community knows. */
  member?: string;
  /** The ballot box's HTTPS Trust Task base. Default: resolved from its did:webvh (`TrustTaskHTTPS` service). */
  ballotBoxUrl?: string | ((did: string) => Promise<string>);
  /** Pause between building the cast and sending it, so the two cannot be paired by time. Default random 0-20 s. */
  castDelayMs?: number | (() => number);
  fetchImpl?: typeof fetch;
}

const MAX_CAST_DELAY_MS = 20_000;

export class PollsClient {
  readonly vtc: VtcClient;
  readonly vta?: VtaClient;
  readonly contextId?: string;
  readonly member?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly boxUrls = new Map<string, Promise<string>>();

  constructor(private readonly o: PollsClientOpts) {
    this.vtc = o.vtc;
    this.vta = o.vta;
    this.contextId = o.contextId;
    this.member = o.member;
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
  }

  get community(): string { return this.vtc.vtcDid; }

  // --- the community, as a manager -----------------------------------------------------------------

  /** Validate locally, then `vtc/elections/create`. `community` is set to this VTC's DID when missing. */
  async create(manifest: Manifest): Promise<Created> {
    const m = { ...manifest, community: manifest.community || this.community };
    const problems = validateManifest(m);
    if (problems.length) throw new ManifestError(problems);
    return this.vtc.call<Created>(POLL_TASK.create, { manifest: m });
  }

  /** Close voting now (needs `allowEarlyClose` before the deadline). The ballot box tallies. */
  close(electionId: string, reason?: string): Promise<{ electionId: string; state: string }> {
    return this.vtc.call(POLL_TASK.close, { electionId, ...(reason ? { reason } : {}) });
  }

  /** Cancel: no result is produced. `reason` is required by the community. */
  async cancel(electionId: string, reason: string): Promise<{ electionId: string; state: string }> {
    if (!reason.trim()) throw new Error("cancelling a poll needs a reason");
    return this.vtc.call(POLL_TASK.cancel, { electionId, reason });
  }

  /** The ballot boxes this community trusts (a manifest's `ballotBox` names one). */
  ballotBoxes(): Promise<{ ballotBoxes: { did: string; operator?: string; sameOperator?: boolean }[] }> {
    return this.vtc.call(POLL_TASK.ballotBoxes, {});
  }

  // --- reads ---------------------------------------------------------------------------------------

  /** Polls this signer may see. As the member (through the VTA) when a VTA and member are set, else as `vtc.me`. */
  list(opts: { state?: string; cursor?: string; limit?: number } = {}): Promise<PollList> {
    return this.asMember() ? this.readAsMember<PollList>("list", opts) : this.vtc.call<PollList>(POLL_TASK.list, opts);
  }

  show(electionId: string): Promise<PollShown> {
    return this.asMember() ? this.readAsMember<PollShown>("show", { electionId }) : this.vtc.call<PollShown>(POLL_TASK.show, { electionId });
  }

  private asMember(): boolean { return Boolean(this.vta && this.member && this.contextId); }

  private need(): { vta: VtaClient; contextId: string; member: string } {
    if (!this.vta || !this.contextId || !this.member) throw new Error("voting needs the member's VTA, a contextId and the member DID (POLL_MEMBER_DID)");
    return { vta: this.vta, contextId: this.contextId, member: this.member };
  }

  /** The VTA signs the read as the member (`vta/pcs/voter/read`); the signed document goes to the community as is. */
  private async readAsMember<R>(read: "list" | "show", payload: Record<string, unknown>): Promise<R> {
    const { vta, contextId, member } = this.need();
    const { document } = await vta.call<{ document: Record<string, unknown> }>(POLL_TASK.voterRead, { contextId, community: this.community, member, read, payload });
    return unwrapReply<R>(await this.vtc.send(document));
  }

  // --- voting --------------------------------------------------------------------------------------

  /**
   * Take the voting ticket for `shown` unless the VTA already holds one: VTA `voter/register`, the community's
   * `tickets/issue`, VTA `voter/accept`. True when this call took it. Upstream advises taking the ticket in an
   * earlier session than the vote, so the two are not paired by time; `vote` takes it on demand otherwise.
   */
  async takeTicket(shown: PollShown): Promise<boolean> {
    const { vta, contextId, member } = this.need();
    let reg: { electionId: string; manifestDigest: string; ticketDocument: Record<string, unknown> };
    try {
      reg = await vta.call(POLL_TASK.voterRegister, { contextId, community: this.community, member, parameters: shown.parameters, manifest: shown.manifest });
    } catch (e) {
      if (pollRefusal(e)?.code === "ticketHeld") return false;
      throw e;
    }
    if (reg.manifestDigest !== shown.manifestDigest) throw new Error(`the VTA read a different poll (digest ${reg.manifestDigest}, community shows ${shown.manifestDigest}); read it again`);
    const issued = unwrapReply<Record<string, unknown>>(await this.vtc.send(reg.ticketDocument));
    const { ext: _ext, ...response } = issued;
    await vta.call(POLL_TASK.voterAccept, { contextId, community: this.community, electionId: shown.manifest.electionId, parameters: shown.parameters, response });
    return true;
  }

  /**
   * Vote. `selections` maps question keys to option keys, labels or 1-based numbers (or `"abstain"`); a bare list is
   * the answer to the first question. Validated locally first ({@link BallotError}).
   */
  async vote(electionId: string, selections: Selections | string[], opts: { shown?: PollShown } = {}): Promise<VoteOutcome> {
    const { vta, contextId } = this.need();
    const shown = opts.shown ?? (await this.show(electionId));
    const m = shown.manifest;
    if (["closed", "tallied", "cancelled"].includes(shown.state)) throw new Error(`the poll is ${shown.state}; it takes no more votes`);
    const raw: Selections = Array.isArray(selections) ? { [m.questions[0].key]: selections } : selections;
    const sel: Selections = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === "abstain" ? v : resolveOptions(m, k, v)]));
    const ballot = buildBallot(m, shown.manifestDigest, sel);
    const ticketTaken = await this.takeTicket(shown);
    const { castDocument, tag } = await vta.call<{ castDocument: Record<string, unknown>; tag: string }>(POLL_TASK.vote, {
      contextId, community: this.community, parameters: shown.parameters, manifest: m, ballot,
    });
    const delay = typeof this.o.castDelayMs === "function" ? this.o.castDelayMs() : this.o.castDelayMs ?? Math.floor(Math.random() * MAX_CAST_DELAY_MS);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const receipt = unwrapReply<CastReceipt>(await this.postToBox(shown.disclosure?.ballotBox ?? m.ballotBox, castDocument));
    let kept: string | undefined;
    try {
      kept = (await vta.call<{ status: string }>(POLL_TASK.voterReceipt, { contextId, community: this.community, electionId, receipt })).status;
    } catch { /* the vote is counted; keeping the receipt at the VTA is best effort */ }
    return { electionId, outcome: receipt.outcome, tag, ticketTaken, receipt, ...(kept ? { kept } : {}) };
  }

  /**
   * The result from the ballot box (`voting/result/show`), signed by `vtc.me`. Refused with `notTallied` while
   * voting is open unless the poll shows running totals (`provisional: true` then).
   */
  async results(electionId: string, opts: { shown?: PollShown; ballotBox?: string } = {}): Promise<ResultReply> {
    const box = opts.ballotBox ?? opts.shown?.disclosure?.ballotBox ?? (await this.show(electionId)).disclosure.ballotBox;
    const doc = signTrustTask(
      { id: globalThis.crypto.randomUUID(), type: POLL_TASK.resultShow, issuer: this.vtc.me.did, recipient: box, issuedAt: rfc3339(), payload: { community: this.community, electionId } } as any,
      this.vtc.me.signer,
      { proofPurpose: "authentication" },
    ) as unknown as Record<string, unknown>;
    return unwrapReply<ResultReply>(await this.postToBox(box, doc));
  }

  /** POST a signed document to the ballot box's `/trust-tasks` and classify the reply. */
  private async postToBox(boxDid: string, doc: Record<string, unknown>) {
    const base = await this.boxUrl(boxDid);
    const res = await this.fetchImpl(`${base.replace(/\/+$/, "")}/trust-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) });
    return classifyReply(doc as { id?: string; type: string }, res.status, await res.text());
  }

  boxUrl(did: string): Promise<string> {
    const o = this.o.ballotBoxUrl;
    if (typeof o === "string") return Promise.resolve(o);
    let p = this.boxUrls.get(did);
    if (!p) {
      p = typeof o === "function" ? o(did) : resolveTrustTaskHttps(did, this.fetchImpl);
      p.catch(() => this.boxUrls.delete(did));
      this.boxUrls.set(did, p);
    }
    return p;
  }
}

/** Where a did:webvh log lives: `did:webvh:<scid>:<host>[:path...]` -> `<scheme>://<host>/<path>/did.jsonl` (or `/.well-known/did.jsonl`). */
export function didWebvhLogUrl(did: string): string {
  const parts = did.split(":");
  if (parts[0] !== "did" || parts[1] !== "webvh" || parts.length < 4) throw new Error(`not a did:webvh: ${did}`);
  const host = decodeURIComponent(parts[3]);
  const path = parts.slice(4).map(decodeURIComponent);
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? "http" : "https";
  return `${scheme}://${host}/${path.length ? path.join("/") + "/did.jsonl" : ".well-known/did.jsonl"}`;
}

/** The `TrustTaskHTTPS` service endpoint in a did:webvh's current document. */
export async function resolveTrustTaskHttps(did: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string> {
  const res = await fetchImpl(didWebvhLogUrl(did));
  if (!res.ok) throw new Error(`resolve ${did}: HTTP ${res.status}`);
  const lines = (await res.text()).trim().split("\n");
  const doc = JSON.parse(lines[lines.length - 1]).state ?? {};
  for (const s of doc.service ?? []) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.includes("TrustTaskHTTPS")) continue;
    const ep = typeof s.serviceEndpoint === "string" ? s.serviceEndpoint : s.serviceEndpoint?.uri;
    if (typeof ep === "string") return ep;
  }
  throw new Error(`the ballot box ${did} advertises no TrustTaskHTTPS endpoint; set BALLOT_BOX_URL`);
}
