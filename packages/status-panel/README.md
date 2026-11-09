# @starter/status-panel

A connection-status view for a VTA (and optional VTC). Vanilla TypeScript, no dependencies, no framework:
render into any container. Theme-aware (light/dark) and responsive; CSS is injected once and scoped to `.sp-root`.

```ts
import { mountStatusPanel } from "@starter/status-panel";

const panel = mountStatusPanel(document.getElementById("status")!, {
  mode: "local",                       // or "farm"
  vtaUrl: "http://localhost:8100",     // what the browser calls (farm: a same-origin proxy path)
  credentialPresent: !!credential,
  connect: async () => { const c = await VtaClient.fromCredential(credential, url); await c.authenticate(); return c; },
  pin: { version: "0.65.0", imageTag: "0.65.0-fc157f76", portalDefault: "0.56.0" },
  keyEmbedded: true,                   // shows the "dev-only: key embedded in this page" warning
  vtc: { url: "http://localhost:8200" },   // optional; add `manifest` for the community name
});
await panel.refresh();   // or panel.destroy()
```

See `templates/web-vta-app/src/main.ts` and `vite.config.ts` (injects the pin and VTC settings with Vite `define`).
Adopting it in `community-dashboard`: add the workspace dependency, call `mountStatusPanel` with the same options,
and pass `vtc.manifest: () => vtcClient.manifest()` if you already hold a `VtcClient`.

Card 8, **Key custody**, says where the app key lives, which hardening level that is ([docs/SECURITY.md](../../docs/SECURITY.md)) and the next step. It derives this from `keyEmbedded` (level 0) or the optional `keyCustody: "backend" | "webcrypto"` option, reports only what the page can know, and is advisory: it does not change the overall status pill. Rows come from `custodyRows()` in `src/custody.ts`.

Card 9, **Applicant and messaging**, says which identity applies to the community in this mode and checks the mediator it names.
The rule is the one `npm run vtc:join` and the community dashboard use: tunnel mode applies as a `did:peer:2` whose `TSPTransport` service names
the stack's mediator, unless `VTC_APPLICANT=did:key`, there is no mediator DID, or the `did:peer:2` would be over 1000 bytes (then the did:key,
with the reason); local and farm mode apply as the did:key. The panel does not depend on `tsp-client`, so the host page passes what it knows in
the optional `applicant` option: `{ kind: "did:key" | "did:peer", did?, why?, mediatorDid?, appliesAs? }` (a programmatic option, not a setting;
`applicantRule()` computes `kind`/`why` without the size check for a page that does not build the DID). In tunnel mode the card shows:

- **Applicant**: `did:peer:2 naming the stack's mediator`, `did:key (fallback from did:peer:2)` with why, or `did:key (VTC_APPLICANT=did:key)`.
- **Applicant DID size** and **Mediator DID size**: UTF-8 bytes against the 1000-byte limit of the affinidi DID resolver (`DIDCacheClient`,
  `max_did_size_in_bytes`) the mediator and the VTC use; a warning from 900 bytes, a problem above 1000 ([docs/MESSAGING.md](../../docs/MESSAGING.md)).
- **Mediator DID**: from `applicant.mediatorDid` (`.vta/tunnel.json`), else the one the VTA's DID document advertises.
- **Mediator did:webvh resolves at its tunnel host**: the page fetches `https://<host>/.well-known/did.jsonl` (host and optional path parsed from
  the did:webvh, percent-encoded port included) and checks that the last log entry's `id` is the mediator DID. The mediator sends no CORS headers
  unless `MEDIATOR_CORS_ALLOW_ORIGIN` names the page's origin, so usually the row reads "the host answers but this page cannot read it (CORS)":
  that is a browser limit, not a stack fault; `npm run tunnel:probe` checks it from Node, and `MEDIATOR_CORS_ALLOW_ORIGIN=<origin>` is offered
  as optional. A mediator DID that is not a did:webvh is not checked.

Local mode: messaging is off, the applicant is the did:key, nothing is fetched. Farm mode: the did:key, the mediator is not checked. The card is
advisory (it does not change the overall status pill; the Messaging row in card 2 does that for a degraded VTA). Rows come from
`applicantCardRows()` in `src/applicant.ts`; the behaviour is unit-tested and verified live 2026-10-30 (one machine, one run).

The panel never prints the credential. Pure helpers (DID-document services, version comparison, discovery grouping,
compatibility hints) live in `src/parse.ts` and are exported; tests: `npm test -w @starter/status-panel`.
