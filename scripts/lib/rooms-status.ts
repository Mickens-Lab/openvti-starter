// The rooms:status checklist: for each room offered to you, where you are and the one command to run next. Pure, so it is tested.
export interface OfferView { roomId: string; label?: string; visibility?: string; state?: string }
export interface StatusInput {
  /** True when a persona is configured (ROOM_PERSONA) or the identity is the app did:key. */
  persona: boolean;
  /** Whether the identity is an active member of the community. */
  member: boolean;
  offers: OfferView[];
  /** Room DIDs the VTA holds group state for, for this identity. */
  held: Set<string>;
}
export interface StatusLine { roomId: string; label: string; visibility: string; status: string; next: string }

export function communityNext(input: Pick<StatusInput, "persona" | "member">): string | undefined {
  if (input.member) return undefined;
  return input.persona
    ? "not a member yet: `npm run rooms:persona -- join`, then ask an admin to approve it"
    : "not a member yet: `npm run vtc:join`, then ask an admin to approve it";
}

export function statusLines(input: StatusInput): StatusLine[] {
  return input.offers.map((o) => {
    const visibility = o.visibility ?? "?";
    const base = { roomId: o.roomId, label: o.label ?? o.roomId, visibility };
    const sealed = visibility !== "open";
    if (sealed && !input.persona) {
      return { ...base, status: "offered to the app did:key", next: "a sealed room needs a persona: `npm run rooms:persona -- setup`, then have the room offered to the persona's DID" };
    }
    if (sealed && input.held.has(o.roomId)) return { ...base, status: "joined", next: `npm run rooms:post -- ${o.roomId} "hello"` };
    if (!sealed && (o.state === "accepted" || o.state === "admitted")) return { ...base, status: "joined", next: `npm run rooms:post -- ${o.roomId} "hello"` };
    return { ...base, status: "offered", next: `npm run rooms:accept -- ${o.roomId}` };
  });
}
