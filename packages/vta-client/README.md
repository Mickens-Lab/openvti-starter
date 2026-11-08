# @starter/vta-client

A small Trust Task client for a VTA: it reads the VTA's DID, signs in with a `did:key`, and signs and POSTs any Trust Task. Node and browser (plain `fetch`). DEV ONLY: see [docs/SECURITY.md](../../docs/SECURITY.md).

```ts
import { VtaClient } from "@starter/vta-client";

// VTA_CREDENTIAL is the base64 bundle `npm run up` writes to .env (it holds the app's private key).
const vta = await VtaClient.fromCredential(process.env.VTA_CREDENTIAL!, process.env.VTA_URL);
await vta.authenticate();                      // bearer token, about 15 minutes
console.log(await vta.whoami());               // roles, scopes, capabilities
console.log((await vta.discover()).length);    // the Trust Tasks this VTA serves

// Any task: its type URI and a payload. `npm run vta:call -- --search memory` and `--schema <task>` show what exists.
await vta.call("https://trusttasks.org/spec/vta/memory/put/0.1", { contextId: "my-app", key: "k", value: "v" });
```

## What is in it

| | |
|---|---|
| `VtaClient.fromCredential(credential, url?)` / `connect(url, identity)` | Build a client. Does not authenticate. `resolveDid: false` trusts the DID in the credential (farm mode). |
| `vta.personaIdentity(did, keyId?)` / `remoteIdentity(did, signRemote)` | An `Identity` for a DID the VTA holds (a persona): documents are signed by the VTA's `keys/sign-document` instead of a local key. `VtcClient` supports it; the community and rooms then see that DID. Verified live: the VTC accepted a join request signed this way ([docs/ROOMS.md](../../docs/ROOMS.md)). |
| `authenticate()`, `call(type, payload)` | Sign in; sign and POST any task. A refusal throws `TrustTaskError` with `status` and the error `body` (`body.payload.code`). `call<R>()` takes a result type. |
| `whoami()`, `discover()`, `createContext`, `grantAcl` | Typed helpers; the last two need an admin identity. |
| `newIdentity()`, `identityFromSeed`, `identityFromCredential`, `encodeCredential` / `decodeCredential` | did:key identities and the credential bundle. |
| `onCall` | `vta.onCall = (e) => ...` is told about every call after it settles (type, status, ms, the signed request). |
| `setTraceSink(fn)` / `TraceEvent` | One sink for all clients; with `TRACE=1` the scripts write it to `.vta/trace.jsonl` (`npm run trace`). |

## Limits

- The signer is synchronous (an Ed25519 seed in memory), so a WebCrypto or wallet signer does not fit yet ([docs/SECURITY.md](../../docs/SECURITY.md)).
- No typed payloads for the ~300 tasks; `call<R = any>`. The shipped bindings in `@openvtc/trust-tasks` have them.
- A TypeScript example you can copy: [templates/hello-node](../../templates/hello-node).
