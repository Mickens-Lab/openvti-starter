// Runs before every test file. jsdom has no URL.createObjectURL: stub it with numbered blob: URLs and record revokes, so
// tests can check that images are shown through blob: URLs and released on unmount.
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

export const objectUrls = { created: [] as { url: string; type: string }[], revoked: [] as string[] };
let n = 0;
vi.stubGlobal("URL", Object.assign(URL, {
  createObjectURL: (b: Blob) => { const url = `blob:http://localhost/test-${++n}`; objectUrls.created.push({ url, type: b.type }); return url; },
  revokeObjectURL: (u: string) => { objectUrls.revoked.push(u); },
}));
// Nothing in mock mode touches the network; fail loudly if something tries.
vi.stubGlobal("fetch", vi.fn(async (u: unknown) => { throw new Error(`unexpected network call in a UI test: ${String(u)}`); }));
afterEach(() => { cleanup(); });
