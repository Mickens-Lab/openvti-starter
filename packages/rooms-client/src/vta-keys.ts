// VtaKeyOracle: the KeyService of the production path. The member's VTA holds the MLS group, the epoch keys and the
// room credentials; the page only ever sees presentations and plaintext it asked for. rooms/keys/{present,seal,open}
// are tried at 0.2 and stepped down to 0.1 only on an unsupportedVersion/unsupportedType refusal that allows it.
// [unverified] against a live VTA: no room exists in the local stack.
import { TrustTaskError } from "@buildathon/vta-client";
import { versionStepAllowed } from "@buildathon/vtc-client";
import { KEYS_TASK } from "./tasks.js";
import type { KeyService } from "./keys.js";
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
