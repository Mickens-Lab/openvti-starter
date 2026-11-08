// Runs before every test file: a throwaway credential (generated here, never stored) and a quiet network.
import { afterEach, vi } from "vitest";
import { fake } from "./fake.ts";
import { cleanup } from "@testing-library/react";
import { encodeCredential, newIdentity, seedToMultibase } from "@starter/vta-client";

const id = newIdentity();
vi.stubEnv("VTA_CREDENTIAL", encodeCredential({ did: id.did, privateKeyMultibase: seedToMultibase(id.seed), vtaDid: "did:example:vta" }));
vi.stubEnv("VTC_DID", "did:example:community");
// The public profile is plain REST; the fake community serves none unless a test says otherwise.
vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
afterEach(() => { cleanup(); });

// The page connects with VtcClient.connect(); hand it the fake community instead of the network.
vi.mock("@starter/vtc-client", async (orig) => ({ ...(await orig<typeof import("@starter/vtc-client")>()), VtcClient: { connect: async () => fake } }));
