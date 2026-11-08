// Renders the App on a fresh mock backend whose polls and simulated member run on a ManualClock.
import { act, render, screen, within } from "@testing-library/react";
import { ManualClock } from "@starter/rooms-client/mock";
import { App } from "../../src/App.tsx";
import { createMockBackend, type MockOpts } from "../../src/mock.ts";

export const SLOW = { timeout: 8000 };

export async function renderApp(o: MockOpts = {}) {
  const clock = new ManualClock();
  const backend = await createMockBackend({ clock, everyMs: 0, history: 3, ...o });
  const view = render(<App backend={backend} />);
  await screen.findByRole("tab", { name: /^Chat/ }, SLOW);
  const advance = (ms: number) => act(() => clock.advance(ms));
  return { clock, backend, view, advance };
}

export const tab = (name: RegExp) => act(async () => { (await screen.findByRole("tab", { name })).click(); });
export const chatList = () => within(screen.getByRole("region", { name: "Chat" }));
