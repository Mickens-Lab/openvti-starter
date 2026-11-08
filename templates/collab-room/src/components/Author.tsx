// Who wrote an item: avatar (from the room profile, sniffed as an image) or an identicon, the display name or "You" or the
// short DID, and the full DID in a tooltip. Display names are untrusted text and render as text.
import type { ResolvedProfile } from "@starter/rooms-client";
import { useRoomContext } from "../hooks.ts";

export function Identicon({ p, size = 28 }: { p: ResolvedProfile; size?: number }) {
  const cell = size / 5;
  return (
    <svg className="avatar identicon" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <rect width={size} height={size} fill={`hsl(${p.identicon.hue}, 55%, 92%)`} />
      {p.identicon.cells.flatMap((row, r) => row.map((on, c) => on
        ? <rect key={`${r}-${c}`} x={c * cell} y={r * cell} width={cell} height={cell} fill={`hsl(${p.identicon.hue}, 55%, 50%)`} />
        : null))}
    </svg>
  );
}

export function Author({ did, compact }: { did?: string; compact?: boolean }) {
  const { session } = useRoomContext();
  if (!did) return <span className="author muted">Anonymous</span>;
  const p = session.profiles.resolveSync(did);
  const title = p.displayName && p.isSelf ? `${p.displayName}\n${did}` : did;
  return (
    <span className="author" title={title} data-did={did} data-source={p.source}>
      {p.avatarUrl ? <img className="avatar" src={p.avatarUrl} alt="" width={28} height={28} /> : <Identicon p={p} />}
      {!compact && <span className="author-name">{p.label}</span>}
    </span>
  );
}
