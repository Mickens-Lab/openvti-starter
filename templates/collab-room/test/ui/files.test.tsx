// File items: PNG and GIF shown as <img> through blob: URLs by their sniffed type, revoked on unmount; SVG and a
// mislabelled file (claims image/png, is HTML) are download-only; text and markdown files are shown inert.
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, SLOW, tab } from "./harness.tsx";
import { objectUrls } from "./setup.ts";

const fileCard = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(".file-item")).find((el) => el.querySelector(".file-name")?.textContent === name)!;

describe("files", () => {
  it("renders images by sniffed bytes only and revokes their blob: URLs on unmount", async () => {
    const { backend, view } = await renderApp();
    try {
      await tab(/^Files/);
      const png = await screen.findByRole("img", { name: "site-plan.png" }, SLOW);
      const gif = await screen.findByRole("img", { name: "celebration.gif" }, SLOW);
      expect(png.getAttribute("src")).toMatch(/^blob:/);
      expect(gif.getAttribute("src")).toMatch(/^blob:/);
      const types = Object.fromEntries(objectUrls.created.map((c) => [c.url, c.type]));
      expect(types[png.getAttribute("src")!]).toBe("image/png");
      expect(types[gif.getAttribute("src")!]).toBe("image/gif");

      await waitFor(() => expect(fileCard("photo.png").querySelector(".file-body")?.getAttribute("data-view")).toBe("download"), SLOW);
      for (const name of ["diagram.svg", "photo.png"]) {
        const card = fileCard(name);
        expect(card.querySelector(".file-body img")).toBeNull();
        expect(card.querySelector("svg script, script")).toBeNull();
        expect(card.querySelector("button")?.textContent).toBe("Download");
      }
      expect(fileCard("diagram.svg").textContent).toMatch(/SVG files are never displayed/);
      expect(fileCard("photo.png").textContent).toMatch(/not a PNG, JPEG, GIF or WebP/);

      await waitFor(() => expect(fileCard("budget-notes.txt").querySelector("pre")?.textContent).toMatch(/contingency reserve/), SLOW);
      await waitFor(() => expect(fileCard("room-guide.md").querySelector(".md strong")?.textContent).toBe("notes"), SLOW);

      const shown = [png.getAttribute("src")!, gif.getAttribute("src")!];
      view.unmount();
      for (const u of shown) expect(objectUrls.revoked).toContain(u);
    } finally { backend.close(); }
  });
});
