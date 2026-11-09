// Tunnel mode only: a banner at the top that the public hosts and DIDs end at `npm run down`. The wording is shared with web-vta-app
// and the status panel's Mode note (@starter/status-panel src/tunnel.ts, unit-tested there).
import { tunnelBanner } from "@starter/status-panel";
import type { RunMode } from "../delivery.ts";

const rich = (t: string) => t.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

export function TunnelBanner({ mode }: { mode: RunMode }) {
  const b = tunnelBanner(mode);
  if (!b) return null;
  return (
    <p className="note warn tunnel-banner" role="note" aria-label="Tunnel mode">
      <b>{b.title}</b> {rich(b.text)}
    </p>
  );
}
