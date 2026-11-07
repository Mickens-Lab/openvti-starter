// Live updates: the simulated member posts on the mock host, the member's poll (on a ManualClock) picks it up, and the
// message appears with no reload. The LiveBadge follows the poll status.
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BOB_SCRIPT } from "../../src/mock.ts";
import { chatList, renderApp, SLOW } from "./harness.tsx";

describe("live updates", () => {
  it("a new item pushed by the simulated member appears without reload", async () => {
    const { backend, advance } = await renderApp({ everyMs: 10_000 });
    try {
      expect(screen.getByRole("status").textContent).toBe("Connecting");
      await advance(0);                       // the first poll
      expect(screen.getByRole("status").textContent).toMatch(/^Live/);
      expect(chatList().queryByText(BOB_SCRIPT[0])).toBeNull();

      await advance(10_000);                  // Bob's timer: he posts into the open room
      await backend.idle();
      await advance(3_000);                   // the member's next poll
      expect(await chatList().findByText(BOB_SCRIPT[0], undefined, SLOW)).toBeTruthy();
      // Hidden tab: the poll source slows down; visible again: back to 3 s.
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(await screen.findByText(/tab hidden/)).toBeTruthy();
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(await screen.findByText(/every 3 s/)).toBeTruthy();
    } finally { backend.close(); }
  });
});
