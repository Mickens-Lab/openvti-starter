// Who wrote a record. Sources, in order:
//  1. the room's own profile records: the newest `profile` item whose record author IS its subject (anything else is
//     an impersonation and ignored; `private` rooms have no author, so this source never applies there);
//  2. the VTC directory card, for the current member only (the directory gives no DIDs of others);
//  3. a shortened DID with an identicon.
import { sha256 } from "@noble/hashes/sha2.js";
import { sniffImage, type ProfileEnvelope } from "./envelope.js";
import { unb64u, utf8 } from "./wire.js";

export interface ResolvedProfile {
  did: string;
  displayName?: string;
  /** A `data:` URL of the avatar, only when its bytes sniff as PNG, JPEG, GIF or WebP. */
  avatarUrl?: string;
  source: "room" | "card" | "fallback";
  /** First 8 and last 6 characters of the DID. */
  short: string;
  isSelf: boolean;
  /** What to show: "You", else the display name, else the short DID. */
  label: string;
  identicon: Identicon;
}

/** A 5x5 mirrored identicon: `cells[row][col]` filled, in `hsl(hue, 55%, 50%)`. */
export interface Identicon { hue: number; cells: boolean[][] }

export const shortDid = (did: string): string => (did.length <= 17 ? did : `${did.slice(0, 8)}…${did.slice(-6)}`);

export function identicon(did: string): Identicon {
  const h = sha256(utf8(did));
  const cells = Array.from({ length: 5 }, (_, r) => {
    const half = Array.from({ length: 3 }, (_, c) => (h[1 + r * 3 + c] & 1) === 1);
    return [half[0], half[1], half[2], half[1], half[0]];
  });
  return { hue: Math.round((h[0] / 256) * 360), cells };
}

/** The member's own card, from VTC `directory/card/show` (shape varies by community; map it in the caller). */
export type SelfCard = () => Promise<{ displayName?: string; avatar?: { mediaType: string; bytes: Uint8Array } } | undefined>;

function dataUrl(bytes: Uint8Array): string | undefined {
  const t = sniffImage(bytes);
  if (!t) return undefined;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `data:${t};base64,${btoa(s)}`;
}

export class ProfileResolver {
  private room = new Map<string, { version: number; p: ProfileEnvelope }>();
  private card?: Promise<Awaited<ReturnType<SelfCard>>>;

  constructor(private readonly o: { self?: string; selfCard?: SelfCard } = {}) {}

  /**
   * Offer a profile record seen in the room. Accepted only when the record's author is the profile's subject, and only
   * when newer than the one held. Returns whether it was accepted.
   */
  offer(p: ProfileEnvelope, author: string | undefined, version: number): boolean {
    if (!author || author !== p.subject) return false;
    const cur = this.room.get(p.subject);
    if (cur && cur.version >= version) return false;
    this.room.set(p.subject, { version, p });
    return true;
  }

  /** The room profile currently held for `did`, if any. */
  roomProfile(did: string): ProfileEnvelope | undefined {
    return this.room.get(did)?.p;
  }

  /** Resolve from what is held, without asking the VTC (room profile or fallback). */
  resolveSync(did: string): ResolvedProfile {
    const p = this.room.get(did)?.p;
    if (p) return this.make(did, "room", p.displayName, p.avatar ? unb64u(p.avatar.data) : undefined);
    return this.make(did, "fallback");
  }

  async resolve(did: string): Promise<ResolvedProfile> {
    const r = this.resolveSync(did);
    if (r.source === "room" || did !== this.o.self || !this.o.selfCard) return r;
    const card = await (this.card ??= this.o.selfCard().catch(() => undefined));
    if (!card?.displayName && !card?.avatar) return r;
    return this.make(did, "card", card.displayName, card.avatar?.bytes);
  }

  private make(did: string, source: ResolvedProfile["source"], displayName?: string, avatar?: Uint8Array): ResolvedProfile {
    const short = shortDid(did);
    const isSelf = did === this.o.self;
    const avatarUrl = avatar ? dataUrl(avatar) : undefined;
    return {
      did, source, short, isSelf, label: isSelf ? "You" : displayName || short, identicon: identicon(did),
      ...(displayName ? { displayName } : {}), ...(avatarUrl ? { avatarUrl } : {}),
    };
  }
}
