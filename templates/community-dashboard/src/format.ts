// Small pure helpers: DIDs, dates, refusal wording, directory projection, code snippets.

export function shortDid(did: string): string {
  if (did.length <= 22) return did;
  return `${did.slice(0, 12)}...${did.slice(-6)}`;
}

export function formatDate(v: unknown): string {
  if (typeof v !== "string" && typeof v !== "number") return "unknown";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

export function formatDateTime(v: unknown): string {
  if (typeof v !== "string" && typeof v !== "number") return "unknown";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** `https://trusttasks.org/spec/vtc/join-requests/status/0.1` -> `{ name: "vtc/join-requests/status", version: "0.1" }`. */
export function splitTaskType(type: string): { name: string; version: string } {
  const m = /^https?:\/\/[^/]+\/spec\/(.+)\/(\d+(?:\.\d+)*)$/.exec(type);
  return m ? { name: m[1], version: m[2] } : { name: type, version: "" };
}

/** The last segment of a refusal code such as `urn:...:notFound` or `.../notFound`. */
export function codeTail(code: string | undefined): string {
  if (!code) return "";
  return code.split(/[:/#]/).filter(Boolean).pop() ?? code;
}

/** Plain-words wording for a refusal. `message` is the VTC's own text, shown after the explanation. */
export function explainRefusal(status: number | undefined, code: string | undefined, message?: string): string {
  const tail = codeTail(code);
  const t = `${tail} ${message ?? ""}`;
  let plain: string;
  if (code === "network" || (status === undefined && !code)) plain = "The community did not answer. Check that it is running and that this page is allowed to call it.";
  else if (/subjectmismatch/i.test(tail)) plain = "The credential names a different community as its subject, so this community will not store it.";
  else if (/notamember/i.test(tail)) plain = "You are not an active member of this community, so it will not store your membership credential.";
  else if (/invalidcredential/i.test(tail)) plain = "The community could not accept the credential: its issuer, shape or signature did not check out.";
  else if (/notfound/i.test(tail)) plain = "The community has no record of that: there is nothing to act on.";
  else if (/holds no entry|notmember|not a member/i.test(t)) plain = "You are not a member of this community, so it will not do that.";
  else if (/permissiondenied|notpermitted|forbidden|notadmin/i.test(t) || status === 403) plain = "You are not allowed to do that here.";
  else if (/duplicate|already/i.test(t)) plain = "You already have an open request.";
  else if (/ratelimit|toomany/i.test(t) || status === 429) plain = "Too many requests too quickly. Wait a few seconds and try again.";
  else if (/unsupported/i.test(tail)) plain = "This community does not support that version of the request.";
  else if (/revision|conflict|stale/i.test(t) || status === 409) plain = "Someone changed this since you loaded it. Reload and try again.";
  else if (/invalid|malformed|validation/i.test(t) || status === 400 || status === 422) plain = "The community rejected what was sent as invalid.";
  else if (status !== undefined && status >= 500) plain = "The community had an internal problem. Try again shortly.";
  else plain = "The community refused the request.";
  const detail = [status ? `HTTP ${status}` : "", tail && tail !== "network" ? tail : ""].filter(Boolean).join(", ");
  return `${plain}${detail ? ` (${detail})` : ""}${message ? ` The community said: "${message}".` : ""}`;
}

/** Drop anything that identifies a person by DID from a directory entry: the directory is browsed by entry id. */
export function stripDids(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripDids);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/^(did|subject|holder|issuer|memberDid|applicant|applicantDid)$/i.test(k)) continue;
      if (typeof val === "string" && /^did:/.test(val)) continue;
      out[k] = stripDids(val);
    }
    return out;
  }
  return v;
}

/** A TypeScript snippet that repeats a call with `@starter/vtc-client`. `type` is a Trust Task URI. */
export function toTypeScript(type: string, payload: Record<string, unknown>): string {
  if (type.startsWith("GET ") || type.startsWith("POST ")) {
    return `// ${type} is a member-portal REST call, not a Trust Task.\n// \`client.memberProof()\` does the whole sign-in and read.\nconst proof = await client.memberProof();`;
  }
  const body = Object.keys(payload).length ? JSON.stringify(payload, null, 2) : "{}";
  return [
    `import { VtcClient } from "@starter/vtc-client";`,
    `import { decodeCredential, identityFromCredential } from "@starter/vta-client";`,
    ``,
    `const me = identityFromCredential(decodeCredential(process.env.VTA_CREDENTIAL!));`,
    `const client = await VtcClient.connect(process.env.VTC_URL!, me, undefined, process.env.VTC_DID);`,
    `const result = await client.call(${JSON.stringify(type)}, ${body});`,
    `console.log(result);`,
  ].join("\n");
}
