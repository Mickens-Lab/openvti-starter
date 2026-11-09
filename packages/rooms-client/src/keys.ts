// The crypto boundary for rooms. Whoever holds the member's room credentials mints presentations; whoever holds the
// MLS group seals and opens records. In production both are the member's VTA (VtaKeyOracle); LocalMlsKeys runs a
// real MLS group in the page for the mock demo and tests.
import type { Presentation, RoomAction, SealedContent } from "./wire.js";

/** Where a key service gets the MLS commits it missed: the host's `rooms/epoch/commits` (HostClient implements it). */
export interface CommitSource {
  commits(roomId: string, sinceEpoch: number): Promise<{ commits: { epoch: number; commit: string }[]; roomEpoch?: number }>;
}

export interface KeyService {
  /**
   * Apply the commits this member's group state has not seen (members added or removed since), so records sealed at a later epoch
   * open. Optional: a key service that does not track epochs omits it. Returns how many commits were applied and the epoch reached.
   */
  catchUp?(roomId: string, source: CommitSource): Promise<{ applied: number; epoch?: number }>;
  /** A presentation for one action at one room. */
  present(roomId: string, action: RoomAction): Promise<{ presentation: Presentation; expiresAt?: string }>;
  /** Seal `plaintext` for record `key` at `version`, under the room's current epoch. */
  seal(roomId: string, key: string, version: number, plaintext: Uint8Array): Promise<SealedContent>;
  /** Open a sealed body; throws when this member has no key for its epoch or the AAD does not match. */
  open(roomId: string, key: string, version: number, sealed: SealedContent): Promise<Uint8Array>;
}

/**
 * The version a sealed body was bound to: `sealed.version` when the sealer recorded it, else the record's version.
 * [inferred] from SealedContent carrying an optional version (vti-rooms wire.rs); not checked against sealed.rs readers.
 */
export const sealedVersion = (recordVersion: number, sealed: SealedContent): number => sealed.version ?? recordVersion;
