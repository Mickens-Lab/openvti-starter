import { useEffect, useRef } from "react";
import { mountStatusPanel } from "@starter/status-panel";
import { VtcClient } from "@starter/vtc-client";
import { VtaClient } from "@starter/vta-client";
import { didPeerFits } from "@starter/tsp-client";
import { abs, credential, identity, vtaBrowserUrl, vtcBrowserUrl } from "../client.ts";
import { builtApplicant } from "../delivery.ts";

/** The applicant this page signs as (the same rule as `npm run vtc:join`), for the panel's "Applicant and messaging" card. */
function applicantInfo() {
  const a = builtApplicant(didPeerFits);
  let did: string | undefined;
  try { did = identity().did; } catch { /* no credential: kind and mediator are still known */ }
  return { kind: a.kind, did, why: a.why, mediatorDid: a.mediatorDid };
}

/** The framework-free status panel, mounted from an effect and destroyed on cleanup. */
export function StatusPanelHost() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cred = credential();
    const vtaUrl = vtaBrowserUrl();
    // Mount on the next tick so React StrictMode's mount -> cleanup -> mount in dev starts the panel's checks once, not twice.
    let handle: ReturnType<typeof mountStatusPanel> | undefined;
    const timer = setTimeout(() => { handle = mountStatusPanel(el, {
      mode: __FARM__ ? "farm" : __TUNNEL__ ? "tunnel" : "local",
      vtaUrl,
      vtaDisplayUrl: __VTA_URL__,
      credentialPresent: !!cred,
      connect: async () => {
        if (!cred) throw new Error("No VTA_CREDENTIAL");
        const c = await VtaClient.fromCredential(cred, vtaUrl, undefined, { resolveDid: !__FARM__ });
        await c.authenticate();
        return c;
      },
      pin: __PIN__,
      farm: __FARM_INFO__ ?? undefined,
      keyEmbedded: !!cred,
      applicant: applicantInfo(),
      vtc: {
        url: abs(vtcBrowserUrl()),
        displayUrl: __VTC_URL__,
        did: import.meta.env.VTC_DID || undefined,
        // A separate, quiet client: the panel's own check must not clutter the app's call log.
        manifest: !cred ? undefined : async () => (await VtcClient.connect(vtcBrowserUrl(), identity(), undefined, import.meta.env.VTC_DID || undefined)).manifest(),
      },
      title: "Connection status",
      autoRefreshMs: 0,
    }); void handle.refresh(); }, 0);
    return () => { clearTimeout(timer); handle?.destroy(); };
  }, []);
  return <div ref={ref} />;
}

export function StatusDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Connection details">
        <div className="drawer-head"><h2>Connection details</h2><button ref={closeBtn} type="button" onClick={onClose}>Close</button></div>
        <StatusPanelHost />
      </aside>
    </>
  );
}
