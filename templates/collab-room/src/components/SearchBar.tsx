// Two search modes, both in memory over decrypted content (no host search exists): "File names" and "Full text".
// Results show a snippet with <mark> highlights and jump to the item.
import { useEffect, useState } from "react";
import type { NameResult, SessionItem, TextResult } from "@buildathon/rooms-client";
import { errorText, useRoomContext } from "../hooks.ts";
import { SEARCH_MODES, highlight, resultLabel, type SearchMode } from "../state.ts";
import { Author } from "./Author.tsx";

type Result = { item: SessionItem; snippet: string; ranges: [number, number][] };

function Marked({ text, ranges }: { text: string; ranges: [number, number][] }) {
  return <>{highlight(text, ranges).map((s, i) => (s.mark ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}</>;
}

export function SearchBar({ onJump }: { onJump: (item: SessionItem) => void }) {
  const { session, tick } = useRoomContext();
  const [mode, setMode] = useState<SearchMode>("names");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const query = q.trim();
    if (!query) { setResults(undefined); return; }
    let live = true;
    const run = mode === "names"
      ? session.search(query, "names").then((rs: NameResult[]) => rs.map((r) => ({ item: r.item as SessionItem, snippet: r.name, ranges: r.ranges })))
      : session.search(query, "text").then((rs: TextResult[]) => rs.map((r) => ({ item: r.item, snippet: r.snippet, ranges: r.ranges })));
    run.then((rs) => { if (live) { setResults(rs); setError(undefined); } }, (e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [session, mode, q, tick]);

  return (
    <section className="search" aria-label="Room search">
      <div className="search-row">
        <div role="group" aria-label="Search mode" className="seg">
          {SEARCH_MODES.map((m) => (
            <button key={m.id} type="button" className="small" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>
          ))}
        </div>
        <label htmlFor="search-q" className="sr">Search</label>
        <input id="search-q" type="search" value={q} placeholder={mode === "names" ? "Search file names" : "Search chat, notes and text files"}
          onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="note bad" role="alert">{error}</p>}
      {results && (
        <ul className="results" aria-label="Search results">
          {results.length === 0 && <li className="muted">No matches.</li>}
          {results.map((r) => (
            <li key={`${r.item.id}-${r.snippet}`}>
              <button type="button" className="result" onClick={() => onJump(r.item)}>
                <span className="result-kind small-text muted">{resultLabel(r.item)}</span>{" "}
                <span className="snippet"><Marked text={r.snippet} ranges={r.ranges} /></span>{" "}
                <Author did={r.item.author} compact />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
