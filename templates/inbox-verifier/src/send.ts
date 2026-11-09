// Build, sign and POST a note. Shows the three outcomes a verifier must get right.
//   npm run send -w @starter/inbox-verifier [-- --replay | --tamper]
import { signTrustTask } from "@openvtc/trust-tasks-proof";
import { newIdentity, purposeFor, rfc3339, type Identity } from "@starter/vta-client";
import { NOTE_TYPE } from "./inbox.js";

/** A signed note. `type` is for tests and the demo (a document of another type that the inbox must refuse). */
export function makeNote(me: Identity, recipient: string, title: string, body: string, type: string = NOTE_TYPE) {
  return signTrustTask(
    {
      id: crypto.randomUUID(),
      type,
      issuer: me.did,
      recipient,
      issuedAt: rfc3339(),
      payload: { title, body },
    } as any,
    me.signer,
    { proofPurpose: purposeFor(type) }, // authentication: a note is an ordinary request
  );
}

export async function post(url: string, doc: unknown) {
  const res = await fetch(`${url}/inbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.INBOX_URL ?? "http://127.0.0.1:4000";
  const { did } = await (await fetch(`${url}/did`)).json();
  const me = newIdentity(); // swap for identityFromCredential(...) to send as your VTA-provisioned app
  const doc = makeNote(me, did, "hello", "signed offline, verified offline") as any;
  if (process.argv.includes("--tamper")) doc.payload.body = "changed after signing";
  const first = await post(url, doc);
  console.log("send   ->", first.status, JSON.stringify(first.body));
  if (process.argv.includes("--replay")) {
    const again = await post(url, doc);
    console.log("replay ->", again.status, JSON.stringify(again.body));
  }
}
