// "Messaging" row for the status panel: is DIDComm/TSP actually available, not just configured?
// Pure (no DOM) so it is unit-tested. A VTA whose mediator connection failed keeps serving REST and only logs a
// warning, so in MODE=tunnel a missing protocol is shown as a problem, loudly. "Connected" never means "a message
// round trip was verified": this kit has no peer client yet.
import type { DidService } from "./parse.ts";

export type MessagingPill = "ok" | "warn" | "bad" | "unknown" | "info";
export interface MessagingRow { pill: MessagingPill; label: string; value: string; note?: string; fix?: string }

/** The trust task a VTA answers with the protocols it can serve (an authenticated, no-argument call). */
export const PING_TASK = "https://trusttasks.org/spec/messaging/ping/0.2";

/** Protocol names from a ping payload: a bare array or `{ protocols: [...] }`. */
export function protocolsOf(payload: unknown): string[] | undefined {
  const arr = Array.isArray(payload) ? payload : (payload as { protocols?: unknown } | null)?.protocols;
  return Array.isArray(arr) && arr.every((x) => typeof x === "string") ? (arr as string[]) : undefined;
}

export interface MessagingInput {
  mode: "local" | "tunnel" | "farm";
  services: DidService[];
  /** From messaging/ping/0.2; undefined when it was not asked or failed. */
  protocols?: string[];
  pingError?: string;
  /** The DID document was readable (otherwise `services` is empty because nothing was read). */
  haveDidDoc: boolean;
}

export function messagingRow(i: MessagingInput): MessagingRow {
  const label = "Messaging";
  const adv = (k: DidService["kind"]) => i.services.some((s) => s.kind === k);
  const advertised = ["didcomm", "tsp"].filter((k) => adv(k as DidService["kind"]));
  if (i.protocols) {
    const missing = ["didcomm", "tsp"].filter((p) => !i.protocols!.includes(p));
    if (!missing.length) {
      return { pill: "ok", label, value: `transport connected (${i.protocols.join(", ")}), not a peer ping`, note: "From the VTA's messaging/ping/0.1: DIDComm and TSP are available. This panel sent no message to a peer; `npm run tsp:ping` does (docs/MESSAGING.md)." };
    }
    if (i.mode === "tunnel") {
      return { pill: "bad", label, value: `MESSAGING DEGRADED: ${missing.join(" and ")} not available`, note: `The VTA reports ${i.protocols.join(", ") || "nothing"}. It has most likely fallen back to REST only because the mediator refused it or could not be reached; it logs only a warning.`,
        fix: "Run `npm run tunnel:probe`, then check `docker compose logs vta mediator`. Restart with `npm run down` and `npm run up -- --tunnel`. See docs/MODES.md." };
    }
    return { pill: "info", label, value: `REST only (${i.protocols.join(", ") || "none"})`, note: "Messaging is off in this mode. MODE=tunnel turns it on (docs/MODES.md)." };
  }
  if (i.mode === "tunnel") {
    if (advertised.length < 2) {
      return { pill: "bad", label, value: i.haveDidDoc ? `MESSAGING NOT ADVERTISED (${advertised.join(", ") || "neither DIDComm nor TSP"})` : "unknown: the DID document could not be read",
        note: i.haveDidDoc ? "MODE=tunnel expects DIDComm and TSP in the VTA's DID document." : undefined, fix: "Run `npm run tunnel:probe`. See docs/MODES.md." };
    }
    return { pill: "warn", label, value: "advertised in the DID document; live state not checked", note: i.pingError ? `messaging/ping/0.1 failed: ${i.pingError}` : "Sign in (a credential) so the panel can ask the VTA which protocols it serves.", fix: "Run `npm run tunnel:probe` for the live check." };
  }
  if (i.mode === "local") return { pill: "info", label, value: "off (REST only)", note: "The local stack has no mediator. `npm run up -- --tunnel` adds one (docs/MODES.md)." };
  return { pill: "info", label, value: advertised.length ? `advertised: ${advertised.join(", ")}` : "not advertised", note: "Hosted VTAs advertise messaging only when configured; live state not checked." };
}
