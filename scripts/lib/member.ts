// The identity the app is a community member as, for every member-side script (vtc:status, vtc:leave, vtc:withdraw, vtc:profile,
// vtc:hello, vtc:refusals). It is the same one vtc:join applies with: the did:peer:2 in MODE=tunnel, the did:key otherwise
// (lib/applicant.ts). Using the plain did:key here looks up a member that does not exist in tunnel mode.
import { decodeCredential, seedFromMultibase, type Identity } from "@starter/vta-client";
import { applicant, applicantOverride } from "./applicant.js";
import { readTunnel } from "./compose.js";
import { die, env, mode } from "../env.js";

export function memberIdentity(cred: string): Identity {
  try {
    return applicant(seedFromMultibase(decodeCredential(cred).privateKeyMultibase), { mode: mode(), mediatorDid: readTunnel()?.mediatorDid, override: applicantOverride(env("VTC_APPLICANT")) }).identity;
  } catch (e) {
    return die((e as Error).message);
  }
}
