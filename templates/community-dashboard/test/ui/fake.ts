// A fake community behind the real VtcClient interface. It holds "the database" in `db`; tests change `db` the way a
// second terminal would (the CLI approving a request) and assert that the page follows only when it re-reads.
import { vi } from "vitest";
import { TrustTaskError } from "@starter/vta-client";
import type { CallEvent } from "@starter/vtc-client";

export interface Db {
  request?: { id: string; status: string };
  member: boolean;
  card: { revision: number; values: Record<string, string> };
  criteria: any[];
  /** Make the next call to a method fail: `{ method: refusal }`. */
  failing: Record<string, TrustTaskError | Error>;
  networkDown: boolean;
  /** Whether the community holds the member's own membership credential (what the status reports as credentialsDelivered). */
  delivered: boolean;
}

export const refusal = (status: number, code: string, message = "") => new TrustTaskError(status, { payload: { code, message } });
export const notFound = () => refusal(404, "urn:x:vtc:notFound", "no open request");
export const notMember = () => refusal(403, "urn:x:vtc:permissionDenied", "the signer holds no entry in this community");

export const REVIEW = { id: "review", requirementsDigest: "digest-review-0001", admission: "review" };

export function freshDb(): Db {
  return { member: false, card: { revision: 0, values: { nickname: "" } }, criteria: [REVIEW], failing: {}, networkDown: false, delivered: false };
}

export class FakeClient {
  vtcDid = "did:example:community";
  onCall?: (e: CallEvent) => void;
  /** Every call made, in order: `calls.filter(isChange)` is what StrictMode must not double. */
  calls: string[] = [];
  nextId = 1;
  constructor(public db: Db) {}
  /** Start a test from a known database; the connection (and its call observer) stays, as it does for a real page. */
  reset(db: Db = freshDb()) { this.db = db; this.calls = []; this.nextId = 1; vi.clearAllMocks(); }

  private async run<T>(method: string, type: string, fn: () => T, ms = 12): Promise<T> {
    this.calls.push(method);
    const startedAt = new Date().toISOString();
    const done = (ok: boolean, extra: Partial<CallEvent> = {}) => this.onCall?.({ type, issuer: "did:example:app", startedAt, durationMs: ms, ok, payload: {}, ...extra } as CallEvent);
    await Promise.resolve();
    try {
      if (this.db.networkDown) throw new TypeError("fetch failed");
      const forced = this.db.failing[method];
      if (forced) throw forced;
      const r = fn();
      done(true, { status: 200 });
      return r;
    } catch (e) {
      done(false, e instanceof TrustTaskError ? { status: e.status, code: (e.body as any)?.payload?.code } : { code: "network" });
      throw e;
    }
  }
  private requireMember() { if (!this.db.member) throw notMember(); }
  private task = (t: string) => `https://trusttasks.org/spec/vtc/${t}`;

  manifest = vi.fn(() => this.run("manifest", this.task("join-requests/manifest/0.4"), () => ({ communityDid: this.vtcDid, criteria: this.db.criteria })));
  joinPayload = vi.fn((o: any) => ({ criterion: o?.criterion }));
  joinStatus = vi.fn((_id?: string) => this.run("joinStatus", this.task("join-requests/status/0.1"), () => {
    const r = this.db.request;
    if (!r) throw notFound();
    return { requestId: r.id, status: r.status, credentialsDelivered: this.db.delivered };
  }));
  communityProfile = vi.fn(() => this.run("communityProfile", this.task("community/profile/show/0.1"), () => { this.requireMember(); return { profile: { name: "Test Community" } }; }));
  memberProof = vi.fn(() => this.run("memberProof", "GET /v1/member/me", () => { this.requireMember(); return { did: "x", sessionId: "s", accessExpiresAt: 0, amr: [], joinedAt: "2026-01-02T03:04:05Z", role: "member", personhood: false, canManagePasskeys: false, community: { name: "Test Community", logoUrl: null, did: null } }; }));
  groups = vi.fn(() => this.run("groups", this.task("groups/list/0.2"), () => { this.requireMember(); return { items: [] }; }));
  directoryEntries = vi.fn(() => this.run("directoryEntries", this.task("directory/entries/list/0.2"), () => { this.requireMember(); return { items: [{ entryId: "e1", values: { nickname: "Ada" } }] }; }));
  directoryEntry = vi.fn(() => this.run("directoryEntry", this.task("directory/entries/show/0.1"), () => ({ entryId: "e1" })));
  directoryFields = vi.fn(() => this.run("directoryFields", this.task("directory/fields/list/0.1"), () => { this.requireMember(); return { fields: [{ key: "nickname", label: "Nickname", source: "member" }] }; }));
  myCard = vi.fn(() => this.run("myCard", this.task("directory/card/show/0.1"), () => { this.requireMember(); return { card: { ...this.db.card }, missingRequired: [] }; }));

  // state-changing
  submitJoin = vi.fn((o: any) => this.run("submitJoin", this.task("join-requests/submit/0.3"), () => {
    const id = `req-${this.nextId++}`;
    this.db.request = { id, status: "pending" };
    return { requestId: id, verdict: { status: "pending" } };
  }));
  withdrawJoin = vi.fn(() => this.run("withdrawJoin", this.task("join-requests/withdraw/0.1"), () => { if (!this.db.request) throw notFound(); this.db.request.status = "withdrawn"; return {}; }));
  supplementJoin = vi.fn(() => this.run("supplementJoin", this.task("join-requests/supplement/0.1"), () => ({})));
  renewMembership = vi.fn(() => this.run("renewMembership", this.task("members/renew/0.1"), () => { this.requireMember(); return {}; }));
  sendMembershipCredential = vi.fn((_o?: any) => this.run("sendMembershipCredential", this.task("members/vmc/0.1"), () => {
    if (!this.db.member) throw refusal(404, "vtc/members/vmc:notAMember", "no active member");
    this.db.delivered = true;
    return { memberDid: "did:example:app", vmcId: "urn:uuid:00000000-0000-4000-8000-000000000001", status: "stored" };
  }));
  leaveCommunity = vi.fn(() => this.run("leaveCommunity", this.task("members/self-remove/0.1"), () => { this.requireMember(); this.db.member = false; return {}; }));
  updateMyCard = vi.fn((patch: any) => this.run("updateMyCard", this.task("directory/card/update/0.1"), () => {
    this.requireMember();
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== this.db.card.revision) throw refusal(409, "urn:x:vtc:revisionConflict");
    this.db.card = { revision: this.db.card.revision + 1, values: { ...this.db.card.values, ...Object.fromEntries(Object.entries(patch.values ?? {}).map(([k, v]) => [k, String(v)])) } };
    return {};
  }));
}

export const CHANGES = ["submitJoin", "withdrawJoin", "supplementJoin", "renewMembership", "sendMembershipCredential", "leaveCommunity", "updateMyCard"];

/** What "the admin approved it in another terminal" does to the database. */
export const approve = (db: Db) => { if (db.request) db.request.status = "approved"; db.member = true; };

export const fake = new FakeClient(freshDb());
