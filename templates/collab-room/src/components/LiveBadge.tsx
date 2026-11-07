// Poll status. There is no member push for record changes, so "live" means polling records/list with sinceVersion.
import { useRoomContext } from "../hooks.ts";
import { liveLabel } from "../state.ts";

export function LiveBadge() {
  const { status, visible } = useRoomContext();
  const l = liveLabel(status, visible);
  return <span className={`badge ${l.tone}`} role="status" data-status={status}>{l.text}</span>;
}
