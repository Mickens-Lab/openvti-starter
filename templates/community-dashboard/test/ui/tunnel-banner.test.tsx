// The tunnel-mode banner: shown only in tunnel mode, with the shared wording (@starter/status-panel tunnelBanner), and absent
// from the real page in local mode.
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TunnelBanner } from "../../src/components/TunnelBanner.tsx";
import { mountApp, resetWorld } from "./harness.tsx";

describe("Tunnel banner", () => {
  it("in tunnel mode says the hosts and DIDs end at npm run down, with the commands as code", () => {
    render(<TunnelBanner mode="tunnel" />);
    const b = screen.getByRole("note", { name: "Tunnel mode" });
    expect(b.textContent).toMatch(/^Tunnel mode: these hosts and DIDs last only for this run\. The public quick-tunnel hosts and the DIDs of the VTA, the VTC and the mediator, and the applicant did:peer:2 that names the mediator, die at npm run down/);
    expect(b.textContent).toContain("Do not bookmark or share them beyond this run.");
    expect(Array.from(b.querySelectorAll("code")).map((c) => c.textContent)).toEqual(["npm run down", "npm run up -- --tunnel"]);
  });

  it("is absent in local and farm mode", () => {
    const { container } = render(<><TunnelBanner mode="local" /><TunnelBanner mode="farm" /></>);
    expect(container.textContent).toBe("");
  });

  describe("in the page (local mode)", () => {
    beforeEach(() => resetWorld());
    it("shows no tunnel banner", async () => {
      await mountApp();
      expect(screen.queryByRole("note", { name: "Tunnel mode" })).toBeNull();
      expect(document.body.textContent).not.toContain("last only for this run");
    });
  });
});
