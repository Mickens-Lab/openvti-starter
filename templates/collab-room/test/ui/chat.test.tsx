// Chat history: ascending by host version, a window of the newest 20 with "Load older", and the markdown toggle.
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { chatList, renderApp, SLOW } from "./harness.tsx";

describe("ChatView", () => {
  it("shows history ascending, loads older messages, and posts markdown when toggled", async () => {
    const { backend } = await renderApp({ history: 30 });
    try {
      await chatList().findByText(/riverside office/, undefined, SLOW);
      const texts = () => Array.from(document.querySelectorAll(".msg")).map((m) => m.querySelector(".plain, .md")?.textContent ?? "");
      expect(texts()).toHaveLength(20);
      expect(texts().some((t) => t === "Earlier message 1 of 30")).toBe(false);
      await act(async () => { screen.getByRole("button", { name: "Load older (12)" }).click(); }); // 32 messages, 20 shown
      expect(screen.queryByRole("button", { name: /Load older/ })).toBeNull();
      const all = texts();
      expect(all[0]).toBe("Earlier message 1 of 30");
      expect(all.indexOf("Earlier message 2 of 30")).toBe(1);
      expect(all.indexOf("Kickoff is Thursday at the riverside office")).toBeGreaterThan(all.indexOf("Earlier message 30 of 30"));

      const toggle = screen.getByRole("button", { name: "Plain text" });
      await act(async () => { toggle.click(); });
      expect(screen.getByRole("button", { name: "Markdown on" }).getAttribute("aria-pressed")).toBe("true");
      await userEvent.type(screen.getByLabelText("Message"), "a **bold** move");
      await act(async () => { screen.getByRole("button", { name: "Send" }).click(); });
      const strong = await chatList().findByText("bold", { selector: "strong" }, SLOW);
      expect(strong.closest(".msg")?.className).toContain("mine");
    } finally { backend.close(); }
  });
});
