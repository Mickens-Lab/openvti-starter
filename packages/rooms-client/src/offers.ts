// Presentations built from a room offer. A host's `rooms/offers/list` item carries the credentials the room issued to the member
// (`authority`, `membership`, `invitation`), and a Presentation is just `{membership, authority: [leaf..root]}`. So an `open` room can be
// used without the member's VTA minting anything. That matters when the member DID is an app `did:key` the VTA does not hold as a
// persona: the VTA then refuses rooms/keys/present ("holds no AuthorityCredential ... to a persona you may act as").
// Verified live on an open room (a VTC 0.26.0): rooms/info, a post and a read back. Sealed rooms still need the VTA (keys.present).
import type { Presenter } from "./host.js";
import type { Presentation, RoomAction } from "./wire.js";

/** The parts of a `vtc/rooms/offers/list` item this module reads. */
export interface RoomOfferLike {
  roomId: string;
  visibility?: string;
  state?: string;
  credentials?: { authority?: string; membership?: string; invitation?: string };
}

/** The Presentation an offer's credentials make. Throws when the offer carries no membership or no authority credential. */
export function offerPresentation(offer: RoomOfferLike): Presentation {
  const c = offer.credentials;
  if (!c || typeof c.membership !== "string" || typeof c.authority !== "string") {
    throw new Error(`the offer for ${offer.roomId} carries no membership and authority credentials to present`);
  }
  return { membership: c.membership, authority: [c.authority] };
}

/** Looks up the member's offer for a room (normally from `vtc.roomOffers()`, cached by the caller). */
export type OfferLookup = (roomId: string) => Promise<RoomOfferLike | undefined> | RoomOfferLike | undefined;

/**
 * A Presenter that asks `primary` (normally `keys.present`, the member's VTA) first, and falls back to the offer's own credentials
 * only for an `open` room when `primary` fails. Sealed rooms never fall back: their records need the VTA's keys anyway, so the
 * primary's refusal is the real answer and is rethrown.
 */
export function offerFallbackPresenter(primary: Presenter, lookup: OfferLookup): Presenter {
  return async (roomId: string, action: RoomAction) => {
    try {
      return await primary(roomId, action);
    } catch (e) {
      const offer = await lookup(roomId);
      if (!offer || offer.visibility !== "open") throw e;
      try {
        return { presentation: offerPresentation(offer) };
      } catch {
        throw e;
      }
    }
  };
}
