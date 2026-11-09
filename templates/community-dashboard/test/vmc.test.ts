// The membership credential this page sends back, signed by each identity the page can be: the did:key (local, farm,
// VTC_APPLICANT=did:key) and the did:peer:2 (tunnel). The VTC resolves the verificationMethod for assertionMethod and checks an
// eddsa-jcs-2022 proof over the credential minus its proof; this repeats that check with the key the DID publishes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBytes, fromMultibase } from "@openvtc/trust-tasks-proof";
import { identityFromSeed } from "@starter/vta-client";
import { didPeerFromSeed, parseDidPeer2 } from "@starter/tsp-client";
import { memberVmc, signCredential } from "@starter/vtc-client";

const seed = Uint8Array.from({ length: 32 }, (_, i) => 32 - i);
const COMMUNITY = "did:example:community";

/** eddsa-jcs-2022 verification: sha256(JCS(proof config)) || sha256(JCS(document minus proof)), Ed25519. */
function verifies(vc: Record<string, any>, publicKey: Uint8Array): boolean {
  const { proof, ...body } = vc;
  const { proofValue, ...config } = proof;
  const hashData = new Uint8Array([...sha256(canonicalBytes(config)), ...sha256(canonicalBytes(body))]);
  return ed25519.verify(fromMultibase(proofValue), hashData, publicKey);
}

for (const [name, me] of [
  ["did:key", identityFromSeed(seed)],
  ["did:peer:2", didPeerFromSeed(seed, "did:example:mediator")],
] as const) {
  test(`a ${name} member signs its membership credential for assertionMethod with a key under its own DID`, () => {
    const vc = signCredential(memberVmc({ memberDid: me.did, communityDid: COMMUNITY }), me.signer) as Record<string, any>;
    assert.equal(vc.issuer, me.did);
    assert.equal(vc.credentialSubject.id, COMMUNITY);
    assert.equal(vc.credentialSubject.digestMultibase, undefined);
    assert.equal(vc.proof.cryptosuite, "eddsa-jcs-2022");
    assert.equal(vc.proof.proofPurpose, "assertionMethod");
    assert.equal(vc.proof.verificationMethod.split("#")[0], me.did);
    if (name === "did:peer:2") {
      assert.equal(vc.proof.verificationMethod, `${me.did}#key-2`);
      // The key the did:peer publishes (its V key) is the one that verifies.
      const v = parseDidPeer2(me.did).keys.find((k) => k.purpose === "V")!;
      assert.ok(verifies(vc, v.publicKey));
    } else {
      assert.ok(verifies(vc, ed25519.getPublicKey(seed)));
    }
    assert.equal(verifies({ ...vc, issuerScope: "public" }, ed25519.getPublicKey(seed)), false, "a changed credential does not verify");
  });
}
