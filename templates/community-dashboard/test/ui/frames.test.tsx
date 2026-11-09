// The "Credential frames" panel with a fake listener (no mediator, no network): the button, each state, frames as they arrive,
// Stop and unmount closing the socket, a failed connect's CORS line, and the local-mode explanation in the real page.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ISSUE_TYPE, type Frame } from "@starter/tsp-client";
import { FramesPanel } from "../../src/components/FramesPanel.tsx";
import type { ListenHandlers, StartListener } from "../../src/listener.ts";
import type { FramesGate } from "../../src/frames.ts";
import { freshDb } from "./fake.ts";
import { mountApp, resetWorld } from "./harness.tsx";

const MED = "did:webvh:QmScid:med.example.test";
const ORIGIN = "http://localhost:5173";

function fakeListener() {
  let h: ListenHandlers | undefined;
  let ok: () => void = () => {};
  let fail: (e: unknown) => void = () => {};
  const stop = vi.fn();
  const start = vi.fn<StartListener>((handlers) => {
    h = handlers;
    return new Promise((res, rej) => { ok = () => res({ did: "did:example:app", stop }); fail = rej; });
  });
  return {
    start, stop,
    connect: () => act(async () => { ok(); }),
    reject: (e: unknown) => act(async () => { fail(e); }),
    frame: (f: Frame) => act(() => { h!.onFrame(f); }),
    closed: () => act(() => { h!.onClosed(); }),
  };
}

const status = () => screen.getAllByRole("status").find((e) => e.closest("details"))?.textContent ?? "";
const listenButton = () => screen.queryByRole("button", { name: "Listen for credential frames" });

function mount(gate: FramesGate = { listen: true, relate: false, mediatorDid: MED }) {
  const l = fakeListener();
  const r = render(<FramesPanel gate={gate} start={l.start} origin={ORIGIN} did="did:peer:2.Example" />);
  return { ...l, ...r };
}

describe("Credential frames panel", () => {
  it("starts on the button, shows frames as they arrive with a running tally, and Stop closes the socket", async () => {
    const l = mount();
    expect(status()).toBe("not listening");
    expect(screen.getByText(/^Frames arriving is not credentialsDelivered/)).toBeTruthy();
    expect(screen.getByText(/one live-delivery socket per DID/)).toBeTruthy();
    expect(screen.getByText(`MEDIATOR_CORS_ALLOW_ORIGIN=${ORIGIN}`)).toBeTruthy();
    await userEvent.click(listenButton()!);
    expect(l.start).toHaveBeenCalledTimes(1);
    expect(l.start.mock.calls[0][1]).toEqual({ relate: false, mediatorDid: MED });
    expect(status()).toMatch(/^connecting to the mediator/);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    await l.connect();
    expect(status()).toBe("listening");
    expect(screen.getByText(/^No credential-exchange\/issue\/0\.1 frame yet/)).toBeTruthy();
    await l.frame({ control: "invite" });
    await l.frame({ documentType: ISSUE_TYPE });
    await l.frame({ unreadable: "sealed by someone else" });
    const items = screen.getByRole("list", { name: "Frames received" }).querySelectorAll("li");
    expect(Array.from(items).map((li) => li.textContent!.slice(li.querySelector("time")!.textContent!.length).trim())).toEqual(["relationship invite", "credential-exchange/issue/0.1", "unreadable, or not from the VTC"]);
    expect(items[0].querySelector("time")).toBeTruthy();
    expect(screen.getByText("3 frames: 1 invite, 0 accept, 1 credential-exchange/issue, 0 other, 1 unreadable")).toBeTruthy();
    expect(screen.getByText(/^1 credential-exchange\/issue\/0\.1 frame arrived from the VTC/)).toBeTruthy();
    expect(document.querySelector("summary")?.textContent).toContain("listening, 3 frames");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(l.stop).toHaveBeenCalledTimes(1);
    expect(status()).toBe("stopped");
    expect(listenButton()).toBeTruthy();
    await l.frame({ documentType: ISSUE_TYPE }); // a late frame from the closed run is ignored
    expect(screen.getByText(/^3 frames/)).toBeTruthy();
  });

  it("a did:key applicant says it invites the VTC first and asks the listener to relate", async () => {
    const l = mount({ listen: true, relate: true, mediatorDid: MED });
    expect(screen.getByText(/sends the VTC a relationship invite/)).toBeTruthy();
    await userEvent.click(listenButton()!);
    expect(l.start.mock.calls[0][1]).toEqual({ relate: true, mediatorDid: MED });
  });

  it("a failed connect explains the exact MEDIATOR_CORS_ALLOW_ORIGIN line, even when the resolver wrapped the fetch error", async () => {
    const l = mount();
    await userEvent.click(listenButton()!);
    await l.reject(new Error("did:webvh resolve failed: invalidDid — Failed to fetch"));
    expect(status()).toBe("could not start");
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toMatch(/^Could not start listening: did:webvh resolve failed/);
    expect(alert).toContain(`\nMEDIATOR_CORS_ALLOW_ORIGIN=${ORIGIN}\n`);
    expect(alert).toContain("docker compose --profile messaging up -d mediator");
    expect(listenButton()).toBeTruthy(); // try again after fixing it
  });

  it("Stop while connecting closes the connection once it opens", async () => {
    const l = mount();
    await userEvent.click(listenButton()!);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await l.connect();
    expect(l.stop).toHaveBeenCalledTimes(1);
    expect(status()).toBe("stopped");
  });

  it("unmounting closes the socket, and a socket that drops says so", async () => {
    const a = mount();
    await userEvent.click(listenButton()!);
    await a.connect();
    await a.closed();
    expect(status()).toBe("the socket closed");
    expect(listenButton()).toBeTruthy();
    a.unmount();
    const b = mount();
    await userEvent.click(listenButton()!);
    await b.connect();
    b.unmount();
    expect(b.stop).toHaveBeenCalledTimes(1);
  });

  it("explains instead of offering the button when it cannot listen", () => {
    mount({ listen: false, title: "Not available in farm mode", text: "The kit runs no mediator for a hosted community." });
    expect(listenButton()).toBeNull();
    expect(screen.getByText("Not available in farm mode")).toBeTruthy();
  });
});

describe("in the page (local mode)", () => {
  beforeEach(() => resetWorld());

  it("is shown collapsed on the in-review screen with the local-mode explanation and no button", async () => {
    const db = freshDb();
    db.request = { id: "req-1", status: "pending" };
    resetWorld(db);
    await mountApp();
    const panel = screen.getByRole("group", { name: "Credential frames" });
    expect(panel.hasAttribute("open")).toBe(false);
    expect(panel.textContent).toContain("No mediator in local mode");
    expect(panel.textContent).toContain("MODE=tunnel turns messaging on");
    expect(listenButton()).toBeNull();
  });

  it("is not shown to a visitor who has not applied", async () => {
    await mountApp();
    expect(screen.queryByRole("group", { name: "Credential frames" })).toBeNull();
  });
});
