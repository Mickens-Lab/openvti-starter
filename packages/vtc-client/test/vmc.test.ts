// The member's own MembershipCredential (vtc/members/vmc/0.1): its shape, its proof, and the payload sent. No VTC needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DataIntegrityProofVerifier } from "@openvtc/trust-tasks-proof";
import { digestMultibase, newIdentity } from "@starter/vta-client";
import { DTG_CONTEXTS, MemberVmcNotPossible, VTC_TASK, VtcClient, isBound, memberVmc, membershipGrantOf, signCredential } from "../src/index.js";

const VTC_DID = "did:webvh:Qmfake:localhost%3A8200";

test("memberVmc: DTG MembershipCredential from the member, naming the community, with no digest", () => {
  const vc = memberVmc({ memberDid: "did:key:z6MkMember", communityDid: VTC_DID, validFrom: new Date("2026-01-02T03:04:05Z") });
  assert.deepEqual(vc["@context"], ["https://www.w3.org/ns/credentials/v2", "https://registry.trustoverip.org/dtg/context/v1"]);
  assert.deepEqual(vc["@context"], [...DTG_CONTEXTS]);
  assert.deepEqual(vc.type, ["VerifiableCredential", "DTGCredential", "MembershipCredential"]);
  assert.equal(vc.issuer, "did:key:z6MkMember");
  assert.equal(vc.issuerScope, "directed");
  assert.equal(vc.validFrom, "2026-01-02T03:04:05Z");
  assert.deepEqual(vc.credentialSubject, { id: VTC_DID }); // no digestMultibase: stored unbound
  assert.match(String(vc.id), /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(vc.proof, undefined);
  assert.notEqual(memberVmc({ memberDid: "a", communityDid: "b" }).id, vc.id, "a fresh id each time");
  assert.equal(memberVmc({ memberDid: "a", communityDid: "b", id: "urn:uuid:fixed" }).id, "urn:uuid:fixed");
});

test("signCredential: eddsa-jcs-2022, assertionMethod, a key under the member's did:key, and it verifies", async () => {
  const me = newIdentity();
  const vc = signCredential(memberVmc({ memberDid: me.did, communityDid: VTC_DID }), me.signer);
  const proof = vc.proof as Record<string, string>;
  assert.equal(proof.type, "DataIntegrityProof");
  assert.equal(proof.cryptosuite, "eddsa-jcs-2022");
  assert.equal(proof.proofPurpose, "assertionMethod");
  assert.ok(proof.verificationMethod.startsWith(`${me.did}#`));
  const v = await new DataIntegrityProofVerifier().verifyDetailed(vc as any);
  assert.deepEqual(v, { valid: true });
  // Tampering with the subject breaks it.
  const bad = await new DataIntegrityProofVerifier().verifyDetailed({ ...vc, credentialSubject: { id: "did:example:other" } } as any);
  assert.equal(bad.valid, false);
});

test("signCredential refuses a credential issued by someone else (the VTC would refuse it too)", () => {
  const me = newIdentity();
  assert.throws(() => signCredential(memberVmc({ memberDid: "did:key:z6MkSomeoneElse", communityDid: VTC_DID }), me.signer), /not the signer/);
});

test("sendMembershipCredential posts vtc/members/vmc/0.1 with { vc } signed by the client and returns the receipt", async () => {
  const me = newIdentity();
  const seen: any[] = [];
  const f = (async (input: any, init?: any) => {
    const doc = JSON.parse(init.body);
    seen.push({ url: String(input), doc });
    return new Response(JSON.stringify({ type: doc.type + "#response", payload: { memberDid: me.did, vmcId: doc.payload.vc.id, status: "stored" } }));
  }) as typeof fetch;
  const c = new VtcClient("http://x", VTC_DID, me, f);
  const r = await c.sendMembershipCredential({ id: "urn:uuid:00000000-0000-4000-8000-000000000001" });
  assert.deepEqual(r, { memberDid: me.did, vmcId: "urn:uuid:00000000-0000-4000-8000-000000000001", status: "stored" });
  const { doc } = seen[0];
  assert.equal(seen[0].url, "http://x/v1/trust-tasks");
  assert.equal(doc.type, VTC_TASK.membersVmc);
  assert.equal(doc.type, "https://trusttasks.org/spec/vtc/members/vmc/0.1");
  assert.deepEqual(Object.keys(doc.payload), ["vc"], "no requestId unless asked");
  assert.equal(doc.payload.vc.issuer, me.did);
  assert.equal(doc.payload.vc.credentialSubject.id, VTC_DID);
  assert.equal(doc.payload.vc.proof.proofPurpose, "assertionMethod");
  assert.deepEqual(await new DataIntegrityProofVerifier().verifyDetailed(doc.payload.vc), { valid: true });
  await c.sendMembershipCredential({ requestId: "req-1" });
  assert.equal(seen[1].doc.payload.requestId, "req-1");
});

// The community's grant as the VTC issues it (dtg-credentials new_vmc: public scope), with a proof the digest must ignore.
const grantFor = (memberDid: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  "@context": [...DTG_CONTEXTS],
  type: ["VerifiableCredential", "DTGCredential", "MembershipCredential"],
  id: "urn:uuid:00000000-0000-4000-8000-0000000000aa",
  issuer: VTC_DID,
  issuerScope: "public",
  validFrom: "2026-01-01T00:00:00Z",
  validUntil: "2027-01-01T00:00:00.500Z",
  credentialSubject: { id: memberDid },
  proof: { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", proofValue: "zfake" },
  ...extra,
});

test("memberVmc with the grant: digestMultibase of the grant (proof excluded), validUntil capped at the grant's", () => {
  const grant = grantFor("did:key:z6MkMember");
  const vc = memberVmc({ memberDid: "did:key:z6MkMember", communityDid: VTC_DID, validFrom: new Date("2026-02-01T00:00:00Z"), grant });
  assert.deepEqual(vc.credentialSubject, { id: VTC_DID, digestMultibase: digestMultibase(grant) });
  const { proof: _p, ...unproofed } = grant;
  assert.equal((vc.credentialSubject as any).digestMultibase, digestMultibase(unproofed));
  assert.equal(vc.validUntil, "2027-01-01T00:00:00Z", "whole seconds, never after the grant");
  assert.equal(vc.issuerScope, "directed");
  assert.equal(isBound(vc), true);
  assert.equal(isBound(memberVmc({ memberDid: "a", communityDid: VTC_DID })), false);
  // No validUntil on the grant: none on the acknowledgement either.
  const open = memberVmc({ memberDid: "did:key:z6MkMember", communityDid: VTC_DID, grant: grantFor("did:key:z6MkMember", { validUntil: undefined }) });
  assert.equal("validUntil" in open && open.validUntil !== undefined, false);
});

test("memberVmc refuses a grant it cannot acknowledge, before anything is signed", () => {
  const m = "did:key:z6MkMember";
  const reason = (grant: Record<string, unknown>, now = new Date("2026-02-01T00:00:00Z")) => {
    try { memberVmc({ memberDid: m, communityDid: VTC_DID, validFrom: now, grant }); return "ok"; } catch (e) { assert.ok(e instanceof MemberVmcNotPossible); return e.reason; }
  };
  assert.equal(reason(grantFor(m)), "ok");
  assert.equal(reason(grantFor(m, { type: ["VerifiableCredential", "DTGCredential", "AuthorityCredential"] })), "notAMembershipGrant");
  assert.equal(reason(grantFor(m, { credentialSubject: { id: m, digestMultibase: "zQm" } })), "alreadyAnAcknowledgement");
  assert.equal(reason(grantFor("did:key:z6MkSomeoneElse")), "notTheGrantSubject");
  assert.equal(reason(grantFor(m, { issuer: "did:example:other" })), "notTheCommunity");
  assert.equal(reason(grantFor(m, { issuer: { id: VTC_DID } })), "ok");
  assert.equal(reason(grantFor(m, { issuerScope: "directed" })), "grantScope");
  assert.equal(reason(grantFor(m), new Date("2027-06-01T00:00:00Z")), "grantExpired");
});

test("membershipGrantOf: the MembershipCredential about this member in a credential-exchange/issue document, nothing else", () => {
  const m = "did:key:z6MkMember";
  const issue = (credential: unknown, type = "https://trusttasks.org/spec/credential-exchange/issue/0.1") => ({ type, payload: { credential_response: { credential } } });
  const grant = grantFor(m);
  assert.deepEqual(membershipGrantOf(issue(grant), m, VTC_DID), grant);
  assert.deepEqual(membershipGrantOf(issue(grant, "https://trusttasks.org/spec/credential-exchange/issue/0.1#request"), m, VTC_DID), grant);
  assert.equal(membershipGrantOf(issue(grantFor(m, { type: ["VerifiableCredential", "DTGCredential", "AuthorityCredential"] })), m, VTC_DID), undefined, "the role credential");
  assert.equal(membershipGrantOf(issue(grantFor("did:key:z6MkOther")), m, VTC_DID), undefined);
  assert.equal(membershipGrantOf(issue(grant), m, "did:example:other"), undefined);
  assert.equal(membershipGrantOf(issue(grant, "https://trusttasks.org/spec/messaging/ping/0.1"), m, VTC_DID), undefined);
  assert.equal(membershipGrantOf(issue("a string"), m, VTC_DID), undefined);
  assert.equal(membershipGrantOf(undefined, m, VTC_DID), undefined);
  // An expired grant is still returned: memberVmc says why it cannot be acknowledged.
  assert.deepEqual(membershipGrantOf(issue(grantFor(m, { validUntil: "2000-01-01T00:00:00Z" })), m, VTC_DID)?.id, grant.id);
});

test("sendMembershipCredential({ grant }) sends a bound credential, signed for assertionMethod", async () => {
  const me = newIdentity();
  const seen: any[] = [];
  const f = (async (_input: any, init?: any) => {
    const doc = JSON.parse(init.body);
    seen.push(doc);
    return new Response(JSON.stringify({ type: doc.type + "#response", payload: { memberDid: me.did, vmcId: doc.payload.vc.id, status: "stored" } }));
  }) as typeof fetch;
  const c = new VtcClient("http://x", VTC_DID, me, f);
  const grant = grantFor(me.did);
  await c.sendMembershipCredential({ grant });
  assert.equal(seen[0].payload.vc.credentialSubject.digestMultibase, digestMultibase(grant));
  assert.deepEqual(await new DataIntegrityProofVerifier().verifyDetailed(seen[0].payload.vc), { valid: true });
  await assert.rejects(c.sendMembershipCredential({ grant: grantFor("did:key:z6MkOther") }), MemberVmcNotPossible);
  assert.equal(seen.length, 1, "nothing sent for a grant that cannot be acknowledged");
});
