// Both tiers in the UI: the open room and the MLS-sealed attributed room open, show their history, and take a post.
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SEALED_ROOM } from "../../src/mock.ts";
import { chatList, renderApp, SLOW, tab } from "./harness.tsx";

async function post(text: string) {
  await userEvent.type(screen.getByLabelText("Message"), text);
  await act(async () => { screen.getByRole("button", { name: "Send" }).click(); });
  return chatList().findByText(text, undefined, SLOW);
}

describe("rooms", () => {
  it("open and sealed rooms both work", async () => {
    const { backend } = await renderApp();
    try {
      expect(screen.getByText("open (plaintext)")).toBeTruthy();
      expect(await chatList().findByText(/riverside office/, undefined, SLOW)).toBeTruthy();
      await post("open room hello");

      await act(async () => { screen.getByRole("button", { name: /Deal room/ }).click(); });
      expect(await screen.findByText("sealed (attributed)", undefined, SLOW)).toBeTruthy();
      expect(await chatList().findByText(/the host stores only ciphertext/, undefined, SLOW)).toBeTruthy();
      await post("sealed room hello");
      // Sealed for real: the host holds no plaintext of the new message.
      expect(new TextDecoder().decode(backend.host.storedBytes(SEALED_ROOM))).not.toContain("sealed room hello");

      await tab(/^Notes/);
      expect(await screen.findByRole("heading", { name: "Term sheet", level: 3 }, SLOW)).toBeTruthy();
      await act(async () => { screen.getByRole("button", { name: "Edit" }).click(); });
      const body = screen.getByLabelText("Body (markdown)");
      await userEvent.type(body, "\n- escrow: agreed");
      await act(async () => { screen.getByRole("button", { name: "Save new version" }).click(); });
      await waitFor(() => expect(screen.getByText(/version 2/)).toBeTruthy(), SLOW);
      expect(screen.getByText("escrow: agreed")).toBeTruthy();

      await tab(/^Files/);
      expect(await screen.findByRole("img", { name: "sealed-wave.gif" }, SLOW)).toBeTruthy();
      const big = new File([new Uint8Array(300 * 1024)], "big.bin", { type: "application/octet-stream" });
      await userEvent.upload(screen.getByLabelText("Upload a file"), big);
      expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toMatch(/32 KiB/);
    } finally { backend.close(); }
  });
});
