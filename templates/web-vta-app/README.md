# Web VTA app

Vite + TypeScript. The page authenticates to your VTA with `@starter/vta-client`
over plain `fetch` (the VTA allows CORS for `http://localhost:5173`) and renders a live
**connection-status view** (`@starter/status-panel`) by default: whether the VTA is
reachable (and round-trip time), its DID and DID-document services, the `vta-service`
version against the pin in `pins.json`, your session (role, scopes, context, expiry),
the Trust Task capabilities grouped by family (with acl/grant and discovery compatibility
hints), whether `window.vtaWallet` is present, and, if `VTC_URL` is in the root `.env`,
the community's `/health` and join manifest, and (card 9, "Applicant and messaging") which identity `npm run vtc:join` and the
community dashboard apply as in this mode, the mediator's DID size against the 1000-byte resolver limit, and whether the mediator's
did:webvh resolves at its tunnel host (this page itself does not apply to the community; it does not build the did:peer:2, so it does
not check that DID's size). Each row has an ok/warn/bad/unknown pill and
a plain-words explanation; raw JSON sits under "details". Refresh with the button or the
auto-refresh menu. If the wallet is present it also offers a profile lookup and a
wallet-signed Trust Task. Without the wallet, the rest still works.

In tunnel mode only, a banner above the panel says the public hosts and DIDs (VTA, VTC, mediator, and the applicant `did:peer:2` that
names the mediator) die at `npm run down` and are new after the next `npm run up -- --tunnel`; do not bookmark or share them beyond the
run. The wording is `tunnelBanner` from `@starter/status-panel` (unit-tested; the panel's Mode row says the same in short); verified live 2026-10-30 (one machine, one run).

With nothing reachable the page still renders and says what to fix (VTA down, CORS
blocked, credential missing, wrong version image in farm mode).

```sh
npm run up                              # repo root, once
npm run dev -w @starter/web-vta-app      # http://localhost:5173
npm run build -w @starter/web-vta-app
```

The dev server prefers 5173 but runs on any port (Vite moves to 5174 when 5173 is busy; `-- --port 3050` works too). The page calls
`/__vta` (and `/__vtc`) on its own origin and Vite forwards to `VTA_URL` / `VTC_URL`, so the browser never makes a cross-origin call and the
VTA's CORS list does not matter. The proxy lives in `../../scripts/lib/dev-proxy.ts`, shared by the templates.

## Notes

- **Credential in the page.** `vite.config.ts` reads the repo-root `.env` and
  exposes `VTA_URL` and `VTA_CREDENTIAL` to the page. That puts a private key in
  the browser: fine for a throwaway local VTA, wrong for anything else. Move
  calls behind a small backend, or sign with the wallet.
- **Calling the VTA directly.** Only needed if you leave the dev proxy (a built page, another dev server). The VTA then answers only the
  origins in its CORS list (loopback ports 3000-3009, 3050, 4000-4009, 4173, 5173-5183, 8000-8009). For another one set
  `CORS_ORIGINS_TOML='"http://localhost:4200"'` (this replaces the list) and run `npm run reset && npm run up`.
- **Wallet API.** The local `window.vtaWallet` typing in `src/main.ts` covers
  only `walletProfile` and `signTrustTask`; the full surface is in
  `vta-browser-plugin/packages/extension/src/bridge-protocol.ts` (login,
  proxyLogin, vaultList, disclose, ...). The wallet branch was not run against a
  real extension.
- `@openvtc/vti-didcomm-js` refuses `http:` and loopback endpoints by default;
  this template does not use it.
