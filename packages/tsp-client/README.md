# @starter/tsp-client

Talk to the VTA over TSP through the mediator (`MODE=tunnel`, [docs/MESSAGING.md](../../docs/MESSAGING.md)): log in to the mediator as a `did:key` or a `did:peer:2`, open the raw-TSP socket, send a signed
`messaging/ping/0.2` and read the pong, or receive frames (the credential pushes from the VTC). TSP 1.0, built on `@openvtc/pnm-core`'s login and socket helpers.
Node 22+ and browsers (a browser needs the mediator's CORS opened for its origin, [docs/MODES.md](../../docs/MODES.md)). DEV ONLY.

```ts
import { describePong, tspPing } from "@starter/tsp-client";
import { decodeCredential, seedFromMultibase } from "@starter/vta-client";

// vtaDid: VTA_DID in .env; mediatorDid: .vta/tunnel.json after `npm run up -- --tunnel`.
const seed = seedFromMultibase(decodeCredential(process.env.VTA_CREDENTIAL!).privateKeyMultibase);   // the VTA only answers DIDs on its ACL
const r = await tspPing({ vtaDid, mediatorDid, seed, log: console.log });
console.log(describePong(r));     // "pong from the VTA in 120 ms: status ok, protocols [tsp, didcomm, ...]"
```

## What is in it

| | |
|---|---|
| `tspPing(opts)` | Log in, form the TSP relationship, send the ping, return the pong (`PingResult`). Throws if no pong arrives within `timeoutMs`. |
| `connectTsp(opts)` | The connection without the ping: `{ did, conn, session, close() }`. `conn.onInboundTsp(fn)` receives frames; `session.open(bytes)` decrypts one; `session.relate()` and `session.request()` send. [scripts/tsp-listen.ts](../../scripts/tsp-listen.ts) is a working listener. |
| `describePong`, `isPong` | One readable line from a pong; check a reply is a pong for your nonce. |
| `wrapEnvelope`, `openEnvelope`, `TSP_BINDING_TYPE` | The Trust Task TSP binding envelope. |
| `emitTspTrace` | Reports each ping to the shared trace (`TRACE=1`). |
| `didPeerFromSeed(seed, mediatorDid)` | A deterministic `did:peer:2` (X25519 `#key-1`, Ed25519 `#key-2`, `TSPTransport` -> mediator DID) with a Trust Task signer, its TSP keys and the mediator-login secret. `parseDidPeer2`, `tspMediatorOf` read one back. |
| `connectTsp({ identity })` / `clientKeys` | Log in to the mediator and open TSP frames as that did:peer instead of a did:key. |
| `frameOf(m)`, `record(tally, frame)`, `emptyTally()`, `ISSUE_TYPE` | Pure: an opened frame's kind (relationship control type, or the Trust Task document type; never the credential) and a running count. Shared by `npm run tsp:listen` and the community dashboard's "Credential frames" panel. |

## Limits

- Ping-shaped: there is no general `call(type, payload)` or `listen(handler)` yet; other tasks mean using `session.request()` with a document you build and sign (`@openvtc/pnm-core` `buildTrustTask`, `signOutboundTask`).
- DIDComm is not implemented. `didPeerFromSeed` gives a `did:peer:2` whose `TSPTransport` service names the mediator, and `connectTsp({ identity })` listens as it; nothing verifies or stores the credential. `didPeerFromSeed` refuses a DID over the resolver's 1000-byte limit; with the kit's `did:webvh` tunnel mediator the did:peer is about 290 bytes ([docs/MESSAGING.md](../../docs/MESSAGING.md#tunnel-mode-delivers-the-credential-to-the-applicant)).
