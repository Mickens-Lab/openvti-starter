// did:key identities and credential bundles. No Node-only imports: this file
// runs in browsers too.
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";
import { didKeyFromPublicKey, signerFromPrivateKey, type Signer } from "@openvtc/trust-tasks-proof";

export interface Identity {
  /** `did:key:z6Mk...` (no fragment). */
  did: string;
  /** 32-byte Ed25519 seed. */
  seed: Uint8Array;
  signer: Signer;
  /**
   * Set on an identity whose key the caller does not hold (a persona DID the member's VTA holds). Clients that support it (VtcClient)
   * send each unsigned Trust Task document here instead of signing it with `signer`, and send back what comes out. `signer` then
   * throws, and `seed` is empty: anything that needs the private key (a self-issued credential, a SIOP token) cannot be done for it.
   */
  signRemote?: (unsigned: Record<string, unknown>, proofPurpose: string) => Promise<Record<string, unknown>>;
}

/** An identity whose signatures come from elsewhere (`signRemote`); it holds no key. */
export function remoteIdentity(did: string, signRemote: NonNullable<Identity["signRemote"]>): Identity {
  const refuse = (): never => { throw new Error(`${did} is signed remotely by its key holder; it has no local key`); };
  return {
    did,
    seed: new Uint8Array(0),
    signer: { curve: "ed25519", verificationMethod: `${did}#key-0`, did, sign: refuse },
    signRemote,
  };
}

export function identityFromSeed(seed: Uint8Array): Identity {
  const pub = ed25519.getPublicKey(seed);
  // didKeyFromPublicKey yields a verification-method id (did:key:z..#z..).
  const did = didKeyFromPublicKey({ curve: "ed25519", bytes: pub }).split("#")[0];
  return { did, seed, signer: signerFromPrivateKey("ed25519", seed) };
}

export function newIdentity(): Identity {
  return identityFromSeed(ed25519.utils.randomSecretKey());
}

/** Multicodec (ed25519-priv, 0x1300) + seed, base58btc multibase: the
 *  `privateKeyMultibase` a credential bundle carries. */
export function seedToMultibase(seed: Uint8Array): string {
  return "z" + base58.encode(Uint8Array.from([0x80, 0x26, ...seed]));
}

export function seedFromMultibase(mb: string): Uint8Array {
  const raw = base58.decode(mb.slice(1));
  return raw.length === 34 ? raw.slice(2) : raw;
}

/** Field layout of `vta_sdk::credentials::CredentialBundle`. */
export interface CredentialBundle {
  did: string;
  privateKeyMultibase: string;
  vtaDid: string;
  vtaUrl?: string;
}

export const encodeCredential = (c: CredentialBundle): string =>
  base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(c)));

export function decodeCredential(b64: string): CredentialBundle {
  return JSON.parse(new TextDecoder().decode(base64urlnopad.decode(b64.trim())));
}

export const identityFromCredential = (c: CredentialBundle): Identity =>
  identityFromSeed(seedFromMultibase(c.privateKeyMultibase));

/**
 * A self-issued SIOPv2 `id_token` (compact EdDSA JWS): `iss = sub = did`, `aud` the verifier's DID, `nonce` the
 * challenge it issued. The `kid` is the signing key's verification method: `did:key:z..#z..` for a did:key, and the
 * signer's own `verificationMethod` when it names one (a did:peer:2 applicant signs with `<did>#key-2`; the verifier
 * refuses any other id). Works in Node and browsers (noble, no crypto.subtle).
 */
export function siopIdToken(me: Identity, audience: string, nonce: string, ttlSeconds = 120): string {
  const enc = (o: unknown) => base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "EdDSA", typ: "JWT", kid: siopKid(me) });
  const body = enc({ iss: me.did, sub: me.did, aud: audience, nonce, iat: now, exp: now + ttlSeconds });
  const sig = ed25519.sign(new TextEncoder().encode(`${head}.${body}`), me.seed);
  return `${head}.${body}.${base64urlnopad.encode(sig)}`;
}

/** The id_token's `kid`: the signer's verification method when it belongs to `me.did`, else the did:key form. */
export function siopKid(me: Identity): string {
  const vm = me.signer?.verificationMethod;
  if (typeof vm === "string" && vm.startsWith(`${me.did}#`)) return vm;
  return `${me.did}#${me.did.slice("did:key:".length)}`;
}
