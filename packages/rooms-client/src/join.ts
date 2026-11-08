// Joining a room from an offer. An open room needs only the host's accept. A sealed room (attributed, private) is a three-party
// handshake: the member's VTA mints a KeyPackage for the offer's invitation, the host's accept turns it into a Welcome, and the VTA
// joins the group with that Welcome. Open rooms: verified live. The sealed handshake: [unverified live] (the VTA only acts for a
// persona DID it holds, so the offer must be addressed to one; docs/ROOMS.md).
import type { RoomOfferLike } from "./offers.js";

/** The slice of VtcClient this needs. */
export interface OfferAcceptor {
  acceptRoomOffer(roomId: string, keyPackage?: string): Promise<any>;
}
/** The slice of VtaKeyOracle this needs. */
export interface JoinKeys {
  keyPackage(roomId: string, invitation: string): Promise<{ keyPackage: string }>;
  welcome(roomId: string, welcome: string, invitation: string, ratchetTree?: string): Promise<{ epoch: number }>;
}

export interface JoinResult {
  roomId: string;
  sealed: boolean;
  /** The epoch the host admitted the member at; on a sealed tier, the epoch the VTA joined at (they should agree). */
  epoch: number;
  steps: string[];
}

export async function joinFromOffer(vtc: OfferAcceptor, keys: JoinKeys | undefined, offer: RoomOfferLike & { credentials?: { invitation?: string } }): Promise<JoinResult> {
  const roomId = offer.roomId;
  if (offer.visibility === "open") {
    const r = await vtc.acceptRoomOffer(roomId);
    return { roomId, sealed: false, epoch: Number(r?.epoch), steps: ["offers/accept"] };
  }
  const invitation = offer.credentials?.invitation;
  if (!invitation) throw new Error(`the offer for ${roomId} carries no invitation credential to join with`);
  if (!keys) throw new Error(`${roomId} is sealed (${offer.visibility}); joining needs the member's VTA (a key service)`);
  const kp = await keys.keyPackage(roomId, invitation);
  const acc = await vtc.acceptRoomOffer(roomId, kp.keyPackage);
  if (typeof acc?.welcome !== "string") throw new Error("rooms/offers/accept returned no Welcome for a sealed room");
  const joined = await keys.welcome(roomId, acc.welcome, invitation, typeof acc.ratchetTree === "string" ? acc.ratchetTree : undefined);
  return { roomId, sealed: true, epoch: joined.epoch, steps: ["rooms/keys/key-package", "offers/accept", "rooms/keys/welcome"] };
}
