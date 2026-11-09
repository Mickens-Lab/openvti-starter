// Log in to the mediator as this page's applicant and pass every TSP frame from the VTC to the panel: the browser version of
// `npm run tsp:listen` (scripts/tsp-listen.ts). Side-effecting; the panel takes it as a prop so tests hand it a fake.
import { connectTsp, didPeerFits, frameOf, type Frame, type PeerIdentity, type TspClient } from "@starter/tsp-client";
import { builtApplicant } from "./delivery.ts";
import { getClient, identity } from "./client.ts";
import { CONNECT_TIMEOUT_MS, ConnectTimeout } from "./frames.ts";
import { membershipGrantOf } from "@starter/vtc-client";
import { membershipGrant } from "./grant.ts";

export interface ListenHandlers {
  onFrame(f: Frame): void;
  /** A progress or relationship line (not a frame). */
  onNote(line: string): void;
  /** The socket closed without Stop. */
  onClosed(): void;
}
export interface Listening { did: string; stop(): void }
export type StartListener = (h: ListenHandlers, opts: { relate: boolean; mediatorDid: string }) => Promise<Listening>;

export const startListener: StartListener = async (h, opts) => {
  const me = identity();
  const peer = import.meta.env.VTC_DID || (await getClient()).vtcDid;
  const asPeer = builtApplicant(didPeerFits).kind === "did:peer";
  const pending = connectTsp({ vtaDid: peer, mediatorDid: opts.mediatorDid, log: h.onNote, ...(asPeer ? { identity: me as PeerIdentity } : { seed: me.seed }) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let c: TspClient;
  try {
    c = await Promise.race([pending, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new ConnectTimeout(CONNECT_TIMEOUT_MS)), CONNECT_TIMEOUT_MS); })]);
  } catch (e) {
    pending.then((late) => late.close(), () => {}); // a connect that finishes after the timeout is closed at once
    throw e;
  } finally {
    clearTimeout(timer);
  }
  c.conn.onInboundTsp(async (bytes) => {
    try {
      const f = frameOf(await c.session.open(bytes)); // opens only a frame from `peer` (the VTC), so the grant is the VTC's
      const grant = "document" in f ? membershipGrantOf(f.document, me.did, peer) : undefined;
      if (grant) membershipGrant.set(grant);
      h.onFrame(f);
    } catch (e) { h.onFrame({ unreadable: (e as Error).message }); }
  });
  if (opts.relate) {
    c.session.relate(5000).then(() => h.onNote("relationship accepted by the VTC"), (e) => h.onNote(`no accept from the VTC: ${(e as Error).message}`));
  }
  let stopped = false;
  const watch = setInterval(() => { if (!stopped && !c.conn.isOpen) { stopped = true; clearInterval(watch); c.close(); h.onClosed(); } }, 3000);
  return { did: c.did, stop: () => { if (stopped) return; stopped = true; clearInterval(watch); c.close(); } };
};
