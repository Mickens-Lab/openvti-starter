// The "Identity" section with a fake did.jsonl reader (no network): collapsed until opened, the did:peer decoded with its keys and
// the mediator it names, the mediator document beside it, an honest CORS message when it cannot be read, and local mode in the page.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { didPeerFromSeed } from "@starter/tsp-client";
import { IdentityPanel } from "../../src/components/IdentityPanel.tsx";
import type { MediatorRead } from "../../src/identity.ts";
import { freshDb } from "./fake.ts";
import { mountApp, resetWorld } from "./harness.tsx";

const MED = "did:webvh:QmScid:med.example.test";
const ORIGIN = "http://localhost:5173";
const peer = didPeerFromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 7), MED);

const DOC: MediatorRead = {
  ok: true, url: "https://med.example.test/.well-known/did.jsonl", idMatches: true,
  doc: {
    id: MED,
    verificationMethods: [{ id: `${MED}#key-0`, type: "Multikey", publicKey: "z6MkPublicExample" }],
    relationships: [{ name: "authentication", ids: [`${MED}#key-0`] }],
    services: [{ id: `${MED}#tsp`, type: "TSPTransport", endpoint: "https://med.example.test/tsp" }],
  },
};

const open = async () => { await userEvent.click(screen.getByText("Identity")); await act(async () => { await Promise.resolve(); }); };

describe("Identity section", () => {
  it("is collapsed and reads nothing until opened; then shows the decoded did:peer beside the mediator's DID document", async () => {
    const read = vi.fn(async () => DOC);
    render(<IdentityPanel mode="tunnel" did={peer.did} applicant={{ kind: "did:peer", mediatorDid: MED }} origin={ORIGIN} read={read} />);
    const panel = screen.getByRole("group", { name: "Identity" });
    expect(panel.hasAttribute("open")).toBe(false);
    expect(read).not.toHaveBeenCalled();
    await open();
    expect(read).toHaveBeenCalledWith(MED, ORIGIN);
    expect(panel.textContent).toContain("This page applies as a did:peer:2 whose TSPTransport service names the stack's mediator.");
    const keys = within(screen.getByRole("list", { name: "Keys" })).getAllByRole("listitem").map((li) => li.textContent);
    expect(keys[0]).toMatch(/^#key-1 X25519, keyAgreement: z/);
    expect(keys[1]).toMatch(/^#key-2 Ed25519, authentication: z/);
    const services = screen.getAllByRole("list", { name: "Services" });
    expect(services[0].textContent).toBe(`#service TSPTransport: ${MED}`);
    expect(panel.textContent).toContain(`Mediator named by the TSPTransport service: ${MED}`);
    expect(panel.textContent).toContain("Read from https://med.example.test/.well-known/did.jsonl.");
    expect(panel.textContent).toContain("does not check the log's hashes or proofs");
    expect(screen.getByRole("list", { name: "Verification methods" }).textContent).toBe(`${MED}#key-0 Multikey: z6MkPublicExample`);
    expect(services[1].textContent).toBe(`${MED}#tsp TSPTransport: https://med.example.test/tsp`);
    expect(panel.textContent).not.toContain(peer.secretJwk.d);
  });

  it("says honestly when the browser cannot read the mediator, keeps the applicant side, and can read again", async () => {
    const fail: MediatorRead = { ok: false, url: DOC.ok ? DOC.url : "", text: `Could not read the mediator's DID document from this page (Failed to fetch). The applicant side above does not need it.\n\nMEDIATOR_CORS_ALLOW_ORIGIN=${ORIGIN}` };
    const read = vi.fn<(d: string, o: string) => Promise<MediatorRead>>().mockResolvedValueOnce(fail).mockResolvedValueOnce(DOC);
    render(<IdentityPanel mode="tunnel" did={peer.did} applicant={{ kind: "did:peer", mediatorDid: MED }} origin={ORIGIN} read={read} />);
    await open();
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toMatch(/^Could not read the mediator's DID document/);
    expect(alert).toContain(`MEDIATOR_CORS_ALLOW_ORIGIN=${ORIGIN}`);
    expect(screen.getByRole("list", { name: "Keys" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Read again" }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("list", { name: "Verification methods" })).toBeTruthy();
  });
});

describe("in the page (local mode)", () => {
  beforeEach(() => resetWorld());

  it("shows the did:key decoded and says there is no mediator, without fetching anything", async () => {
    const db = freshDb();
    db.request = { id: "req-1", status: "pending" };
    resetWorld(db);
    await mountApp();
    const before = vi.mocked(fetch).mock.calls.length;
    await open();
    const panel = screen.getByRole("group", { name: "Identity" });
    expect(panel.textContent).toContain("This page applies as its did:key.");
    expect(panel.textContent).toMatch(/A did:key is its public key/);
    expect(within(panel).getByRole("list", { name: "Keys" }).textContent).toMatch(/^#z6Mk\S+ Ed25519, authentication, assertionMethod: z6Mk/);
    expect(panel.textContent).toContain("No mediator in local mode");
    expect(within(panel).queryByRole("list", { name: "Services" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  });
});
