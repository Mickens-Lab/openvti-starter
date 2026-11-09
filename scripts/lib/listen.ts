// What tsp:listen saw, as counts and one closing line. Pure, so it is unit-tested. The tally itself lives in @starter/tsp-client
// (src/frames.ts), shared with the community dashboard's "Credential frames" panel.
import { ISSUE_TYPE, type Tally } from "@starter/tsp-client";
export { emptyTally, ISSUE_TYPE, record, type Frame, type Tally } from "@starter/tsp-client";

/** The closing line: did the credential arrive, and what that does (and does not) say about the join status. */
export function verdict(t: Tally, opts: { method: "did:key" | "did:peer"; related: boolean }): string {
  if (t.issues > 0) {
    return `RECEIVED ${t.issues} credential-exchange/issue frame(s) as the ${opts.method}${opts.related ? "" : " with no TSP contact first"}. The join status still says credentialsDelivered: false until the member sends its own credential back (vtc/members/vmc/0.1); that flag is not a frame receipt.`;
  }
  const why = opts.method === "did:peer"
    ? "Check the VTC log for \"trust-task push\" (via=tsp, or \"no matching protocol\"), that the request was approved while this ran, and that the DID's mediator is the VTC's mediator (same DID string)."
    : "A did:key names no mediator: the VTC pushes over TSP only after this DID spoke TSP to it (this run did that only if \"relationship accepted\" was printed). In MODE=tunnel the did:peer:2 applicant needs no earlier contact: unset VTC_APPLICANT=did:key.";
  return `NO credential frame arrived. ${why}`;
}
