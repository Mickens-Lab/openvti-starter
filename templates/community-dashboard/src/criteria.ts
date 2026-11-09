// Which join criteria this dashboard can use, and what each means in plain words. Pure.
// A criterion is usable when an app with an empty presentation can meet it: no invitation, no
// required credentials, no vetting (the same rule as `pickCriterion` in vtc-client).
import type { JoinCriterion } from "@starter/vtc-client";

export interface CriterionView {
  id: string;
  usable: boolean;
  /** Why it cannot be chosen here; undefined when usable. */
  reason?: string;
  /** What admission means for this criterion. */
  outcome: string;
  description?: string;
}

const has = (v: unknown) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

export function describeCriterion(c: JoinCriterion): CriterionView {
  const needs: string[] = [];
  if (c.invitationRequired) needs.push("an invitation from the community");
  if (has(c.presentationDefinition) || has(c.credentialIssuers)) needs.push("credentials from a trusted issuer, which this dashboard cannot present");
  if (has(c.vetting)) needs.push("vetting by an approved member");
  const outcome =
    c.admission === "automatic" ? "You become a member as soon as you apply."
    : c.admission === "review" ? "An administrator reads your request and decides."
    : `Admission: ${c.admission || "set by the community"}.`;
  return {
    id: c.id,
    usable: needs.length === 0,
    reason: needs.length ? `Needs ${needs.join(" and ")}.` : undefined,
    outcome,
    description: typeof c.description === "string" && c.description ? c.description : undefined,
  };
}

/** The first usable criterion's digest, for preselecting. */
export function firstUsable(cs: JoinCriterion[]): JoinCriterion | undefined {
  return cs.find((c) => describeCriterion(c).usable);
}
