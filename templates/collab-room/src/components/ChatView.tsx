// Chat history ascending by host version, "Load older" for history beyond the window, auto-scroll only when the reader is
// at the bottom (or the newest message is their own), and a composer with a plain/markdown toggle.
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { SessionItem } from "@buildathon/rooms-client";
import { byDataId, errorText, useRoomContext } from "../hooks.ts";
import { CHAT_PAGE, atBottom, canSend, chatWindow, formatTime, loadOlder, shouldAutoScroll, toggleFormat, type ChatFormat } from "../state.ts";
import { Author } from "./Author.tsx";
import { ItemBody } from "./ItemBody.tsx";

export function ChatView({ chat, focus }: { chat: SessionItem[]; focus?: string }) {
  const { session } = useRoomContext();
  const [shown, setShown] = useState(CHAT_PAGE);
  const [text, setText] = useState("");
  const [format, setFormat] = useState<ChatFormat>("text/plain");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const list = useRef<HTMLOListElement>(null);
  const wasAtBottom = useRef(true);
  const lastNewest = useRef<number>();

  // A jump to an older message widens the window to include it.
  const focusIdx = focus ? chat.findIndex((c) => c.id === focus) : -1;
  const need = focusIdx >= 0 ? chat.length - focusIdx : 0;
  const effShown = Math.max(shown, need);
  const { visible, older } = chatWindow(chat, effShown);
  const newest = chat[chat.length - 1];

  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !newest) return;
    if (lastNewest.current !== newest.version) {
      const first = lastNewest.current === undefined;
      lastNewest.current = newest.version;
      if (first || shouldAutoScroll(wasAtBottom.current, newest.mine)) el.scrollTop = el.scrollHeight;
    }
  }, [newest]);

  useLayoutEffect(() => {
    if (!focus) return;
    byDataId(list.current, focus)?.scrollIntoView?.({ block: "center" });
  }, [focus]);

  const send = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!canSend(text, busy)) return;
    setBusy(true); setError(undefined);
    try { await session.post(text.trim(), format); setText(""); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <section className="chat" aria-label="Chat">
      {older > 0 && (
        <button type="button" className="small" onClick={() => setShown(loadOlder(effShown, chat.length))}>Load older ({older})</button>
      )}
      <ol className="chat-list" ref={list} onScroll={(e) => { wasAtBottom.current = atBottom(e.currentTarget); }} aria-live="polite">
        {visible.map((m) => (
          <li key={m.id} data-id={m.id} className={`msg${m.mine ? " mine" : ""}${m.id === focus ? " focused" : ""}`}>
            <div className="msg-head">
              <Author did={m.author} />
              <time className="muted small-text" dateTime={m.envelope.clientTs}>{formatTime(m.envelope.clientTs)}</time>
            </div>
            <ItemBody item={m} />
          </li>
        ))}
        {chat.length === 0 && <li className="muted">No messages yet.</li>}
      </ol>
      <form className="composer" onSubmit={(e) => void send(e)}>
        <label htmlFor="composer-text" className="sr">Message</label>
        <textarea id="composer-text" rows={2} value={text} placeholder={format === "text/markdown" ? "Message (markdown)" : "Message"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(e); } }} />
        <div className="composer-row">
          <button type="button" className="small" aria-pressed={format === "text/markdown"} onClick={() => setFormat(toggleFormat(format))}>
            {format === "text/markdown" ? "Markdown on" : "Plain text"}
          </button>
          <button type="submit" className="primary" disabled={!canSend(text, busy)}>Send</button>
        </div>
        {error && <p className="note bad" role="alert">{error}</p>}
      </form>
    </section>
  );
}
