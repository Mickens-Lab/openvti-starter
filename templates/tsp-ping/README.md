# TSP ping page

Vite + TypeScript. Sends a signed `messaging/ping/0.2` to the VTA over TSP from the browser, with the same `tspPing()` as `npm run tsp:ping` (`@starter/tsp-client`).
`MODE=tunnel` only; the form is prefilled from `.vta/tunnel.json` and the root `.env`.

```sh
MODE=tunnel MEDIATOR_CORS_ALLOW_ORIGIN=http://localhost:3000 npm run up   # repo root; opens the mediator to this page
npm run dev -w @starter/tsp-ping                                        # http://localhost:3000
npm run tsp:ping:browser                                                   # the same, driven by headless Chromium
```

- **Status.** With the pinned images (mediator 0.48.0, which reads TSP 1.0) the page logs in, opens the socket, sends the ping and shows the VTA's pong (`pong from the VTA ... nonce echoed`). Details: [docs/MESSAGING.md](../../docs/MESSAGING.md) **[verified]**.
  An older mediator that reads only Rev 3 makes it show "No pong: timed out awaiting reply frame".
- **Credential in the page.** Like `web-vta-app`, `vite.config.ts` puts `VTA_CREDENTIAL` (a private key) in the page. Dev only. A blank field uses a throwaway `did:key`, which the VTA refuses (403).
- **CORS.** The mediator refuses a browser origin unless `MEDIATOR_CORS_ALLOW_ORIGIN` names it ([docs/MODES.md](../../docs/MODES.md)); port 3000 is also in the VTA and VTC defaults. This page cannot use the Vite proxy the other templates use: the mediator's URL comes from its DID document, so the page connects to it directly. It also fetches that DID document (a `did:webvh`, `https://<mediator host>/.well-known/did.jsonl`) cross-origin, so without the setting it fails earlier, with `did:webvh resolve failed ... Failed to fetch`. If you serve it on another port (`-- --port 3050`; the origin must match exactly), start the stack with `MEDIATOR_CORS_ALLOW_ORIGIN=http://localhost:3050`. When the `did.jsonl` fetch or the socket fails, the verdict names that exact line for this page's origin (`MEDIATOR_CORS_ALLOW_ORIGIN=<origin>`), the fresh-stack command, and the command that recreates only the running mediator with its host filled in from the mediator DID (`src/verdict.ts`, unit-tested in `test/verdict.test.ts`; verified live 2026-10-30 (one machine, one run)). An error the mediator or VTA did answer (a 403 for a throwaway `did:key`, a timeout) gets no CORS hint.
