import { useState } from "react";
import type { JoinCriterion, JoinManifest, VtcClient } from "@starter/vtc-client";
import { describeCriterion, firstUsable } from "../criteria.ts";
import { describeError, getClient, identity } from "../client.ts";
import { formatDate, formatDateTime, shortDid } from "../format.ts";
import { POLL_MS, clearRemembered, useHints, usePublicProfile, writeRemembered } from "../hooks.ts";
import type { DashState } from "../state.ts";
import { CodeBlock, Confirm, ErrorNote, KV, Tag } from "./ui.tsx";

export interface Actions {
  busy: boolean;
  /** Run a state-changing signed call from an event handler: toasts the outcome and re-checks the state. */
  run<T>(fn: (c: VtcClient) => Promise<T>, ok: string | ((r: T) => string)): Promise<T | undefined>;
}


// --- Visitor / Apply ---------------------------------------------------------------
export function VisitorScreen({ manifest, banner, actions }: { manifest: JoinManifest | undefined; banner?: React.ReactNode; actions: Actions }) {
  const profile = usePublicProfile();
  const [chosen, setChosen] = useState<string>();
  const [preview, setPreview] = useState<{ type: string; payload: Record<string, unknown>; to: string } | undefined>();
  const [err, setErr] = useState<string>();
  const criteria = manifest?.criteria ?? [];
  const pick = chosen ?? firstUsable(criteria)?.requirementsDigest;
  const picked = criteria.find((c) => c.requirementsDigest === pick);

  async function showPreview() {
    setErr(undefined);
    try {
      const c = await getClient();
      setPreview({ type: "vtc/join-requests/submit v0.3", payload: c.joinPayload({ criterion: pick }), to: c.vtcDid });
    } catch (e) { setErr(describeError(e)); }
  }
  async function submit() {
    // Remember the new request id BEFORE the state re-check that run() performs, or the check asks about the old request.
    const r = await actions.run(async (c) => {
      const res = await c.submitJoin({ criterion: pick });
      writeRemembered({ requestId: res.requestId, appliedAt: new Date().toISOString(), criterion: picked?.id });
      return res;
    }, "Your request was sent.");
    if (r) setPreview(undefined);
  }

  return (
    <div className="stack">
      {banner}
      <section className="card" aria-labelledby="about-h">
        <h2 id="about-h">About this community</h2>
        {profile ? <ProfileFacts p={profile} /> : <p className="muted">This community has not published a public profile.</p>}
      </section>
      <section className="card" aria-labelledby="join-h">
        <h2 id="join-h">How to join</h2>
        {!manifest ? <p className="muted" role="status">Loading the ways to join...</p> : criteria.length === 0 ? <p className="muted">This community lists no way to join.</p> : (
          <fieldset className="criteria">
            <legend className="sr">Choose how to apply</legend>
            {criteria.map((c) => <Criterion key={c.requirementsDigest} c={c} selected={pick === c.requirementsDigest} onPick={() => { setChosen(c.requirementsDigest); setPreview(undefined); }} />)}
          </fieldset>
        )}
        {criteria.length > 0 && !picked && <p className="note warn">None of the ways to join can be used from this dashboard. See the reasons above.</p>}
        {!preview && <button type="button" className="primary" disabled={!picked || actions.busy} onClick={showPreview}>Apply to join</button>}
        {err && <ErrorNote text={err} />}
        {preview && (
          <div className="preview" role="region" aria-label="Request preview">
            <h3>Check before you sign</h3>
            <p>This is what will be signed with your app key and sent. Nothing has been sent yet.</p>
            <p className="small-text muted">Signed by <code>{shortDid(identity().did)}</code>, addressed to <code>{shortDid(preview.to)}</code>.</p>
            <CodeBlock label="Request to be signed" text={`${preview.type}\n${JSON.stringify(preview.payload, null, 2)}`} />
            <button type="button" className="primary" disabled={actions.busy} onClick={submit}>Sign and send</button>
            <button type="button" onClick={() => setPreview(undefined)}>Cancel</button>
          </div>
        )}
      </section>
    </div>
  );
}

function Criterion({ c, selected, onPick }: { c: JoinCriterion; selected: boolean; onPick: () => void }) {
  const v = describeCriterion(c);
  const id = `crit-${c.requirementsDigest.slice(0, 12)}`;
  return (
    <div className={`criterion ${v.usable ? "" : "blocked"} ${selected ? "selected" : ""}`}>
      <input type="radio" name="criterion" id={id} checked={selected} disabled={!v.usable} onChange={onPick} aria-describedby={`${id}-d`} />
      <label htmlFor={id}><b>{c.id}</b></label>
      <div id={`${id}-d`}>
        {v.description && <p>{v.description}</p>}
        <p className="muted">{v.outcome}</p>
        {!v.usable && <p className="why">Not available here. {v.reason}</p>}
      </div>
    </div>
  );
}

// --- Pending -------------------------------------------------------------------------
export function PendingScreen(p: { dash: Extract<DashState, { kind: "pending" | "needs-info" | "other" }>; checkedAt?: Date; paused: boolean; setPaused(b: boolean): void; actions: Actions }) {
  const rem = useHints();
  const { dash } = p;
  const needsInfo = dash.kind === "needs-info";
  const [vp, setVp] = useState("");
  const [vpErr, setVpErr] = useState<string>();
  const statusText = dash.kind === "other" ? dash.status : dash.status;
  async function supplement() {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(vp); if (!parsed || typeof parsed !== "object") throw 0; } catch { setVpErr("That is not a JSON object."); return; }
    setVpErr(undefined);
    await p.actions.run((c) => c.supplementJoin({ vp: parsed, requestId: dash.requestId }), "Your extra information was sent.");
  }
  return (
    <div className="stack">
      {dash.kind === "other" ? (
        <section className="card"><h2>Status: {dash.status} <Tag kind="inferred" /></h2>
          <p>The community reports a status this dashboard does not know. Your request is still on file; the raw status is shown above.</p></section>
      ) : (
        <section className="card" aria-labelledby="pend-h">
          <h2 id="pend-h">{needsInfo ? "The community needs more information" : "Your request is in review"} {(needsInfo || dash.kind === "pending" && dash.deferred) && <Tag kind="inferred" />}</h2>
          <p>{needsInfo ? "An administrator asked for more evidence before deciding." : dash.kind === "pending" && dash.deferred ? "An administrator postponed the decision. Your request is still open." : "An administrator will decide. You do not need to do anything."}</p>
        </section>
      )}
      <section className="card" aria-labelledby="sum-h">
        <h2 id="sum-h">Request summary</h2>
        <KV data={{ status: statusText, requestId: dash.requestId, "criterion (local hint)": rem.criterion, "applied (local hint)": rem.appliedAt ? formatDateTime(rem.appliedAt) : undefined, lastChecked: p.checkedAt ? formatDateTime(p.checkedAt.toISOString()) : undefined }} />
        <ol className="timeline" aria-label="Timeline">
          <li className="done"><b>Applied</b> <span className="muted">{rem.appliedAt ? formatDateTime(rem.appliedAt) : "time not recorded in this browser"} (local hint)</span></li>
          <li className="current"><b>In review</b> <span className="muted">now</span></li>
          <li><b>Decision</b> <span className="muted">not yet</span></li>
        </ol>
        <div className="row-actions">
          <span className="muted" role="status">{p.paused ? "Automatic checking is paused." : `Checking automatically every ${POLL_MS / 1000} s.`}</span>
          <button type="button" onClick={() => p.setPaused(!p.paused)} aria-pressed={p.paused}>{p.paused ? "Resume checking" : "Pause checking"}</button>
        </div>
        {!__FARM__ && <p className="note info">Running locally? Approve this request from the repo root with <code>npm run vtc:approve</code>, then this page updates by itself.</p>}
      </section>
      {needsInfo && (
        <section className="card" aria-labelledby="more-h">
          <h2 id="more-h">Add more information <Tag kind="unverified" /></h2>
          <p className="muted">Paste a JSON presentation answering what the community asked for. This path has not been tried against a live community.</p>
          <label htmlFor="vp">Presentation (JSON)</label>
          <textarea id="vp" rows={6} value={vp} onChange={(e) => setVp(e.target.value)} spellCheck={false} />
          {vpErr && <ErrorNote text={vpErr} />}
          <button type="button" className="primary" disabled={!vp || p.actions.busy} onClick={supplement}>Send</button>
        </section>
      )}
      <section className="card" aria-labelledby="wd-h">
        <h2 id="wd-h">Withdraw</h2>
        <p className="muted">Changed your mind? You can apply again later.</p>
        <Confirm label="Withdraw request" confirmText="This cancels your open request. Continue?" busy={p.actions.busy} onConfirm={() => void p.actions.run((c) => c.withdrawJoin({ requestId: dash.requestId }), "Your request was withdrawn.")} />
      </section>
    </div>
  );
}

// --- Ended states ----------------------------------------------------------------------
export function EndedScreen({ dash, onReapply }: { dash: Extract<DashState, { kind: "withdrawn" | "rejected" | "left" }>; onReapply: () => void }) {
  const copy = {
    withdrawn: { h: "You withdrew your request", t: "The community closed it at your request. Nothing else happened." },
    rejected: { h: "Your request was not accepted", t: "An administrator decided not to admit you this time. You can apply again." },
    left: { h: "You are not a member", t: dash.kind === "left" && dash.inferredFrom === "approved-but-not-member" ? "Your request shows as approved but the community no longer treats you as a member. You may have left or been removed." : "The community has no open request from you, and this browser remembers one. You may have left." },
  }[dash.kind];
  return (
    <section className="card" aria-labelledby="end-h">
      <h2 id="end-h">{copy.h} {(dash.kind === "rejected" || dash.kind === "left") && <Tag kind="inferred" />}</h2>
      <p>{copy.t}</p>
      <button type="button" className="primary" onClick={onReapply}>Re-apply</button>
    </section>
  );
}

// --- Error ----------------------------------------------------------------------------
export function ErrorScreen({ dash, retry }: { dash: Extract<DashState, { kind: "error" }>; retry: () => void }) {
  const hint = !import.meta.env.VTA_CREDENTIAL
    ? "There is no app credential. Run npm run up at the repo root and restart the dev server."
    : dash.httpStatus === 429
      ? "Nothing is wrong with your setup: the community only asked this page to slow down."
    : dash.code === "network"
      ? "Check that the community is running (npm run vtc:up locally) and that its address in .env is right. Open the connection dot for details."
      : "The community answered, but not in a way this page can use.";
  return (
    <section className="card" aria-labelledby="err-h">
      <h2 id="err-h">{dash.httpStatus === 429 ? "The community asked for a pause" : "Cannot reach the community"}</h2>
      <p>{dash.message}</p>
      <p className="muted">{hint}</p>
      <button type="button" className="primary" onClick={retry}>Try again</button>
    </section>
  );
}

/** The public profile in plain words: only what a visitor cares about, not the transport plumbing. */
export function ProfileFacts({ p }: { p: Record<string, unknown> }) {
  const str = (k: string) => (typeof p[k] === "string" && p[k] ? (p[k] as string) : undefined);
  const pers = (p.personhood ?? {}) as Record<string, unknown>;
  return (
    <KV data={{
      name: str("name") ?? "This community has not set a name",
      description: str("description"),
      website: str("publicUrl"),
      contact: str("contactEmail"),
      language: str("language"),
      created: str("createdAt") ? formatDate(str("createdAt")) : undefined,
      identifier: str("communityDid") ? shortDid(str("communityDid")!) : undefined,
      "one person, one membership": pers.singleMembership === true ? "Yes" : pers.singleMembership === false ? "No" : undefined,
    }} />
  );
}

/** What this browser remembers (a hint to ask about the right request), with a way to forget it. Shown only when there is one. */
export function LocalHints({ onForgot }: { onForgot: () => void }) {
  const h = useHints();
  if (!h.requestId && !h.appliedAt && !h.criterion) return null;
  return (
    <p className="note info small-text" role="note">
      <b>Local hint.</b> This browser remembers the id of your last request{h.appliedAt ? " and when you applied" : ""} so it can ask the community about the right one. It is only a hint: the community is the source of truth, and another browser will not have it.{" "}
      <button type="button" className="small" onClick={() => { clearRemembered(); onForgot(); }}>Forget local hints</button>
    </p>
  );
}
