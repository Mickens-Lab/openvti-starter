// The body of a chat message, note or file. Every path is inert:
//  - plain text is a text node; markdown goes through render.ts (React elements only, no HTML);
//  - images and GIFs only from room files, typed by their bytes (sniffImage), shown through a blob: URL that is revoked
//    on unmount; SVG and anything unknown are download-only;
//  - UTF-8 text files up to 1 MiB are shown as text, `.md` through the markdown renderer.
import type { FileEnvelope, SessionItem } from "@buildathon/rooms-client";
import { useCallback, useState } from "react";
import { downloadBytes, errorText, useFileBytes, useObjectUrl, useRoomContext } from "../hooks.ts";
import { renderMarkdown, renderPlain } from "../render.ts";
import { classifyFile, formatSize, wantsPreview } from "../state.ts";
import { PreviewOverlay } from "./PreviewOverlay.tsx";

export function TextBody({ text, format }: { text: string; format: "text/plain" | "text/markdown" }) {
  return <>{format === "text/markdown" ? renderMarkdown(text) : renderPlain(text)}</>;
}

export function FileBody({ file }: { file: FileEnvelope }) {
  const { session } = useRoomContext();
  const preview = wantsPreview(file);
  const { bytes, error } = useFileBytes(session, file, preview);
  const view = classifyFile(file, bytes);
  const url = useObjectUrl(view.show === "image" ? bytes : undefined, view.show === "image" ? view.mime : undefined);
  const [dlError, setDlError] = useState<string>();
  const [open, setOpen] = useState(false);
  const closeOverlay = useCallback(() => setOpen(false), []);
  const download = async () => {
    try { downloadBytes(bytes ?? await session.fileBytes(file), file.name); } catch (e) { setDlError(errorText(e)); }
  };
  const loading = preview && !bytes && !error;
  return (
    <div className="file-body" data-view={loading ? "loading" : view.show}>
      {loading && <p className="muted small-text">Loading preview…</p>}
      {view.show === "image" && url && (
        <button type="button" className="preview-open" aria-label={`Preview ${file.name}`} onClick={() => setOpen(true)}>
          <img className="file-image" src={url} alt={file.name} />
        </button>
      )}
      {view.show === "text" && <pre className="file-text">{view.text}</pre>}
      {view.show === "markdown" && (
        <div className="file-md-wrap">
          <div className="file-md">{renderMarkdown(view.text)}</div>
          <button type="button" className="small" onClick={() => setOpen(true)}>Preview</button>
        </div>
      )}
      {!loading && view.show === "download" && <p className="muted small-text">{view.reason}</p>}
      {error && <p className="note bad small-text" role="alert">Could not read the file: {error}</p>}
      <p className="file-meta small-text">
        <span className="file-name">{file.name}</span> · <span className="muted">{file.mediaType || "unknown type"} (claimed) · {formatSize(file.size)}</span>{" "}
        <button type="button" className="small" onClick={() => void download()}>Download</button>
      </p>
      {dlError && <p className="note bad small-text" role="alert">{dlError}</p>}
      {open && view.show === "image" && url && (
        <PreviewOverlay title={file.name} onClose={closeOverlay}><img className="overlay-image" src={url} alt={file.name} /></PreviewOverlay>
      )}
      {open && view.show === "markdown" && (
        <PreviewOverlay title={file.name} onClose={closeOverlay}><div className="md overlay-md">{renderMarkdown(view.text)}</div></PreviewOverlay>
      )}
    </div>
  );
}

export function ItemBody({ item }: { item: SessionItem }) {
  const e = item.envelope;
  if (e.kind === "chat") return <TextBody text={e.text} format={e.format} />;
  if (e.kind === "note") return <div className="note-body"><h3 className="note-title">{e.title}</h3>{renderMarkdown(e.body)}</div>;
  return <FileBody file={e} />;
}
