// "Credential frames": listen on the mediator as this page's applicant and show each TSP frame the VTC pushes (the browser
// version of `npm run tsp:listen`). Collapsed by default. It reports frame kinds; listener.ts keeps the community's membership
// grant from an issue frame for the membership card's send-back (grant.ts). It never verifies the credential's proof.
import { useEffect, useRef, useState } from "react";
import { emptyTally, record, type Frame, type Tally } from "@starter/tsp-client";
import { connectFailureText, frameKind, framesVerdict, NOT_DELIVERED_FLAG, ONE_LISTENER, tallyLine, type FramesGate } from "../frames.ts";
import type { Listening, StartListener } from "../listener.ts";

type Phase = "idle" | "connecting" | "listening" | "stopped" | "failed" | "closed";
interface Seen { n: number; at: Date; kind: string }

const PHASE: Record<Phase, string> = {
  idle: "not listening",
  connecting: "connecting to the mediator...",
  listening: "listening",
  stopped: "stopped",
  failed: "could not start",
  closed: "the socket closed",
};

export function FramesPanel({ gate, start, origin, did }: { gate: FramesGate; start: StartListener; origin: string; did?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [frames, setFrames] = useState<Seen[]>([]);
  const [tally, setTally] = useState<Tally>(emptyTally);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const run = useRef(0);
  const live = useRef<Listening>();

  const stop = () => { run.current++; live.current?.stop(); live.current = undefined; };
  useEffect(() => stop, []); // close the socket when the panel goes away

  async function listen() {
    if (!gate.listen) return;
    stop();
    const mine = ++run.current;
    const current = () => run.current === mine;
    setPhase("connecting"); setError(undefined); setNote(undefined); setFrames([]); setTally(emptyTally());
    try {
      const l = await start({
        onFrame: (f: Frame) => {
          if (!current()) return;
          setTally((t) => record(t, f));
          setFrames((p) => [...p, { n: p.length + 1, at: new Date(), kind: frameKind(f) }]);
        },
        onNote: (line) => { if (current()) setNote(line); },
        onClosed: () => { if (current()) { live.current = undefined; setPhase("closed"); } },
      }, { relate: gate.relate, mediatorDid: gate.mediatorDid });
      if (!current()) { l.stop(); return; } // Stop (or unmount) came first
      live.current = l;
      setPhase("listening");
    } catch (e) {
      if (!current()) return;
      setError(connectFailureText(e, origin, gate.mediatorDid));
      setPhase("failed");
    }
  }

  const active = phase === "connecting" || phase === "listening";
  const total = frames.length;
  return (
    <details className="card frames" aria-label="Credential frames">
      <summary><b>Credential frames</b> <span className="muted small-text">{gate.listen ? `${PHASE[phase]}${total ? `, ${total} frame${total === 1 ? "" : "s"}` : ""}` : gate.title}</span></summary>
      {!gate.listen ? <p className="muted">{gate.text}</p> : (
        <>
          <p className="small-text">
            Logs in to the mediator as this page's applicant{did ? <> (<code>{did.length > 40 ? `${did.slice(0, 24)}...${did.slice(-8)}` : did}</code>)</> : null} and shows each TSP frame the VTC pushes to it.
            Start before the administrator approves: the credential is pushed right after approval.
            {gate.relate && " This page applies as a did:key, which names no mediator, so it first sends the VTC a relationship invite (as `npm run tsp:listen` does) so the VTC learns its route."}
          </p>
          <p className="muted small-text">Needs the mediator to allow this page's origin: <code>MEDIATOR_CORS_ALLOW_ORIGIN={origin}</code> (docs/MODES.md, "Browser access"). {ONE_LISTENER}</p>
          <div className="row-actions">
            {active
              ? <button type="button" onClick={() => { stop(); setPhase("stopped"); }}>Stop</button>
              : <button type="button" className="primary" onClick={() => void listen()}>Listen for credential frames</button>}
            <span role="status" className="muted small-text">{PHASE[phase]}{phase === "connecting" && note ? `: ${note}` : ""}</span>
          </div>
          {error && <p className="note bad" role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}</p>}
          {phase !== "idle" && phase !== "failed" && (
            <>
              {frames.length > 0 && (
                <ol aria-label="Frames received" className="small-text">
                  {frames.map((f) => <li key={f.n}><time dateTime={f.at.toISOString()}>{f.at.toLocaleTimeString()}</time> {f.kind}</li>)}
                </ol>
              )}
              <p className="small-text">{tallyLine(tally)}</p>
              <p className="small-text">{framesVerdict(tally)}</p>
              {note && phase !== "connecting" && <p className="muted small-text">Last note: {note}</p>}
            </>
          )}
          <p className="note info small-text">{NOT_DELIVERED_FLAG}</p>
        </>
      )}
    </details>
  );
}
