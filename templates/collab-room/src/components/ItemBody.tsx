// The body of a chat message, note or file. Every path is inert:
//  - plain text is a text node; markdown goes through render.ts (React elements only, no HTML);
//  - images and GIFs only from room files, typed by their bytes (sniffImage), shown through a blob: URL that is revoked
//    on unmount; SVG and anything unknown are download-only;
//  - UTF-8 text files up to 1 MiB are shown as text, `.md` through the markdown renderer.
import type { FileEnvelope, SessionItem } from "@buildathon/rooms-client";
import { useState } from "react";
import { downloadBytes, errorText, useFileBytes, useObjectUrl, useRoomContext } from "../hooks.ts";
import { renderMarkdown, renderPlain } from "../render.ts";
import { classifyFile, formatSize, wantsPreview } from "../state.ts";

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
  const download = async () => {
    try { downloadBytes(bytes ?? await session.fileBytes(file), file.name); } catch (e) { setDlError(errorText(e)); }
  };
  const loading = preview && !bytes && !error;
  return (
    <div className="file-body" data-view={loading ? "loading" : view.show}>
      {loading && <p className="muted small-text">Loading preview…</p>}
      {view.show === "image" && url && <img className="file-image" src={url} alt={file.name} />}
      {view.show === "text" && <pre className="file-text">{view.text}</pre>}
      {view.show === "markdown" && <div className="file-md">{renderMarkdown(view.text)}</div>}
      {!loading && view.show === "download" && <p className="muted small-text">{view.reason}</p>}
      {error && <p className="note bad small-text" role="alert">Could not read the file: {error}</p>}
      <p className="file-meta small-text">
        <span className="file-name">{file.name}</span> · <span className="muted">{file.mediaType || "unknown type"} (claimed) · {formatSize(file.size)}</span>{" "}
        <button type="button" className="small" onClick={() => void download()}>Download</button>
      </p>
      {dlError && <p className="note bad small-text" role="alert">{dlError}</p>}
    </div>
  );
}

export function ItemBody({ item }: { item: SessionItem }) {
  const e = item.envelope;
  if (e.kind === "chat") return <TextBody text={e.text} format={e.format} />;
  if (e.kind === "note") return <div className="note-body"><h3 className="note-title">{e.title}</h3>{renderMarkdown(e.body)}</div>;
  return <FileBody file={e} />;
}
