// Which identity applies to the community. MODE=tunnel: a did:peer:2 derived from the app credential's seed, whose
// TSPTransport service names the stack's mediator, so the VTC pushes the credential to it over TSP with no earlier contact.
// MODE=local and MODE=farm: the app's did:key (no mediator to name). VTC_APPLICANT=did:key in .env keeps the did:key in
// tunnel mode too (it is then reached only after it has spoken TSP to the VTC; tsp:listen does that). If the did:peer cannot
// be built (no mediator DID, or over the resolver's 1000-byte limit) the did:key applies and the note says why. docs/MESSAGING.md.
import { identityFromSeed, type Identity } from "@starter/vta-client";
import { didPeerFromSeed, type PeerIdentity } from "@starter/tsp-client";

export type ApplicantKind = "did:key" | "did:peer";

/** VTC_APPLICANT as an override: did:key or did:peer, or undefined when unset (the mode decides). A typo is refused. */
export function applicantOverride(envValue: string | undefined): ApplicantKind | undefined {
  const v = (envValue ?? "").trim().toLowerCase();
  if (!v) return undefined;
  if (v === "did:peer" || v === "peer") return "did:peer";
  if (v === "did:key" || v === "key") return "did:key";
  throw new Error(`VTC_APPLICANT must be did:key or did:peer, got ${JSON.stringify(envValue)}`);
}

export interface Applicant {
  kind: ApplicantKind;
  identity: Identity | PeerIdentity;
  /** The .env key that remembers this applicant's request id (different DIDs own different requests). */
  requestIdKey: "VTC_REQUEST_ID" | "VTC_PEER_REQUEST_ID";
  /** One line on how the credential can reach this applicant. */
  note: string;
  /** Set when MODE=tunnel wanted the did:peer but fell back to the did:key: why. */
  fallback?: string;
}

const KEY_TUNNEL_NOTE = "the VTC pushes the credential to a did:key over TSP only if it spoke TSP to the VTC recently (npm run tsp:listen does that first), otherwise over DIDComm.";

/** The applicant for `seed` in `mode`. `mediatorDid` is the stack's mediator (.vta/tunnel.json); `override` is VTC_APPLICANT. */
export function applicant(seed: Uint8Array, opts: { mode: string; mediatorDid?: string; override?: ApplicantKind }): Applicant {
  const asKey = (note: string, fallback?: string): Applicant => ({ kind: "did:key", identity: identityFromSeed(seed), requestIdKey: "VTC_REQUEST_ID", note, ...(fallback ? { fallback } : {}) });
  if (opts.mode !== "tunnel") {
    return asKey(`applicant is a did:key; MODE=${opts.mode} has no messaging stack here, so the credential is not pushed (the admin's decide response carries it).`);
  }
  if (opts.override === "did:key") return asKey(`applicant is a did:key (VTC_APPLICANT=did:key): ${KEY_TUNNEL_NOTE}`);
  let why: string;
  if (!opts.mediatorDid) {
    why = "no mediator DID in .vta/tunnel.json (is the tunnel stack up? npm run up -- --tunnel)";
  } else {
    try {
      return {
        kind: "did:peer",
        identity: didPeerFromSeed(seed, opts.mediatorDid),
        requestIdKey: "VTC_PEER_REQUEST_ID",
        note: "applicant is a did:peer:2 whose TSPTransport service names the stack's mediator: the VTC pushes the credential over TSP with no earlier contact. `npm run tsp:listen` receives it.",
      };
    } catch (e) {
      why = (e as Error).message;
    }
  }
  return asKey(`applicant is a did:key, because the did:peer:2 could not be built: ${why}. ${KEY_TUNNEL_NOTE}`, why);
}
