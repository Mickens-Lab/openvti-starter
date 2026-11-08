// COLLAB_MODE=live. UNVERIFIED LIVE: no room exists in the local stack, and joining one needs community rooms, which local
// mode leaves off (docs/plans/2026-11-07-dataroom-collab-plan.md, sections 1.7 and 4). The wiring follows the pinned schemas:
//  - the identity is the app credential (VTA_CREDENTIAL, as in community-dashboard), signing as its did:key;
//  - rooms come from vtc/rooms/memberships/list (admitted ones), or COLLAB_ROOM names one directly;
//  - rooms/* go to the VTC over /__vtc (HostClient over vtcTransport);
//  - presentations, seals and opens come from the member's VTA over /__vta (VtaKeyOracle over VtaClient: rooms/keys/*).
import { HostClient, RoomSession, VtaKeyOracle, offerFallbackPresenter, vtcTransport, type RoomOfferLike, type Visibility } from "@buildathon/rooms-client";
import { VtaClient, decodeCredential, identityFromCredential } from "@buildathon/vta-client";
import { VtcClient } from "@buildathon/vtc-client";
import type { Backend, RoomRef } from "./backend.ts";
import { admitted } from "./state.ts";

const abs = (u: string) => (u.startsWith("/") ? location.origin + u : u);

interface Membership { roomId: string; label?: string; description?: string; visibility?: Visibility; state?: string }

export async function createLiveBackend(): Promise<Backend> {
  const credential = import.meta.env.VTA_CREDENTIAL || undefined;
  if (!credential) throw new Error("Live mode needs the app credential. Run `npm run up` at the repo root, then restart the dev server (or unset COLLAB_MODE for the mock demo).");
  const me = identityFromCredential(decodeCredential(credential));
  const vtc = await VtcClient.connect(abs(__VTC_BROWSER_URL__), me, undefined, import.meta.env.VTC_DID || undefined);
  const vta = await VtaClient.fromCredential(credential, abs(__VTA_BROWSER_URL__), undefined, { resolveDid: !__FARM__ });
  try { await vta.authenticate(); } catch { /* rooms/keys/* are signed documents; a session is not required for them [unverified] */ }
  const keys = new VtaKeyOracle(vta);
  // Presentations come from the member's VTA. On an open room, when the VTA refuses (the member DID is the app did:key, which it does
  // not hold as a persona), the offer's own credentials are presented instead; sealed rooms never fall back. Verified live on an open room.
  let offers: Promise<RoomOfferLike[]> | undefined;
  const offerFor = async (roomId: string) => (await (offers ??= vtc.roomOffers().then((r: any) => (r.items ?? []) as RoomOfferLike[]))).find((o) => o.roomId === roomId);
  const host = new HostClient(vtcTransport(vtc), offerFallbackPresenter((roomId, action) => keys.present(roomId, action), offerFor));

  return {
    mode: "live",
    self: me.did,
    async rooms(): Promise<RoomRef[]> {
      if (__COLLAB_ROOM__) return [{ roomId: __COLLAB_ROOM__, label: __COLLAB_ROOM__ }];
      const out: Membership[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = (await vtc.roomMemberships(cursor ? { cursor } : {})) as { items?: Membership[]; nextCursor?: string };
        out.push(...(r.items ?? []));
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      return admitted(out).map((m) => ({
        roomId: m.roomId,
        label: m.label || m.roomId,
        ...(m.visibility ? { visibility: m.visibility } : {}),
        ...(m.description ? { description: m.description } : {}),
      }));
    },
    open: (ref) => RoomSession.open({ roomId: ref.roomId, host, keys, self: me.did }),
    close: () => {},
  };
}
