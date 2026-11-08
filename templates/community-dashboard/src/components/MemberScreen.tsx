import { useRef, useState, type KeyboardEvent } from "react";
import type { MemberVmcReceipt, PortalMe } from "@starter/vtc-client";
import { describeError } from "../client.ts";
import { builtApplicant, deliveryNote, runMode } from "../delivery.ts";
import { didPeerFits } from "@starter/tsp-client";
import { formatDate, formatDateTime, stripDids } from "../format.ts";
import { useLoad, useStore } from "../hooks.ts";
import { membershipGrant, noGrantReason, sendBackConfirm } from "../grant.ts";
import { ANON_COOLDOWN_MS } from "../refresh.ts";
import type { Actions } from "./screens.tsx";
import { CodeBlock, Confirm, ErrorNote, Fresh, KV, Loading, Tag, toast } from "./ui.tsx";

const TABS = ["Community", "Directory", "My card", "Account"] as const;
type Tab = (typeof TABS)[number];

export function MemberScreen({ actions, communityName, delivered }: { actions: Actions; communityName: string; delivered?: boolean }) {
  const [tab, setTab] = useState<Tab>("Community");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (n >= 0) { e.preventDefault(); setTab(TABS[n]); refs.current[n]?.focus(); }
  };
  return (
    <div className="stack">
      <MembershipCard actions={actions} communityName={communityName} delivered={delivered} />
      <div role="tablist" aria-label="Member area" className="tabs">
        {TABS.map((t, i) => (
          <button key={t} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`tab-${i}`} aria-selected={tab === t} aria-controls="tabpanel" tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)} onKeyDown={(e) => onKey(e, i)}>{t}</button>
        ))}
      </div>
      <div role="tabpanel" id="tabpanel" aria-labelledby={`tab-${TABS.indexOf(tab)}`} className="card">
        {tab === "Community" && <CommunityTab />}
        {tab === "Directory" && <DirectoryTab />}
        {tab === "My card" && <MyCardTab actions={actions} />}
        {tab === "Account" && <AccountTab actions={actions} communityName={communityName} />}
      </div>
    </div>
  );
}

function MembershipCard({ actions, communityName, delivered }: { actions: Actions; communityName: string; delivered?: boolean }) {
  const who = builtApplicant(didPeerFits);
  const mode = runMode();
  const grant = useStore(membershipGrant);
  const [sentBound, setSentBound] = useState<boolean>();
  const note = deliveryNote(mode, delivered, who.kind, sentBound);
  // The portal sign-in is plain REST (challenge, auth, me): the VTC rate-limits it like an anonymous caller (burst 10, then one
  // per 5 s per address), so it costs three of those tokens. Global refreshes therefore skip it; this card has its own Refresh.
  const me = useLoad<PortalMe>("proof", (c) => c.memberProof(), true, "member/me", false);
  const [proof, setProof] = useState<PortalMe>();
  const [receipt, setReceipt] = useState<MemberVmcReceipt>();
  const d = me.data;
  return (
    <section className="card member-card" aria-labelledby="mc-h">
      <h2 id="mc-h">Membership card</h2>
      {me.loading ? <Loading what="your membership" /> : me.error ? <ErrorNote text={describeError(me.error)} retry={me.reload} /> : (
        <dl className="kv">
          <div><dt>Community</dt><dd>{d?.community?.name ?? communityName}</dd></div>
          <div><dt>Role</dt><dd>{d?.role ?? "unknown"}</dd></div>
          <div><dt>Joined</dt><dd>{formatDate(d?.joinedAt)}</dd></div>
        </dl>
      )}
      <dl className="kv"><div><dt title={FLAG_TITLE}>Credential delivery</dt><dd data-testid="delivery"><span className={`tag ${note.pill === "ok" ? "verified" : note.pill === "warn" ? "inferred" : ""}`}>{note.label}</span> <span className="muted small-text">{note.detail}</span>{who.why ? <span className="muted small-text" data-testid="applicant-fallback"> Why the did:key: {who.why}</span> : null}</dd></div></dl>
      <p className="note info small-text" data-testid="delivery-explained">
        "Credential delivery" shows the community's <code>credentialsDelivered</code> flag. It turns true only when the community holds
        your own membership credential sent back to it (<code>vtc/members/vmc/0.1</code>). Credentials the community pushes to you
        (the frames) do not change it.
      </p>
      <p className="small-text muted" data-testid="grant-state">
        {grant
          ? <>The community's membership credential to you (the grant) arrived in a credential frame, so the credential you send back is bound to it (its digest, and no later expiry).</>
          : <>{noGrantReason(mode)} So the credential you send back is unbound to it.</>}
      </p>
      <Confirm label="Send my membership credential back" busy={actions.busy}
        confirmText={sendBackConfirm(!!grant, mode)}
        onConfirm={() => void (async () => {
          setReceipt(undefined);
          const bound = !!grant;
          const r = await actions.run((c) => c.sendMembershipCredential(grant ? { grant } : {}), (x) => `The community answered "${x?.status ?? "(no status)"}" for your ${bound ? "bound" : "unbound"} membership credential.`);
          if (r) { setReceipt(r); setSentBound(bound); }
        })()} />
      {receipt && (
        <div className="proof" data-testid="vmc-receipt">
          <p className="small-text muted">The community's receipt, as it sent it. "Credential delivery" above was read again afterwards; this page does not set it.</p>
          <CodeBlock label="Receipt" text={JSON.stringify({ ...receipt, memberDid: "(your app DID)" }, null, 2)} />
        </div>
      )}
      <Fresh info={me.asOf} busy={me.refreshing} onRefresh={me.reload} cooldownMs={ANON_COOLDOWN_MS} />
      <p className="muted small-text">Reading this card uses the member portal, which the community rate-limits more tightly, so Refresh all leaves it alone.</p>
      <button type="button" disabled={actions.busy} onClick={async () => {
        const r = await actions.run((c) => c.memberProof(), "The community confirmed you are an active member.");
        if (r) setProof(r);
      }}>Prove I am a member</button>
      {proof && (
        <div className="proof">
          <p className="small-text muted">The community just checked, with a fresh signed sign-in, that you are an active member:</p>
          <CodeBlock label="Membership proof" text={JSON.stringify({ ...proof, did: "(your app DID)", sessionId: "(session)" }, null, 2)} />
        </div>
      )}
    </section>
  );
}

const FLAG_TITLE = "credentialsDelivered: true only when the community holds your own membership credential sent back (vtc/members/vmc/0.1); pushed frames do not change it.";

function CommunityTab() {
  const profile = useLoad("profile", (c) => c.communityProfile(), true, "community/profile/show");
  const groups = useLoad<any>("groups", (c) => c.groups({}), true, "groups/list");
  const items: unknown[] = groups.data?.items ?? groups.data?.groups ?? [];
  return (
    <>
      <h2>Community</h2>
      <Fresh info={profile.asOf} busy={profile.refreshing || groups.refreshing} onRefresh={() => { profile.reload(); groups.reload(); }} />
      {profile.loading ? <Loading what="the profile" /> : profile.error ? <ErrorNote text={describeError(profile.error)} retry={profile.reload} /> : <KV data={(profile.data as any)?.profile ?? profile.data} skip={["logoUrl"]} />}
      <h3>Groups</h3>
      {groups.loading ? <Loading what="groups" /> : groups.error ? <ErrorNote text={describeError(groups.error)} retry={groups.reload} /> : items.length === 0
        ? <p className="muted">No groups. Groups are off at this version of the community software, so this list is empty.</p>
        : <ul>{items.map((g: any, i) => <li key={g.groupId ?? g.id ?? i}>{g.name ?? g.groupId ?? g.id ?? JSON.stringify(g)}</li>)}</ul>}
    </>
  );
}

const entryKey = (e: any): string | undefined => e?.entryId ?? e?.id;

function DirectoryTab() {
  const entries = useLoad<any>("entries", (c) => c.directoryEntries({ limit: 25 }), true, "directory/entries/list");
  const [id, setId] = useState<string>();
  const detail = useLoad<any>(`entry-${id}`, (c) => c.directoryEntry({ entryId: id }), !!id);
  const items: any[] = entries.data?.items ?? entries.data?.entries ?? [];
  return (
    <>
      <h2>Directory</h2>
      <Fresh info={entries.asOf} busy={entries.refreshing} onRefresh={entries.reload} />
      <p className="muted">Other members as the community shows them to you: by entry id and the fields they chose to share. Never by DID.</p>
      {entries.loading ? <Loading what="the directory" /> : entries.error ? <ErrorNote text={describeError(entries.error)} retry={entries.reload} /> : items.length === 0 ? <p className="muted">The directory has no entries yet.</p> : (
        <ul className="entries">
          {items.map((e, i) => {
            const k = entryKey(e);
            const shown = stripDids(e) as Record<string, unknown>;
            return (
              <li key={k ?? i}>
                <button type="button" className="linklike" aria-pressed={id === k} disabled={!k} onClick={() => setId(k)}>Entry <code>{k ?? "(no id)"}</code></button>
                {id !== k && <span className="muted small-text"> {summary(shown)}</span>}
                {id === k && (detail.loading ? <Loading what="the entry" /> : detail.error ? <ErrorNote text={describeError(detail.error)} retry={detail.reload} /> : <KV data={stripDids(detail.data)} />)}
              </li>
            );
          })}
        </ul>
      )}
      <label htmlFor="eid">Open an entry by id</label>
      <form className="inline" onSubmit={(ev) => { ev.preventDefault(); const v = new FormData(ev.currentTarget).get("eid"); if (typeof v === "string" && v.trim()) setId(v.trim()); }}>
        <input id="eid" name="eid" type="text" autoComplete="off" /><button type="submit">Open</button>
      </form>
      {id && !items.some((e) => entryKey(e) === id) && (detail.loading ? <Loading what="the entry" /> : detail.error ? <ErrorNote text={describeError(detail.error)} /> : <KV data={stripDids(detail.data)} />)}
    </>
  );
}

function summary(e: Record<string, unknown>): string {
  const v = (e.values ?? e.fields ?? e.display ?? e) as Record<string, unknown>;
  const parts = Object.entries(v).filter(([k, x]) => !/^(entryId|id|revision)$/.test(k) && (typeof x === "string" || typeof x === "number")).slice(0, 3).map(([k, x]) => `${k}: ${x}`);
  return parts.join(" | ");
}

function MyCardTab({ actions }: { actions: Actions }) {
  const card = useLoad<any>("card", (c) => c.myCard(), true, "directory/card/show");
  const fields = useLoad<any>("fields", (c) => c.directoryFields());
  const [edit, setEdit] = useState<Record<string, string> | undefined>();
  const defs: any[] = (fields.data?.fields ?? fields.data?.items ?? []).filter((d: any) => d.state !== "retired" && d.source !== "admin");
  const cd = card.data?.card ?? card.data;
  const missing: string[] = card.data?.missingRequired ?? [];
  const values: Record<string, unknown> = cd?.values ?? {};
  const fid = (d: any): string => d.key ?? d.id ?? d.name ?? d.fieldId;
  const label = (d: any): string => d.label ?? d.title ?? fid(d);
  async function save() {
    if (!edit) return;
    const patch: Record<string, unknown> = {};
    for (const d of defs) { const k = fid(d); if ((edit[k] ?? "") !== String(values[k] ?? "")) patch[k] = edit[k] === "" ? null : edit[k]; }
    if (!Object.keys(patch).length) { toast("ok", "Nothing changed."); setEdit(undefined); return; }
    const r = await actions.run((c) => c.updateMyCard({ values: patch, ...(typeof cd?.revision === "number" ? { expectedRevision: cd.revision } : {}) }), "Your card was updated.");
    if (r) setEdit(undefined); // run() re-reads every panel from the community; nothing is patched locally
  }
  return (
    <>
      <h2>My card</h2>
      <Fresh info={card.asOf} busy={card.refreshing} onRefresh={() => { card.reload(); fields.reload(); }} />
      <p className="muted">Your entry in the member directory. Other members see only what the community's rules let them see.</p>
      {card.loading || fields.loading ? <Loading what="your card" /> : card.error ? <ErrorNote text={describeError(card.error)} retry={card.reload} /> : !edit ? (
        <>
          <KV data={Object.fromEntries(defs.map((d) => [label(d), values[fid(d)] ?? ""]))} />
          <KV data={{ listing: (cd as any)?.discoverability?.listing, "found by": (cd as any)?.discoverability?.search, introductions: (cd as any)?.introductions, revision: (cd as any)?.revision, updated: (cd as any)?.updatedAt ? formatDateTime((cd as any).updatedAt) : undefined }} />
          {missing.length > 0 && <p className="note warn">Still empty and required: {missing.map((m) => defs.find((d) => fid(d) === m)?.label ?? m).join(", ")}.</p>}
          <button type="button" className="primary" disabled={!defs.length} onClick={() => setEdit(Object.fromEntries(defs.map((d) => [fid(d), String(values[fid(d)] ?? "")])))}>Edit card</button>
          {!defs.length && <p className="muted">The community has defined no card fields to edit.</p>}
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {defs.map((d) => (
            <div className="field" key={fid(d)}>
              <label htmlFor={`f-${fid(d)}`}>{label(d)}</label>
              <input id={`f-${fid(d)}`} type="text" maxLength={d.constraints?.maxLength} required={!!d.required} value={edit[fid(d)] ?? ""} onChange={(e) => setEdit({ ...edit, [fid(d)]: e.target.value })} />
            </div>
          ))}
          <button type="submit" className="primary" disabled={actions.busy}>Save</button>
          <button type="button" onClick={() => setEdit(undefined)}>Cancel</button>
        </form>
      )}
      <p className="small-text muted">Publishing your card beyond the community is not part of this dashboard yet.</p>
    </>
  );
}

function AccountTab({ actions, communityName }: { actions: Actions; communityName: string }) {
  const [typed, setTyped] = useState("");
  const phrase = "leave";
  return (
    <>
      <h2>Account</h2>
      <p className="muted small-text">Renew and leave change the community's records. After either one this page re-reads them; it never assumes the result.</p>
      <h3>Renew membership</h3>
      <p className="muted">Extends your membership if the community uses terms.</p>
      <button type="button" disabled={actions.busy} onClick={() => void actions.run((c) => c.renewMembership(), "Your membership was renewed.")}>Renew</button>
      <div className="danger-zone">
        <h3>Leave {communityName.startsWith("did:") ? "this community" : communityName}</h3>
        <p>Leaving takes effect immediately. You lose access to the member areas. You can apply again afterwards, but an administrator may need to approve you again.</p>
        <label htmlFor="leave-confirm">Type <b>{phrase}</b> to enable the button</label>
        <input id="leave-confirm" type="text" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        {typed.trim().toLowerCase() === phrase ? (
          <Confirm danger label="Leave community" confirmText="Last chance: leave now?" busy={actions.busy} onConfirm={() => void actions.run((c) => c.leaveCommunity({ confirm: true }), "You left the community.")} />
        ) : <button type="button" className="danger" disabled>Leave community</button>}
      </div>
      <p className="small-text muted"><Tag kind="verified">renew and leave seen live</Tag></p>
    </>
  );
}
