// The consumer pipeline for one Trust Task. Pure: no HTTP, no network, so the
// same function serves the server, the demo and the tests.
import {
  InMemoryReplayGuard,
  UnauthenticatedTransport,
  consequentialChecks,
  consumeInbound,
  refuse,
  respondWith,
  tryParseTypeUri,
  type RejectReason,
  type SpecPolicy,
  type TrustTaskDocument,
} from "@openvtc/trust-tasks/runtime";
import { DataIntegrityProofVerifier } from "@openvtc/trust-tasks-proof";
import { isRequestOf, isSigningPurpose, rfc3339 } from "@starter/vta-client";

/** A made-up Trust Task for the buildathon. Replace with your own, or pin a
 *  registry task with `trust-tasks generate` (see the README). */
export const NOTE_TYPE = "https://example.org/spec/buildathon/note/0.1";
export const NOTE_RESPONSE = `${NOTE_TYPE}#response`;

export interface NotePayload {
  title: string;
  body: string;
}
export interface NoteReceipt {
  noteId: string;
  receivedAt: string;
}

/** What the framework needs to know about the task (what generated modules
 *  export as SPEC). A note changes state, so it is consequential: proof and
 *  recipient are required and replays must not run twice. */
export const NOTE_SPEC: SpecPolicy = {
  typeUri: NOTE_TYPE,
  isBearer: false,
  isProofRequired: true,
  isRecipientRequired: true,
  isIssuedAtRequired: true,
  // Carried with the spec so the validator has something to check against.
  payloadSchema: {
    type: "object",
    required: ["title", "body"],
    properties: { title: { type: "string", minLength: 1 }, body: { type: "string" } },
  },
};

/** Hand-rolled check of the schema above (SPEC 7.2 item 2). With ajv, call
 *  ajv.validate(schema, payload) here instead. */
const validateNote = {
  validate: (_schema: unknown, p: unknown) => {
    const n = p as Partial<NotePayload> | null;
    const errors: string[] = [];
    if (typeof n?.title !== "string" || !n.title) errors.push("title: required string");
    if (typeof n?.body !== "string") errors.push("body: required string");
    return { ok: errors.length === 0, errors };
  },
};

export interface StoredNote extends NoteReceipt {
  from: string;
  title: string;
  body: string;
}

export type Verdict =
  | { kind: "accepted"; response: unknown }
  | { kind: "duplicate"; response?: unknown; inFlight?: boolean }
  | { kind: "rejected"; code: string; message: string; error: unknown }
  | { kind: "suppressed"; reason: string };

/**
 * Dispatch (SPEC 7.2 item 3): this inbox serves one task, so only a REQUEST of the note type gets through, in either form
 * (`NOTE_TYPE` or `NOTE_TYPE#request`, SPEC 4.4.1 rule 1). Everything else is refused before any other check: a
 * `#response`, a `trust-task-error`, another task's document (`unsupportedType`), or the note task at another version
 * (`unsupportedVersion`). Without this a signed document of any type with a note-shaped payload would be stored as a note.
 * Returns null when the type is served.
 */
export function typeRefusal(type: unknown): RejectReason | null {
  if (isRequestOf(type, NOTE_TYPE)) return null;
  const served = tryParseTypeUri(NOTE_TYPE)!;
  const t = typeof type === "string" ? tryParseTypeUri(type) : null;
  if (t && t.authority === served.authority && t.slug === served.slug && t.variant !== "response" && (t.major !== served.major || t.minor !== served.minor)) {
    return { code: "unsupportedVersion", message: `this inbox serves ${NOTE_TYPE} only`, retryable: false, details: { servedVersions: [NOTE_TYPE] } };
  }
  return { code: "unsupportedType", message: `this inbox serves requests of ${NOTE_TYPE} only`, retryable: false };
}

/**
 * The proof verifier, plus the check `@openvtc/trust-tasks-proof` 0.1.6 leaves out: SPEC 4.7.3 item 1 says a consumer MUST
 * reject a proof whose `proofPurpose` is `keyAgreement` or names no signing relationship. The library checks that a purpose
 * is present, not what it says. (For a did:key both would name the same Ed25519 key; the check matters for DIDs with
 * separate keys per relationship, and so that this template teaches it as done.) A refused purpose is `proofInvalid`.
 */
export const purposeCheckingVerifier = {
  base: new DataIntegrityProofVerifier(),
  async verify(doc: TrustTaskDocument<unknown>): Promise<boolean> {
    const purpose = (doc as { proof?: { proofPurpose?: unknown } }).proof?.proofPurpose;
    if (!isSigningPurpose(purpose)) return false;
    return this.base.verify(doc);
  },
};

export function createInbox(myDid: string) {
  const guard = new InMemoryReplayGuard(); // one per process; use a shared store for replicas
  const notes: StoredNote[] = [];

  async function receive(doc: TrustTaskDocument<NotePayload>): Promise<Verdict> {
    const wrongType = typeRefusal((doc as { type?: unknown } | null)?.type);
    if (wrongType) {
      const error = refuse(doc, crypto.randomUUID(), wrongType, rfc3339);
      return { kind: "rejected", code: wrongType.code, message: wrongType.message, error };
    }
    const outcome = await consumeInbound<NotePayload, NoteReceipt>({
      // Nothing authenticates the sender below the document, so identity is the
      // proof's did:key. Behind an authenticating gateway, use StaticTransport.
      transport: new UnauthenticatedTransport(),
      spec: NOTE_SPEC,
      proofPolicy: { kind: "verify", verify: purposeCheckingVerifier },
      payloadPolicy: { kind: "validate", validate: validateNote },
      checks: consequentialChecks(guard),
      doc,
      myVid: myDid,
      now: Date.now(),
      newErrorId: () => crypto.randomUUID(),
      handler: (accepted) => {
        const receipt = { noteId: crypto.randomUUID(), receivedAt: rfc3339() };
        notes.push({ ...receipt, from: accepted.issuer!, ...accepted.payload });
        const res = respondWith(accepted, crypto.randomUUID(), receipt);
        return { ...res, type: NOTE_RESPONSE };
      },
    });
    switch (outcome.kind) {
      case "handled":
        return { kind: "accepted", response: outcome.response };
      case "rejected": {
        const p = (outcome.error as any).payload ?? {};
        return { kind: "rejected", code: String(p.code ?? "unknown"), message: String(p.message ?? ""), error: outcome.error };
      }
      case "duplicate":
        return { kind: "duplicate", response: outcome.priorResponse, inFlight: outcome.inFlight };
      case "suppressed":
        return { kind: "suppressed", reason: String(outcome.reason) };
      default:
        return { kind: "accepted", response: undefined };
    }
  }
  return { receive, notes };
}
