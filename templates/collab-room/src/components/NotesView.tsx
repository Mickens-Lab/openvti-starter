// Notes: a list (newest first) and an editor. Saving an existing note writes a new version (its own create-only record);
// the newest version wins for everyone.
import { useEffect, useState } from "react";
import type { SessionItem } from "@buildathon/rooms-client";
import { errorText, useRoomContext } from "../hooks.ts";
import { canSave, draftOf, emptyDraft, formatTime, isDirty, type NoteDraft } from "../state.ts";
import { Author } from "./Author.tsx";
import { ItemBody } from "./ItemBody.tsx";

export function NotesView({ notes, focus }: { notes: SessionItem[]; focus?: string }) {
  const { session } = useRoomContext();
  const [selected, setSelected] = useState<string | undefined>(focus ?? notes[0]?.id);
  const [draft, setDraft] = useState<NoteDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (focus) { setSelected(focus); setDraft(undefined); } }, [focus]);

  const current = notes.find((n) => n.id === selected);
  const versions = current ? session.history(current.id).length : 0;

  const save = async () => {
    if (!draft || !canSave(draft, busy)) return;
    setBusy(true); setError(undefined);
    try {
      const it = await session.saveNote(draft.title.trim(), draft.body, draft.id);
      setSelected(it.id);
      setDraft(undefined);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <section className="notes" aria-label="Notes">
      <div className="notes-list">
        <button type="button" className="small" onClick={() => { setDraft(emptyDraft()); setSelected(undefined); }}>New note</button>
        <ul>
          {notes.map((n) => (
            <li key={n.id}>
              <button type="button" className={`linklike${n.id === selected ? " selected" : ""}`} aria-current={n.id === selected}
                onClick={() => { setSelected(n.id); setDraft(undefined); }}>
                {n.envelope.kind === "note" ? n.envelope.title : n.id}
              </button>
            </li>
          ))}
          {notes.length === 0 && <li className="muted">No notes yet.</li>}
        </ul>
      </div>
      <div className="notes-main">
        {draft ? (
          <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label htmlFor="note-title">Title</label>
            <input id="note-title" type="text" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <label htmlFor="note-body">Body (markdown)</label>
            <textarea id="note-body" rows={12} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            <button type="submit" className="primary" disabled={!canSave(draft, busy) || !isDirty(draft, current)}>{draft.id ? "Save new version" : "Save note"}</button>
            <button type="button" onClick={() => setDraft(undefined)}>Cancel</button>
            {error && <p className="note bad" role="alert">{error}</p>}
          </form>
        ) : current ? (
          <article className={`note-view${current.id === focus ? " focused" : ""}`} data-id={current.id}>
            <p className="muted small-text">
              <Author did={current.author} /> · {formatTime(current.envelope.clientTs)} · version {versions}
            </p>
            <ItemBody item={current} />
            <button type="button" onClick={() => setDraft(draftOf(current))}>Edit</button>
          </article>
        ) : <p className="muted">Pick a note or start a new one.</p>}
      </div>
    </section>
  );
}
