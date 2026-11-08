// Files: upload, list (newest first) with an inert preview each, download. Sealed rooms carry files inline up to 32 KiB;
// a larger upload is refused by the session with a readable message, shown here.
import { useLayoutEffect, useRef, useState } from "react";
import type { SessionItem } from "@starter/rooms-client";
import { byDataId, errorText, useRoomContext } from "../hooks.ts";
import { formatTime } from "../state.ts";
import { Author } from "./Author.tsx";
import { ItemBody } from "./ItemBody.tsx";

/** A picked file's bytes (FileReader where Blob.arrayBuffer is missing, as in older engines and jsdom). */
function readBytes(f: File): Promise<Uint8Array> {
  if (typeof f.arrayBuffer === "function") return f.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(f);
  });
}

export function FilesView({ files, focus }: { files: SessionItem[]; focus?: string }) {
  const { session } = useRoomContext();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useLayoutEffect(() => {
    if (!focus) return;
    byDataId(list.current, focus)?.scrollIntoView?.({ block: "center" });
  }, [focus]);

  const upload = async (fl: FileList | null) => {
    if (!fl?.length) return;
    setBusy(true); setError(undefined);
    try {
      for (const f of Array.from(fl)) await session.upload(f.name, f.type || "application/octet-stream", await readBytes(f));
    } catch (e) { setError(errorText(e)); } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <section className="files" aria-label="Files">
      <div className="upload">
        <label htmlFor="file-upload">Upload a file</label>
        <input id="file-upload" ref={input} type="file" multiple disabled={busy} onChange={(e) => void upload(e.currentTarget.files)} />
        <p className="muted small-text">
          {session.sealed ? "Sealed room: files are sealed inline in the record, at most 32 KiB each." : "Open room: files are stored as blobs the host can read."}
        </p>
        {error && <p className="note bad" role="alert">{error}</p>}
      </div>
      <ul className="file-list" ref={list}>
        {files.map((f) => (
          <li key={f.id} data-id={f.id} className={`file-item card${f.id === focus ? " focused" : ""}`}>
            <p className="muted small-text"><Author did={f.author} /> · {formatTime(f.envelope.clientTs)}</p>
            <ItemBody item={f} />
          </li>
        ))}
        {files.length === 0 && <li className="muted">No files yet.</li>}
      </ul>
    </section>
  );
}
