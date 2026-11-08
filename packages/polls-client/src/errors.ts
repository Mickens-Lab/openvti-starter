// Refusals from the three parties, decoded. Election codes carry the task slug (`vtc/elections/create:invalidManifest`);
// framework codes do not (`permissionDenied`). `pollRefusal` splits them and `explainPollRefusal` says what to do.
import { TrustTaskError, refusalDetails } from "@starter/vta-client";

export interface PollRefusal {
  /** The bare code, e.g. `alreadyVoted`, `notTallied`, `permissionDenied`; `network` when nothing answered. */
  code: string;
  /** The task slug the code was scoped to, when it had one. */
  slug?: string;
  status?: number;
  message?: string;
  details?: Record<string, unknown>;
}

export function splitCode(raw: string): { code: string; slug?: string } {
  const i = raw.lastIndexOf(":");
  return i > 0 && raw.slice(0, i).includes("/") ? { code: raw.slice(i + 1), slug: raw.slice(0, i) } : { code: raw };
}

/** The refusal in a thrown value, or undefined when it is not a Trust Task or network failure (a local validation error). */
export function pollRefusal(e: unknown): PollRefusal | undefined {
  if (e instanceof TrustTaskError) {
    const p = (e.body as any)?.payload ?? {};
    const raw = typeof p.code === "string" ? p.code : typeof (e.body as any)?.code === "string" ? (e.body as any).code : e.status === 429 ? "rateLimited" : "unexpected";
    return { ...splitCode(raw), status: e.status, ...(typeof p.message === "string" ? { message: p.message } : {}), ...(refusalDetails(e.body) ? { details: refusalDetails(e.body) } : {}) };
  }
  if (e instanceof TypeError) return { code: "network", message: e.message };
  return undefined;
}

const WORDS: Record<string, string> = {
  permissionDenied: "Not allowed: creating, closing or cancelling a poll needs vtc.elections.manage at the community; voting needs pcs-voter at your VTA.",
  unsupportedType: "This server does not serve that task. The kit's pinned VTC is built without the voting feature (see the polls-client README).",
  unsupportedVersion: "This server serves a different version of that task.",
  electionExists: "A poll with that id already exists; choose another id.",
  invalidManifest: "The community refused the poll as invalid.",
  unsupportedSecrecy: "The community does not offer that secrecy level.",
  ballotBoxNotTrusted: "The community does not trust that ballot box; pick one from `ballot-boxes`.",
  ballotBoxRefused: "The ballot box refused the poll.",
  ballotBoxUnavailable: "The ballot box did not answer; try again later.",
  electionUnknown: "No such poll, or you are not on its roll.",
  notOpen: "The poll is not open for that now (not started, or already closed).",
  notEligible: "You are not on this poll's roll.",
  alreadyIssued: "Your voting ticket for this poll was already issued.",
  ticketHeld: "Your VTA already holds a ticket for this poll.",
  notFound: "Your VTA holds no ticket for this poll.",
  alreadyVoted: "You have already voted, and this poll does not allow changing a vote.",
  alreadyCounted: "That exact ballot was already counted.",
  ballotInvalid: "The ballot does not fit the poll's questions.",
  manifestMismatch: "The poll changed since it was read; read it again.",
  electionChanged: "The poll changed since it was read; read it again.",
  earlyCloseNotAllowed: "This poll cannot be closed before its deadline.",
  notTallied: "No result yet: the poll is still open and does not show running totals.",
  memberNotHeld: "Your VTA does not hold keys for the member DID given (set POLL_MEMBER_DID).",
  rateLimited: "Rate limited; wait a few seconds.",
  network: "Nothing answered at that URL.",
};

export function explainPollRefusal(r: PollRefusal): string {
  const w = WORDS[r.code] ?? `Refused (${r.code}).`;
  const reason = typeof r.details?.reason === "string" ? ` (${r.details.reason})` : r.message && !WORDS[r.code] ? ` ${r.message}` : "";
  return w + reason;
}

/** One line for any thrown value: the plain words for a refusal, else the error's own message. */
export function describePollError(e: unknown): string {
  const r = pollRefusal(e);
  if (r) return explainPollRefusal(r);
  return e instanceof Error ? e.message : String(e);
}
