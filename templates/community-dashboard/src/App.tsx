import { useCallback, useRef, useState } from "react";
import type { VtcClient } from "@starter/vtc-client";
import { didPeerFits } from "@starter/tsp-client";
import { describeError, getClient, identity, refusalOf } from "./client.ts";
import { builtApplicant, runMode } from "./delivery.ts";
import { framesGate } from "./frames.ts";
import { startListener } from "./listener.ts";
import { FramesPanel } from "./components/FramesPanel.tsx";
import { IdentityPanel } from "./components/IdentityPanel.tsx";
import { JourneyStrip } from "./components/JourneyStrip.tsx";
import { MemberScreen } from "./components/MemberScreen.tsx";
import { StatusDrawer } from "./components/StatusDrawer.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { TunnelBanner } from "./components/TunnelBanner.tsx";
import { UnderTheHood } from "./components/UnderTheHood.tsx";
import { EndedScreen, ErrorScreen, LocalHints, PendingScreen, VisitorScreen, type Actions } from "./components/screens.tsx";
import { Fresh, Toasts, toast } from "./components/ui.tsx";
import { shortDid } from "./format.ts";
import { useDashboard, usePublicProfile, useRefreshOnFocus } from "./hooks.ts";
import { ANON_COOLDOWN_MS, FOCUS_MIN_AGE_MS, KNOWN_COOLDOWN_MS, bumpEpoch, tryRefresh } from "./refresh.ts";

function appDid(): string | undefined { try { return identity().did; } catch { return undefined; } }

export function App() {
  const d = useDashboard();
  const profile = usePublicProfile();
  const [busy, setBusy] = useState(false);
  const [hood, setHood] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [reapply, setReapply] = useState(false);

  // The VTC is the database: nothing here is patched locally. Every action, every Refresh and every return to the tab
  // re-reads from the community (the status check, plus every panel that is showing).
  const known = d.dash?.kind === "member";
  const cooldownMs = known ? KNOWN_COOLDOWN_MS : ANON_COOLDOWN_MS;
  const reread = useCallback(async (quiet: boolean) => {
    bumpEpoch();
    try { await d.refresh(); } catch (e) { if (!quiet) toast("bad", describeError(e)); }
  }, [d.refresh]);
  const refreshAll = useCallback(() => { if (tryRefresh(cooldownMs)) void reread(false); }, [cooldownMs, reread]);
  const lastRead = useRef<Date>();
  lastRead.current = d.checkedAt;
  useRefreshOnFocus(() => { if (tryRefresh(cooldownMs)) void reread(true); }, () => lastRead.current?.getTime() ?? 0, FOCUS_MIN_AGE_MS);

  // State-changing calls run here, from event handlers only.
  const actions: Actions = {
    busy,
    async run(fn: (c: VtcClient) => Promise<any>, ok: string | ((r: any) => string)) {
      setBusy(true);
      try {
        const r = await fn(await getClient());
        toast("ok", typeof ok === "function" ? ok(r) : ok);
        setReapply(false);
        await reread(false);
        return r;
      } catch (e) {
        toast("bad", describeError(e));
        // A refusal means the community's records differ from what the page showed: look again. A dead network will not help.
        if (!refusalOf(e).network) await reread(true);
        return undefined;
      } finally { setBusy(false); }
    },
  };

  const name = (typeof profile?.name === "string" && profile.name) || (typeof d.manifest?.branding?.name === "string" && d.manifest.branding.name) || (d.manifest?.communityDid ? shortDid(d.manifest.communityDid) : import.meta.env.VTC_DID ? shortDid(import.meta.env.VTC_DID) : "Community");
  const s = d.dash;

  let main: React.ReactNode;
  if (!s) main = <p className="muted" role="status">Checking with the community...</p>;
  else if (s.kind === "error") main = <ErrorScreen dash={s} retry={() => void reread(false)} />;
  else if (s.kind === "member") main = <MemberScreen actions={actions} communityName={name} delivered={s.credentialsDelivered} />;
  else if (s.kind === "pending" || s.kind === "needs-info" || s.kind === "other") main = <PendingScreen dash={s} checkedAt={d.checkedAt} paused={d.paused} setPaused={d.setPaused} actions={actions} />;
  else if ((s.kind === "withdrawn" || s.kind === "rejected" || s.kind === "left") && !reapply) main = <EndedScreen dash={s} onReapply={() => setReapply(true)} />;
  else main = <VisitorScreen manifest={d.manifest} actions={actions} banner={reapply ? <p className="note info">Applying again as the same identity. Choose how to apply below.</p> : undefined} />;

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <TopBar community={name} did={appDid()} dash={s} statusOpen={drawer} onOpenStatus={() => setDrawer(true)} onRefreshAll={refreshAll} />
      <TunnelBanner mode={runMode()} />
      {appDid() && (
        <p className="note warn" role="note">
          <b>Playground only.</b> The app key is embedded in this page, so anyone who can load it can act as this app. Do not reuse it or deploy this build. See docs/SECURITY.md.
        </p>
      )}
      <JourneyStrip dash={s} />
      {s && s.kind !== "member" && <Fresh info={d.source} onRefresh={() => void reread(false)} cooldownMs={cooldownMs} label="Refresh status" />}
      <LocalHints onForgot={() => void reread(false)} />
      <div className={`layout ${hood ? "with-hood" : ""}`}>
        <main id="main" tabIndex={-1}>
          {main}
          {/* One position for in-review and member, so a listener started before approval keeps running when the page turns to "member". */}
          {s && (s.kind === "pending" || s.kind === "needs-info" || s.kind === "other" || s.kind === "member") && (
            <FramesPanel gate={framesGate(runMode(), builtApplicant(didPeerFits))} start={startListener} origin={location.origin} did={appDid()} />
          )}
          {/* Read-only, collapsed: the applicant DID decoded, and the mediator's DID document (tunnel mode) fetched on open. */}
          {s && <IdentityPanel mode={runMode()} did={appDid()} applicant={builtApplicant(didPeerFits)} origin={location.origin} />}
        </main>
        <UnderTheHood open={hood} onToggle={() => setHood(!hood)} />
      </div>
      <StatusDrawer open={drawer} onClose={() => setDrawer(false)} />
      <Toasts />
    </div>
  );
}
