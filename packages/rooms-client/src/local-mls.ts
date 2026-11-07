// LocalMlsKeys: a real MLS (RFC 9420) group per room, in the page, on ts-mls with the suite vti-rooms pins.
// The record key is the MLS exporter secret (label openvtc/room/storage/v1, empty context, 32 bytes) and records are
// sealed as vti-rooms sealed.rs does: ChaCha20-Poly1305, a random 12-byte nonce, AAD "roomId|key|version|epoch",
// base64url without padding. [unverified] interop with openmls: no cross-implementation vector was run.
// A playground key store: its snapshot is key material (meant for IndexedDB under the page origin, memory in tests).
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  acceptAll, createCommit, createGroup, decodeGroupState, decodeMlsMessage, defaultCapabilities, defaultLifetime, emptyPskIndex,
  encodeGroupState, encodeMlsMessage, generateKeyPackage, getCiphersuiteFromName, getCiphersuiteImpl, joinGroup, mlsExporter,
  processMessage, type CiphersuiteImpl, type ClientState, type Credential, type KeyPackage, type PrivateKeyPackage,
} from "ts-mls";
import { defaultClientConfig } from "ts-mls/clientConfig.js";
import type { KeyService } from "./keys.js";
import { MLS_SUITE, STORAGE_EXPORTER_LABEL } from "./tasks.js";
import { b64u, fromUtf8, unb64u, utf8, type Presentation, type RoomAction, type SealedContent } from "./wire.js";

/** AAD bound into every sealed record (sealed.rs). */
export const recordAad = (roomId: string, key: string, version: number, epoch: number): Uint8Array => utf8(`${roomId}|${key}|${version}|${epoch}`);

/** Seal with a known 32-byte storage key. */
export function sealWithKey(storageKey: Uint8Array, roomId: string, key: string, version: number, epoch: number, plaintext: Uint8Array): SealedContent {
  const nonce = randomBytes(12);
  const ct = chacha20poly1305(storageKey, nonce, recordAad(roomId, key, version, epoch)).encrypt(plaintext);
  return { ciphertext: b64u(ct), nonce: b64u(nonce), epoch, version };
}

/** Open with a known 32-byte storage key; throws on any AAD, key or tag mismatch. */
export function openWithKey(storageKey: Uint8Array, roomId: string, key: string, version: number, sealed: SealedContent): Uint8Array {
  const nonce = unb64u(sealed.nonce);
  if (nonce.length !== 12) throw new Error("sealed nonce must be 12 bytes");
  return chacha20poly1305(storageKey, nonce, recordAad(roomId, key, version, sealed.epoch)).decrypt(unb64u(sealed.ciphertext));
}

interface RoomGroup {
  state: ClientState;
  /** Storage keys of every epoch this member was in (no EpochLink backfill). */
  keys: Map<number, Uint8Array>;
}

export interface LocalMlsOpts {
  /** Mints presentations; LocalMlsKeys holds no room credentials (the mock passes mockPresentation). */
  present?: (roomId: string, action: RoomAction) => Promise<{ presentation: Presentation; expiresAt?: string }>;
}

const identityOf = (c: Credential): string => (c.credentialType === "basic" ? fromUtf8(c.identity) : "");

let suite: Promise<CiphersuiteImpl> | undefined;
const cipherSuite = () => (suite ??= getCiphersuiteImpl(getCiphersuiteFromName(MLS_SUITE)));

export class LocalMlsKeys implements KeyService {
  private groups = new Map<string, RoomGroup>();
  /** Key packages handed out and not yet consumed by a Welcome. */
  private pending: { pub: KeyPackage; priv: PrivateKeyPackage; encoded: Uint8Array }[] = [];

  /** `memberId` (normally the member's DID) is the MLS basic credential identity. */
  constructor(readonly memberId: string, private readonly opts: LocalMlsOpts = {}) {}

  async present(roomId: string, action: RoomAction) {
    if (!this.opts.present) throw new Error("LocalMlsKeys has no presenter configured");
    return this.opts.present(roomId, action);
  }

  has(roomId: string): boolean {
    return this.groups.has(roomId);
  }

  epoch(roomId: string): number {
    return Number(this.group(roomId).state.groupContext.epoch);
  }

  /** Member identities in the current epoch, by leaf. */
  members(roomId: string): string[] {
    return this.group(roomId).state.ratchetTree.flatMap((n) => (n?.nodeType === "leaf" ? [identityOf(n.leaf.credential)] : []));
  }

  /** A fresh key package (an encoded `mls_key_package` message) for an owner to add this member with. */
  async keyPackage(): Promise<Uint8Array> {
    const kp = await generateKeyPackage({ credentialType: "basic", identity: utf8(this.memberId) }, defaultCapabilities(), defaultLifetime, [], await cipherSuite());
    const encoded = encodeMlsMessage({ keyPackage: kp.publicPackage, wireformat: "mls_key_package", version: "mls10" });
    this.pending.push({ pub: kp.publicPackage, priv: kp.privatePackage, encoded });
    return encoded;
  }

  /** Start a group for `roomId` with this member alone, at epoch 0. */
  async createRoom(roomId: string): Promise<void> {
    if (this.groups.has(roomId)) throw new Error(`already in a group for ${roomId}`);
    const cs = await cipherSuite();
    const kp = await generateKeyPackage({ credentialType: "basic", identity: utf8(this.memberId) }, defaultCapabilities(), defaultLifetime, [], cs);
    await this.setState(roomId, await createGroup(utf8(roomId), kp.publicPackage, kp.privatePackage, [], cs));
  }

  /** Add members by key package. Returns the Welcome for the new members and the commit for existing ones. */
  async addMembers(roomId: string, keyPackages: Uint8Array[]): Promise<{ welcome: Uint8Array; commit: Uint8Array; epoch: number }> {
    const proposals = keyPackages.map((b) => {
      const m = decodeMlsMessage(b, 0)?.[0];
      if (!m || m.wireformat !== "mls_key_package") throw new Error("not an MLS key package");
      return { proposalType: "add" as const, add: { keyPackage: m.keyPackage } };
    });
    const r = await this.commit(roomId, proposals);
    if (!r.welcome) throw new Error("commit produced no Welcome");
    return { welcome: encodeMlsMessage({ welcome: r.welcome, wireformat: "mls_welcome", version: "mls10" }), commit: r.commit, epoch: r.epoch };
  }

  /** Remove a member by identity. Returns the commit for the remaining members. */
  async removeMember(roomId: string, memberId: string): Promise<{ commit: Uint8Array; epoch: number }> {
    const tree = this.group(roomId).state.ratchetTree;
    const node = tree.findIndex((n) => n?.nodeType === "leaf" && identityOf(n.leaf.credential) === memberId);
    if (node < 0) throw new Error(`${memberId} is not in ${roomId}`);
    const r = await this.commit(roomId, [{ proposalType: "remove", remove: { removed: node / 2 } }]);
    return { commit: r.commit, epoch: r.epoch };
  }

  /** Join from a Welcome made for one of this member's key packages (the commit carries the ratchet tree). */
  async join(roomId: string, welcome: Uint8Array): Promise<void> {
    const m = decodeMlsMessage(welcome, 0)?.[0];
    if (!m || m.wireformat !== "mls_welcome") throw new Error("not an MLS Welcome");
    const cs = await cipherSuite();
    for (let i = 0; i < this.pending.length; i++) {
      const kp = this.pending[i];
      try {
        const state = await joinGroup(m.welcome, kp.pub, kp.priv, emptyPskIndex, cs);
        this.pending.splice(i, 1);
        await this.setState(roomId, state);
        return;
      } catch { /* not for this key package */ }
    }
    throw new Error("the Welcome is for none of this member's key packages");
  }

  /** Apply an owner's commit. A member the commit removes keeps its old keys and gets no new epoch. */
  async applyCommit(roomId: string, commit: Uint8Array): Promise<{ removed: boolean; epoch: number }> {
    const m = decodeMlsMessage(commit, 0)?.[0];
    if (!m || (m.wireformat !== "mls_private_message" && m.wireformat !== "mls_public_message")) throw new Error("not an MLS commit");
    const r = await processMessage(m, this.group(roomId).state, emptyPskIndex, acceptAll, await cipherSuite());
    const removed = r.newState.groupActiveState.kind === "removedFromGroup";
    if (removed) this.group(roomId).state = r.newState;
    else await this.setState(roomId, r.newState);
    return { removed, epoch: Number(r.newState.groupContext.epoch) };
  }

  async seal(roomId: string, key: string, version: number, plaintext: Uint8Array): Promise<SealedContent> {
    const g = this.group(roomId);
    if (g.state.groupActiveState.kind !== "active") throw new Error(`no longer a member of ${roomId}`);
    const epoch = Number(g.state.groupContext.epoch);
    return sealWithKey(g.keys.get(epoch)!, roomId, key, version, epoch, plaintext);
  }

  async open(roomId: string, key: string, version: number, sealed: SealedContent): Promise<Uint8Array> {
    const k = this.group(roomId).keys.get(sealed.epoch);
    if (!k) throw new Error(`no key for ${roomId} epoch ${sealed.epoch}`);
    return openWithKey(k, roomId, key, version, sealed);
  }

  /** Serialise every group, epoch key and pending key package. This is key material. */
  snapshot(): string {
    return JSON.stringify({
      v: 1,
      memberId: this.memberId,
      groups: [...this.groups].map(([roomId, g]) => ({
        roomId, state: b64u(encodeGroupState(g.state)), keys: [...g.keys].map(([e, k]) => [e, b64u(k)]),
      })),
      pending: this.pending.map((p) => ({ encoded: b64u(p.encoded), init: b64u(p.priv.initPrivateKey), hpke: b64u(p.priv.hpkePrivateKey), sig: b64u(p.priv.signaturePrivateKey) })),
    });
  }

  static restore(snapshot: string, opts: LocalMlsOpts = {}): LocalMlsKeys {
    const s = JSON.parse(snapshot);
    if (s.v !== 1) throw new Error("unknown LocalMlsKeys snapshot version");
    const out = new LocalMlsKeys(s.memberId, opts);
    for (const g of s.groups) {
      const decoded = decodeGroupState(unb64u(g.state), 0);
      if (!decoded) throw new Error(`cannot decode the group state for ${g.roomId}`);
      out.groups.set(g.roomId, {
        state: { ...decoded[0], clientConfig: defaultClientConfig },
        keys: new Map(g.keys.map(([e, k]: [number, string]) => [e, unb64u(k)])),
      });
    }
    out.pending = s.pending.map((p: any) => {
      const m = decodeMlsMessage(unb64u(p.encoded), 0)?.[0];
      if (!m || m.wireformat !== "mls_key_package") throw new Error("bad pending key package");
      return { pub: m.keyPackage, priv: { initPrivateKey: unb64u(p.init), hpkePrivateKey: unb64u(p.hpke), signaturePrivateKey: unb64u(p.sig) }, encoded: unb64u(p.encoded) };
    });
    return out;
  }

  private group(roomId: string): RoomGroup {
    const g = this.groups.get(roomId);
    if (!g) throw new Error(`no MLS group for ${roomId}`);
    return g;
  }

  private async commit(roomId: string, extraProposals: any[]): Promise<{ welcome?: any; commit: Uint8Array; epoch: number }> {
    const g = this.group(roomId);
    const r = await createCommit({ state: g.state, cipherSuite: await cipherSuite() }, { extraProposals, ratchetTreeExtension: true });
    await this.setState(roomId, r.newState);
    return { welcome: r.welcome, commit: encodeMlsMessage(r.commit), epoch: Number(r.newState.groupContext.epoch) };
  }

  private async setState(roomId: string, state: ClientState): Promise<void> {
    const g = this.groups.get(roomId) ?? { state, keys: new Map<number, Uint8Array>() };
    g.state = state;
    const epoch = Number(state.groupContext.epoch);
    if (!g.keys.has(epoch)) g.keys.set(epoch, await mlsExporter(state.keySchedule.exporterSecret, STORAGE_EXPORTER_LABEL, new Uint8Array(), 32, await cipherSuite()));
    this.groups.set(roomId, g);
  }
}
