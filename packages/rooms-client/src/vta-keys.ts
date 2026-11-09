// VtaKeyOracle: the KeyService of the production path. The member's VTA holds the MLS group, the epoch keys and the
// room credentials; the page only ever sees presentations and plaintext it asked for. rooms/keys/{present,seal,open}
// are tried at 0.2 and stepped down to 0.1 only on an unsupportedVersion/unsupportedType refusal that allows it.
// [unverified] against a live VTA: no room exists in the local stack.
import { TrustTaskError } from "@starter/vta-client";
import { versionStepAllowed } from "@starter/vtc-client";
import { KEYS_TASK } from "./tasks.js";
import type { CommitSource, KeyService } from "./keys.js";
import { b64u, parseSealed, unb64u, type Presentation, type RoomAction, type SealedContent } from "./wire.js";

/** Anything with VtaClient's `call` (a VtaClient, or a fake in tests). */
export interface TaskCaller {
  call<R = any>(type: string, payload: Record<string, unknown>): Promise<R>;
}

export class VtaKeyOracle implements KeyService {
  /** Tasks the VTA refused at 0.2 in a way that allowed 0.1; later calls go straight to 0.1. */
  private readonly stepped = new Set<string>();

  constructor(private readonly vta: TaskCaller) {}

  private async call(v02: string, v01: string, payload: Record<string, unknown>): Promise<any> {
    if (this.stepped.has(v02)) return this.vta.call(v01, payload);
    try {
      return await this.vta.call(v02, payload);
    } catch (e) {
      if (e instanceof TrustTaskError && versionStepAllowed(e.body, "0.1")) {
        this.stepped.add(v02);
        return this.vta.call(v01, payload);
      }
      throw e;
    }
  }

  async present(roomId: string, action: RoomAction): Promise<{ presentation: Presentation; expiresAt?: string }> {
    const r = await this.call(KEYS_TASK.present, KEYS_TASK.presentV01, { roomId, action });
    const p = r?.presentation;
    if (!p || typeof p.membership !== "string" || !Array.isArray(p.authority)) throw new Error("rooms/keys/present returned no presentation");
    return { presentation: p, ...(typeof r.expiresAt === "string" ? { expiresAt: r.expiresAt } : {}) };
  }

  /** The rooms this VTA holds group state for, one entry per room and member it may act as (`rooms/keys/list/0.2`). Key custody, not membership. */
  async held(): Promise<{ roomId: string; member: string; epoch: number }[]> {
    const r = await this.vta.call(KEYS_TASK.list, {});
    return Array.isArray(r?.rooms) ? r.rooms.filter((x: any) => typeof x?.roomId === "string" && typeof x?.member === "string").map((x: any) => ({ roomId: x.roomId, member: x.member, epoch: Number(x.epoch) })) : [];
  }

  /** Apply one MLS commit the host served (`rooms/keys/commit/0.1`); a replay is not an error, the epoch just stays. */
  async applyCommit(roomId: string, commit: string, epoch: number): Promise<{ epoch: number }> {
    const r = await this.vta.call(KEYS_TASK.commit, { roomId, commit, epoch });
    if (typeof r?.epoch !== "number") throw new Error("rooms/keys/commit returned no epoch");
    return r;
  }

  /**
   * Catch this member's group up to the room: ask the host for the commits above the epoch the VTA holds, apply them in order, repeat
   * until the host has no more. Without it, a member added after you joined makes records sealed at the new epoch unreadable.
   */
  async catchUp(roomId: string, source: CommitSource): Promise<{ applied: number; epoch?: number }> {
    let applied = 0;
    let epoch: number | undefined;
    for (let round = 0; round < 20; round++) {
      const mine = (await this.held()).filter((h) => h.roomId === roomId);
      if (!mine.length) break;
      const since = Math.min(...mine.map((h) => h.epoch));
      epoch = since;
      const page = await source.commits(roomId, since);
      if (!page.commits.length) break;
      for (const c of page.commits) {
        const before = epoch ?? since;
        let r: { epoch: number };
        try {
          r = await this.applyCommit(roomId, c.commit, c.epoch);
        } catch (e) {
          // The group is already past this commit (MLS WrongEpoch): it was applied by the Welcome that admitted us. Skip it.
          if (c.epoch <= before && /WrongEpoch/.test(JSON.stringify((e as { body?: unknown }).body ?? ""))) continue;
          throw e;
        }
        epoch = r.epoch;
        if (r.epoch > before) applied++; // a replay leaves the epoch where it was
      }
      if (page.roomEpoch !== undefined && epoch !== undefined && epoch >= page.roomEpoch) break;
    }
    return { applied, ...(epoch !== undefined ? { epoch } : {}) };
  }

  /** Join step 1 on a sealed room: the VTA mints an MLS KeyPackage for the offer's invitation (`rooms/keys/key-package/0.2`). */
  async keyPackage(roomId: string, invitation: string): Promise<{ keyPackage: string; expiresAt?: string; alreadyMinted?: boolean }> {
    const r = await this.vta.call(KEYS_TASK.keyPackage, { roomId, invitation });
    if (typeof r?.keyPackage !== "string") throw new Error("rooms/keys/key-package returned no keyPackage");
    return r;
  }

  /** Join step 3: hand the VTA the Welcome the host returned from `offers/accept` (`rooms/keys/welcome/0.1`); returns the epoch joined. */
  async welcome(roomId: string, welcome: string, invitation: string, ratchetTree?: string): Promise<{ epoch: number }> {
    const r = await this.vta.call(KEYS_TASK.welcome, { roomId, welcome, invitation, ...(ratchetTree ? { ratchetTree } : {}) });
    if (typeof r?.epoch !== "number") throw new Error("rooms/keys/welcome returned no epoch");
    return r;
  }

  async seal(roomId: string, key: string, version: number, plaintext: Uint8Array): Promise<SealedContent> {
    const r = await this.call(KEYS_TASK.seal, KEYS_TASK.sealV01, { roomId, key, version, plaintext: b64u(plaintext) });
    return parseSealed(r?.sealed);
  }

  async open(roomId: string, key: string, version: number, sealed: SealedContent): Promise<Uint8Array> {
    const r = await this.call(KEYS_TASK.open, KEYS_TASK.openV01, {
      roomId, key, version, sealed: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, epoch: sealed.epoch },
    });
    if (typeof r?.plaintext !== "string") throw new Error("rooms/keys/open returned no plaintext");
    return unb64u(r.plaintext);
  }
}
