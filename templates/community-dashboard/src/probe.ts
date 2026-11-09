// Turn calls into the `Probe` results that state.ts interprets, and run the signed state check.
import type { VtcClient } from "@starter/vtc-client";
import { refusalOf } from "./client.ts";
import { deriveState, isNotFound, needsMemberRead, type DashState, type Probe, type StatusValue } from "./state.ts";

export async function probe<T>(fn: () => Promise<T>): Promise<Probe<T>> {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, ...refusalOf(e) }; }
}

/** One state check: the signer's own join status, plus a member-only read when (and only when) the status is `approved`. */
export async function detect(client: VtcClient, rememberedId?: string): Promise<DashState> {
  // Ask about the request this browser sent when it remembers one: "the latest request" (no id) was seen live to keep
  // answering with an older approved request after a newer one was withdrawn. Fall back to no id if the VTC does not know it.
  let status = await probe<StatusValue>(() => client.joinStatus(rememberedId));
  if (rememberedId && !status.ok && isNotFound(status)) status = await probe<StatusValue>(() => client.joinStatus());
  const hadRequest = !!rememberedId;
  const memberRead = needsMemberRead(status) ? await probe(() => client.communityProfile()) : undefined;
  return deriveState({ status, memberRead, hadRequest });
}
