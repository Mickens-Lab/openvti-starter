// The rooms to open: the seeded rooms in mock mode, vtc/rooms/memberships/list (admitted) or COLLAB_ROOM in live mode.
import type { RoomRef } from "../backend.ts";

export function RoomPicker({ rooms, current, onPick }: { rooms: RoomRef[]; current?: string; onPick: (r: RoomRef) => void }) {
  if (rooms.length === 0) return <p className="muted">No rooms. In live mode a room appears once a community admits you to one.</p>;
  return (
    <nav aria-label="Rooms">
      <ul className="rooms">
        {rooms.map((r) => (
          <li key={r.roomId}>
            <button type="button" className={`room${r.roomId === current ? " selected" : ""}`} aria-current={r.roomId === current} onClick={() => onPick(r)}>
              <span className="room-label">{r.label}</span>
              {r.visibility && <span className={`chip tier-${r.visibility}`}>{r.visibility === "open" ? "open" : `sealed: ${r.visibility}`}</span>}
            </button>
            {r.description && <p className="muted small-text">{r.description}</p>}
          </li>
        ))}
      </ul>
    </nav>
  );
}
