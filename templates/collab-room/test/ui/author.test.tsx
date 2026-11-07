// Attribution: the room profile's name and avatar, "You" for self, the short DID (full DID in the tooltip) otherwise.
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { shortDid } from "@buildathon/rooms-client";
import { describe, expect, it } from "vitest";
import { BOB_NAME } from "../../src/mock.ts";
import { chatList, renderApp, SLOW } from "./harness.tsx";

describe("Author", () => {
  it("shows Bob's profile name and avatar, Carol's short DID, and You for self", async () => {
    const { backend } = await renderApp();
    try {
      const chat = chatList();
      const bob = (await chat.findAllByText(BOB_NAME, undefined, SLOW))[0].closest(".author") as HTMLElement;
      expect(bob.getAttribute("title")).toBe(backend.bob.did);
      expect(bob.querySelector("img.avatar")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

      const short = shortDid(backend.carol.did);
      expect(short.length).toBeLessThan(backend.carol.did.length);
      const carol = chat.getAllByText(short)[0].closest(".author") as HTMLElement;
      expect(carol.getAttribute("title")).toBe(backend.carol.did);
      expect(carol.querySelector("svg.identicon")).not.toBeNull();
      expect(carol.querySelector("img")).toBeNull();

      await userEvent.type(screen.getByLabelText("Message"), "hello from me");
      await act(async () => { screen.getByRole("button", { name: "Send" }).click(); });
      const mine = await chat.findByText("hello from me", undefined, SLOW);
      const author = mine.closest(".msg")!.querySelector(".author") as HTMLElement;
      expect(author.textContent).toBe("You");
      expect(author.getAttribute("title")).toContain(backend.self);
      await waitFor(() => expect(mine.closest(".msg")?.className).toContain("mine"));
    } finally { backend.close(); }
  });
});
