// A modal preview for an image or a markdown file. Rendered in a portal so it is not clipped by the card. Closes on
// Escape, a click on the backdrop or the Close button; focus moves in and returns to the opener. Content is whatever
// the caller already made inert (a blob: <img>, or renderMarkdown's React elements).
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function PreviewOverlay({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      else if (e.key === "Tab") { e.preventDefault(); close.current?.focus(); } // the Close button is the only stop
    };
    document.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
      opener?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="overlay" onClick={onClose} data-testid="preview-overlay">
      <div className="overlay-panel" role="dialog" aria-modal="true" aria-label={`Preview of ${title}`} onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          <strong className="overlay-title">{title}</strong>
          <button type="button" ref={close} onClick={onClose}>Close</button>
        </div>
        <div className="overlay-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
