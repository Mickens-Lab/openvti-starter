// MockKeyOracle: answers rooms/keys/{present,seal,open} the way a member's VTA would, with a LocalMlsKeys behind it,
// so VtaKeyOracle's wire (including the 0.2 -> 0.1 step down) runs end to end without a VTA.
import { TT, TrustTaskError } from "@buildathon/vta-client";
import { KEYS_TASK } from "../tasks.js";
import type { LocalMlsKeys } from "../local-mls.js";
import { b64u, parseSealed, unb64u, type RoomAction } from "../wire.js";
import type { TaskCaller } from "../vta-keys.js";
import { mockPresentation } from "./host.js";

const ERROR_TYPE = `${TT}/trust-task-error/0.5`;

export interface MockKeyOracleOpts {
  /** Versions served (default both). Serve only "0.1" to exercise the step down. */
  versions?: ("0.1" | "0.2")[];
  /** Presentation lifetime (default 4 hours, as vti-rooms-wasm). */
  ttlMs?: number;
  now?: () => number;
}

export class MockKeyOracle implements TaskCaller {
  readonly calls: string[] = [];

  /** `subject` is the member DID presentations are minted for (the DID that signs host documents). */
  constructor(readonly keys: LocalMlsKeys, readonly subject: string, private readonly o: MockKeyOracleOpts = {}) {}

  async call<R = any>(type: string, p: any): Promise<R> {
    this.calls.push(type);
    const version = type.slice(type.lastIndexOf("/") + 1);
    const served = this.o.versions ?? ["0.1", "0.2"];
    const task = type.slice(0, type.lastIndexOf("/"));
    const known = Object.values(KEYS_TASK).some((t) => t.startsWith(task + "/"));
    if (!known) throw new TrustTaskError(400, { type: ERROR_TYPE, payload: { code: "unsupportedType", message: type } });
    if (!served.includes(version as "0.1")) {
      throw new TrustTaskError(400, { type: ERROR_TYPE, payload: { code: "unsupportedVersion", message: type, details: { servedVersions: served.map((v) => `${task}/${v}`) } } });
    }
    const fail = (code: string, message: string) => { throw new TrustTaskError(400, { type: ERROR_TYPE, payload: { code, message } }); };
    if (!this.keys.has(String(p.roomId))) fail("rooms:notAMember", `no group for ${p.roomId}`);
    const now = this.o.now?.() ?? Date.now();
    switch (task) {
      case `${TT}/rooms/keys/present`:
        return { presentation: mockPresentation(p.roomId, this.subject, p.action as RoomAction), expiresAt: new Date(now + (this.o.ttlMs ?? 4 * 3600_000)).toISOString() } as R;
      case `${TT}/rooms/keys/seal`:
        return { sealed: await this.keys.seal(p.roomId, p.key, Number(p.version), unb64u(p.plaintext)) } as R;
      case `${TT}/rooms/keys/open`:
        try {
          return { plaintext: b64u(await this.keys.open(p.roomId, p.key, Number(p.version), parseSealed(p.sealed))) } as R;
        } catch (e) {
          return fail("rooms:openFailed", String((e as Error).message));
        }
    }
    throw new Error("unreachable");
  }
}
