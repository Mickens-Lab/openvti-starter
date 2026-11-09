// Every screen of the dashboard against a fake community: what each state shows, the journey strip, refusals, toasts.
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { TrustTaskError } from "@starter/vta-client";
import userEvent from "@testing-library/user-event";
import { approve, fake, freshDb, notMember, refusal } from "./fake.ts";
import { mountApp, resetWorld, settle } from "./harness.tsx";

const journeyNow = () => within(screen.getByRole("list", { name: "Your journey" })).getAllByRole("listitem").find((li) => li.getAttribute("aria-current") === "step")?.textContent ?? "";
const badge = () => screen.getAllByRole("status").find((e) => e.classList.contains("badge"))?.textContent;
const toastText = () => document.querySelector(".toasts")?.textContent ?? "";

beforeEach(() => resetWorld());

describe("visitor", () => {
  it("shows how to join, the journey at Apply, and previews the request before signing it", async () => {
    await mountApp();
    expect(badge()).toBe("Visitor");
    expect(journeyNow()).toContain("Apply");
    expect(screen.getByText("How to join")).toBeTruthy();
    expect(fake.submitJoin).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Apply to join" }));
    expect(screen.getByRole("region", { name: "Request preview" })).toBeTruthy();
    expect(fake.submitJoin).not.toHaveBeenCalled(); // nothing is sent until "Sign and send"
  });

  it("sends the request once, toasts, re-reads the status and lands on In review", async () => {
    await mountApp();
    await userEvent.click(screen.getByRole("button", { name: "Apply to join" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign and send" }));
    await settle();
    expect(fake.submitJoin).toHaveBeenCalledTimes(1);
    expect(toastText()).toContain("Your request was sent.");
    expect(badge()).toBe("In review");
    expect(journeyNow()).toContain("In review");
    // No optimistic update: the status shown was read back from the community after the action.
    expect(fake.calls.slice(-2)[0]).toBe("submitJoin");
    expect(fake.calls.slice(-1)[0]).toBe("joinStatus");
  });

  it("explains a criterion this dashboard cannot use", async () => {
    const db = freshDb();
    db.criteria = [{ id: "invite", requirementsDigest: "digest-invite-0001", admission: "review", invitationRequired: true }];
    resetWorld(db);
    await mountApp();
    expect(screen.getByText(/Not available here/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Apply to join" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("in review", () => {
  beforeEach(() => { const db = freshDb(); db.request = { id: "req-9", status: "pending" }; resetWorld(db); });

  it("shows the summary, polls, and labels what only this browser knows as a local hint", async () => {
    localStorage.setItem(`community-dashboard:${(await import("../../src/client.ts")).identity().did}`, JSON.stringify({ requestId: "req-9", appliedAt: "2026-01-02T03:04:00Z", criterion: "review" }));
    await mountApp();
    expect(badge()).toBe("In review");
    expect(screen.getByText("Request summary")).toBeTruthy();
    expect(screen.getByText("Criterion (local hint)")).toBeTruthy();
    expect(screen.getByText("Applied (local hint)")).toBeTruthy();
    expect(screen.getByText(/Checking automatically every 10 s/)).toBeTruthy();
  });

  it("withdraws after a confirmation and shows the ended screen", async () => {
    await mountApp();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw request" }));
    expect(fake.withdrawJoin).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Yes, withdraw request/i }));
    await settle();
    expect(fake.withdrawJoin).toHaveBeenCalledTimes(1);
    expect(toastText()).toContain("Your request was withdrawn.");
    expect(screen.getByText("You withdrew your request")).toBeTruthy();
  });

  it("deferred is shown as in review and marked inferred", async () => {
    fake.db.request!.status = "deferred";
    await mountApp();
    expect(badge()).toBe("In review (deferred)");
    expect(screen.getAllByText("inferred").length).toBeGreaterThan(0);
  });

  it("a request that needs more information offers the supplement form (unverified path)", async () => {
    fake.db.request!.status = "needs_more_info";
    await mountApp();
    expect(badge()).toBe("More information needed");
    fireEvent.change(screen.getByLabelText("Presentation (JSON)"), { target: { value: "not json" } });
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("That is not a JSON object.")).toBeTruthy();
    expect(fake.supplementJoin).not.toHaveBeenCalled();
  });

  it("an unknown status gets a generic screen that keeps the raw value", async () => {
    fake.db.request!.status = "paused-by-admin";
    await mountApp();
    expect(screen.getAllByText(/Status: paused-by-admin/).length).toBe(2); // badge and heading
  });
});

describe("ended states", () => {
  it.each([["withdrawn", "You withdrew your request"], ["rejected", "Your request was not accepted"]])("%s offers Re-apply, which returns to the apply form", async (status, heading) => {
    const db = freshDb(); db.request = { id: "r1", status }; resetWorld(db);
    await mountApp();
    expect(screen.getByText(heading)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Re-apply" }));
    expect(screen.getByText(/Applying again as the same identity/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply to join" })).toBeTruthy();
  });

  it("approved but no longer a member reads as left", async () => {
    const db = freshDb(); db.request = { id: "r1", status: "approved" }; db.member = false; resetWorld(db);
    await mountApp();
    expect(badge()).toBe("Left");
    expect(screen.getByText("You are not a member")).toBeTruthy();
  });

  it("a vanished request this browser remembers reads as left", async () => {
    localStorage.setItem(`community-dashboard:${(await import("../../src/client.ts")).identity().did}`, JSON.stringify({ requestId: "gone" }));
    await mountApp();
    expect(badge()).toBe("Left");
  });
});

describe("error", () => {
  it("says the community did not answer, with a way to try again that re-reads (no page reload)", async () => {
    fake.db.networkDown = true;
    await mountApp();
    expect(badge()).toBe("Problem");
    expect(screen.getByText("Cannot reach the community")).toBeTruthy();
    fake.db.networkDown = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(badge()).toBe("Visitor");
  });
});

describe("rate limit", () => {
  it("a 429 from the community says wait and offers Refresh status, which works once the budget refills", async () => {
    fake.db.failing.joinStatus = new TrustTaskError(429, { error: "rate_limited", message: "too many unauthenticated requests from this address", retryAfterSecs: 5 });
    await mountApp();
    expect(screen.getByText("The community asked for a pause")).toBeTruthy();
    expect(screen.getByText(/rate-limiting this page/)).toBeTruthy();
    delete fake.db.failing.joinStatus;
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await settle();
    expect(badge()).toBe("Visitor");
  });
});

describe("member", () => {
  beforeEach(() => { const db = freshDb(); db.request = { id: "r1", status: "approved" }; db.member = true; resetWorld(db); });

  it("says why the credential was not delivered, for the mode this page was built for (local here)", async () => {
    await mountApp();
    const row = await screen.findByTestId("delivery");
    expect(row.textContent).toContain("not applicable here");
    expect(row.textContent).toContain("MODE=tunnel");
    expect(row.textContent).not.toMatch(/false/);
  });

  it("shows the card, the journey at Member, and the four tabs", async () => {
    await mountApp();
    expect(badge()).toBe("Member");
    expect(journeyNow()).toContain("Member");
    expect(screen.getByRole("heading", { name: "Membership card" })).toBeTruthy();
    expect(await screen.findByText("member")).toBeTruthy(); // role from /v1/member/me
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Community", "Directory", "My card", "Account"]);
    expect(screen.getByText(/No groups/)).toBeTruthy();
  });

  it("Directory lists entries by id, never by DID", async () => {
    await mountApp();
    await userEvent.click(screen.getByRole("tab", { name: "Directory" }));
    await settle();
    expect(screen.getByText("e1")).toBeTruthy();
  });

  it("edits the card with the revision it read, then shows what the community now holds", async () => {
    await mountApp();
    await userEvent.click(screen.getByRole("tab", { name: "My card" }));
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Edit card" }));
    await userEvent.type(screen.getByLabelText("Nickname"), "Grace");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(fake.updateMyCard).toHaveBeenCalledWith({ values: { nickname: "Grace" }, expectedRevision: 0 });
    expect(toastText()).toContain("Your card was updated.");
    expect(fake.db.card.revision).toBe(1);
    expect(screen.getByText("Grace")).toBeTruthy(); // from the re-read, not from the form
  });

  it("a revision conflict is explained, the form is kept, and the panel is re-read", async () => {
    await mountApp();
    await userEvent.click(screen.getByRole("tab", { name: "My card" }));
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Edit card" }));
    await userEvent.type(screen.getByLabelText("Nickname"), "Grace");
    fake.db.card = { revision: 5, values: { nickname: "Other" } }; // someone else changed it
    const before = fake.myCard.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(toastText()).toMatch(/Someone changed this since you loaded it/);
    expect(fake.myCard.mock.calls.length).toBeGreaterThan(before);
  });

  it("renew toasts and re-reads", async () => {
    await mountApp();
    await userEvent.click(screen.getByRole("tab", { name: "Account" }));
    await userEvent.click(screen.getByRole("button", { name: "Renew" }));
    await settle();
    expect(fake.renewMembership).toHaveBeenCalledTimes(1);
    expect(toastText()).toContain("Your membership was renewed.");
  });

  it("leave needs the typed word and a second confirmation, then the page shows Left from a fresh read", async () => {
    await mountApp();
    await userEvent.click(screen.getByRole("tab", { name: "Account" }));
    const leave = screen.getByRole("button", { name: "Leave community" }) as HTMLButtonElement;
    expect(leave.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/Type/), "leave");
    await userEvent.click(screen.getByRole("button", { name: "Leave community" }));
    expect(fake.leaveCommunity).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Yes, leave community/i }));
    await settle();
    expect(fake.leaveCommunity).toHaveBeenCalledWith({ confirm: true });
    expect(toastText()).toContain("You left the community.");
    expect(badge()).toBe("Left");
  });

  it("a refusal is explained in words and the member-only panel shows the refusal, not stale data", async () => {
    fake.db.failing.directoryEntries = notMember();
    await mountApp();
    await userEvent.click(screen.getByRole("tab", { name: "Directory" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/not a member/i);
  });

  it("an action refused by the community toasts the reason and re-reads, but a dead network does not re-read", async () => {
    await mountApp();
    await userEvent.click(screen.getByRole("tab", { name: "Account" }));
    fake.db.failing.renewMembership = refusal(403, "urn:x:vtc:permissionDenied", "nope");
    let before = fake.joinStatus.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Renew" }));
    await settle();
    expect(toastText()).toMatch(/not allowed/i);
    expect(fake.joinStatus.mock.calls.length).toBeGreaterThan(before);

    fake.db.failing.renewMembership = new TypeError("fetch failed");
    before = fake.joinStatus.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Renew" }));
    await settle();
    expect(toastText()).toMatch(/did not answer/i);
    expect(fake.joinStatus.mock.calls.length).toBe(before);
  });
});

describe("approve in another terminal", () => {
  it("is invisible until the page re-reads", async () => {
    const db = freshDb(); db.request = { id: "r1", status: "pending" }; resetWorld(db);
    await mountApp();
    approve(fake.db);
    await settle();
    expect(badge()).toBe("In review");
  });
});
