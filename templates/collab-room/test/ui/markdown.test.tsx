// Markdown from a room is rendered inert in the real DOM: no <script>, no javascript: links, no fetched images.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextBody } from "../../src/components/ItemBody.tsx";
import { HOSTILE_NOTE } from "../../src/mock.ts";
import { renderMarkdown } from "../../src/render.ts";
import { renderApp, SLOW, tab } from "./harness.tsx";

describe("markdown is inert", () => {
  it("raw HTML and <script> stay text; javascript: is not a link; images are links", () => {
    const { container } = render(<div>{renderMarkdown(HOSTILE_NOTE)}</div>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(container.textContent).toContain("<script>alert('not run')</script>");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.every((a) => /^https?:|^mailto:/.test(a.getAttribute("href") ?? ""))).toBe(true);
    expect(links.every((a) => a.getAttribute("rel") === "noopener noreferrer")).toBe(true);
    expect(container.textContent).toContain("[Click me](javascript:alert(1))");
    expect(screen.getByRole("link", { name: "the spec" }).getAttribute("href")).toBe("https://example.org/spec");
    expect(container.textContent).toContain("(https://example.org/spec)");
    expect(screen.getByRole("link", { name: "Image: tracking pixel" }).getAttribute("href")).toBe("https://example.org/pixel.png");
    expect(container.querySelector("h3")?.textContent).toBe("Kickoff agenda");
    expect(container.querySelector("blockquote")).not.toBeNull();
    expect(container.querySelector("pre code")?.textContent).toContain("quotes.reduce");
  });

  it("plain text chat shows markdown and HTML literally", () => {
    const { container } = render(<TextBody text={"**bold** <b>x</b>"} format="text/plain" />);
    expect(container.querySelector("strong, b")).toBeNull();
    expect(container.textContent).toBe("**bold** <b>x</b>");
  });

  it("the seeded hostile note renders inert inside the app", async () => {
    const { backend, view } = await renderApp();
    try {
      await tab(/^Notes/);
      await screen.findAllByRole("heading", { name: "Kickoff agenda", level: 3 }, SLOW);
      expect(view.container.querySelector("script")).toBeNull();
      expect(view.container.querySelector('a[href^="javascript"]')).toBeNull();
      expect(view.container.querySelector("img[src*='example.org']")).toBeNull();
    } finally { backend.close(); }
  });
});
