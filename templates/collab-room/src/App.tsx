// The page: pick a room, then Chat / Notes / Files with a search bar and the live badge. The backend is the mock (default)
// or live (COLLAB_MODE=live); tests pass their own.
import { useEffect, useState } from "react";
import type { SessionItem } from "@buildathon/rooms-client";
import type { Backend, RoomRef } from "./backend.ts";
import { RoomContext, errorText, useRoom, useSession } from "./hooks.ts";
import { TABS, split, tabFor, type Tab } from "./state.ts";
import { Author } from "./components/Author.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { FilesView } from "./components/FilesView.tsx";
import { LiveBadge } from "./components/LiveBadge.tsx";
import { NotesView } from "./components/NotesView.tsx";
import { RoomPicker } from "./components/RoomPicker.tsx";
import { SearchBar } from "./components/SearchBar.tsx";

async function defaultBackend(): Promise<Backend> {
  if (__COLLAB_MODE__ === "live") return (await import("./live.ts")).createLiveBackend();
  return (await import("./mock.ts")).createMockBackend();
}

export function App({ backend: given }: { backend?: Backend }) {
  const [backend, setBackend] = useState<Backend | undefined>(given);
  const [rooms, setRooms] = useState<RoomRef[]>();
  const [room, setRoom] = useState<RoomRef>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (given) return;
    let live = true;
    let made: Backend | undefined;
    defaultBackend().then((b) => { made = b; if (live) setBackend(b); else b.close(); }, (e) => { if (live) setError(errorText(e)); });
    return () => { live = false; made?.close(); };
  }, [given]);

  useEffect(() => {
    if (!backend) return;
    let live = true;
    backend.rooms().then((rs) => { if (!live) return; setRooms(rs); setRoom((cur) => cur ?? rs[0]); }, (e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [backend]);

  const mode = backend?.mode ?? __COLLAB_MODE__;
  return (
    <div className="app">
      <a className="skip" href="#main">Skip to the room</a>
      <header className="topbar">
        <h1 className="title">Collaboration room</h1>
        <span className={`badge ${mode === "mock" ? "info" : "warn"}`} title={mode === "mock" ? "In-browser mock host: nothing leaves this page" : "Live VTC and VTA: unverified"}>
          {mode === "mock" ? "Mock mode" : "Live mode (unverified)"}
        </span>
      </header>
      {error && <p className="note bad" role="alert">{error}</p>}
      {!backend && !error && <p className="muted">{mode === "mock" ? "Setting up the demo rooms (real MLS for the sealed one)…" : "Connecting…"}</p>}
      {backend && rooms && (
        <div className="layout">
          <aside className="sidebar card">
            <h2>Rooms</h2>
            <RoomPicker rooms={rooms} current={room?.roomId} onPick={setRoom} />
            {mode === "mock" && <p className="muted small-text">Bob is simulated: he posts every few seconds, so the feed is visibly live.</p>}
          </aside>
          <main id="main" className="main">
            {room ? <RoomPane key={room.roomId} backend={backend} room={room} /> : <p className="muted">Pick a room.</p>}
          </main>
        </div>
      )}
    </div>
  );
}

function RoomPane({ backend, room }: { backend: Backend; room: RoomRef }) {
  const { session, error, loading } = useSession(backend, room);
  const view = useRoom(session);
  const [tab, setTab] = useState<Tab>("chat");
  const [focus, setFocus] = useState<string>();

  if (error) return <p className="note bad" role="alert">Could not open the room: {error}</p>;
  if (loading || !view) return <p className="muted">Opening {room.label}…</p>;
  const jump = (it: SessionItem) => { setTab(tabFor(it.kind)); setFocus(it.id); };
  const s = view.session;
  const parts = split(view.items);
  return (
    <RoomContext.Provider value={view}>
      <div className="room-head">
        <h2 className="room-title">{room.label}</h2>
        <span className={`chip tier-${s.visibility}`}>{s.sealed ? `sealed (${s.visibility})` : "open (plaintext)"}</span>
        <LiveBadge />
        <span className="small-text muted">Signed in as <Author did={s.self} /></span>
      </div>
      <SearchBar onJump={jump} />
      <div role="tablist" aria-label="Room sections" className="tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "selected" : ""} onClick={() => { setTab(t.id); setFocus(undefined); }}>
            {t.label} ({t.id === "chat" ? parts.chat.length : t.id === "notes" ? parts.notes.length : parts.files.length})
          </button>
        ))}
      </div>
      <div role="tabpanel" className="card">
        {tab === "chat" && <ChatView chat={parts.chat} focus={focus} />}
        {tab === "notes" && <NotesView notes={parts.notes} focus={focus} />}
        {tab === "files" && <FilesView files={parts.files} focus={focus} />}
      </div>
    </RoomContext.Provider>
  );
}
