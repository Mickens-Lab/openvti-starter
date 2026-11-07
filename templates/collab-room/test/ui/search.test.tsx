// Search mode toggle: "File names" finds files by name only; "Full text" finds chat, notes and text-file content with a
// highlighted snippet, and a result jumps to the item.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp, SLOW } from "./harness.tsx";

const results = () => within(screen.getByRole("list", { name: "Search results" }));

describe("search", () => {
  it("toggles between file-name and full-text results", async () => {
    const { backend } = await renderApp();
    try {
      const box = screen.getByLabelText("Search");
      expect(screen.getByRole("button", { name: "File names" }).getAttribute("aria-pressed")).toBe("true");

      await userEvent.type(box, "celebration");
      await waitFor(() => expect(results().getByText("File: celebration.gif")).toBeTruthy(), SLOW);
      expect(results().getByText("celebration", { selector: "mark" })).toBeTruthy();

      await userEvent.clear(box);
      await userEvent.type(box, "riverside");
      await waitFor(() => expect(results().getByText("No matches.")).toBeTruthy(), SLOW);

      await act(async () => { screen.getByRole("button", { name: "Full text" }).click(); });
      await waitFor(() => expect(results().getByText("Chat message")).toBeTruthy(), SLOW);
      expect(results().getByText("riverside", { selector: "mark" })).toBeTruthy();

      await userEvent.clear(box);
      await userEvent.type(box, '"contingency reserve"');
      await waitFor(() => expect(results().getByText("File: budget-notes.txt")).toBeTruthy(), SLOW);

      await userEvent.clear(box);
      await userEvent.type(box, "riverside");
      const hit = await results().findByRole("button", { name: /Chat message/ }, SLOW);
      await act(async () => { hit.click(); });
      expect(screen.getByRole("tab", { name: /^Chat/ }).getAttribute("aria-selected")).toBe("true");
      await waitFor(() => expect(document.querySelector(".msg.focused")?.textContent).toMatch(/riverside office/));

      await act(async () => { screen.getByRole("button", { name: "File names" }).click(); });
      await userEvent.clear(box);
      await userEvent.type(box, "site-plan");
      const file = await results().findByRole("button", { name: /File: site-plan.png/ }, SLOW);
      await act(async () => { file.click(); });
      expect(screen.getByRole("tab", { name: /^Files/ }).getAttribute("aria-selected")).toBe("true");
      await waitFor(() => expect(document.querySelector(".file-item.focused .file-name")?.textContent).toBe("site-plan.png"));
    } finally { backend.close(); }
  });
});
