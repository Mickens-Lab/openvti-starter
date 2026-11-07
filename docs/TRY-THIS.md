# Try this

Exercises 1 to 9, easy to advanced, plus 8b, 8c and 8d. Exercises 1 to 7, 8b and 8c were run (the first against the local stack with `WITH_VTC=1 npm run up`, 8c in tunnel mode) and the output shown is what they printed;
exercise 8d needs no stack and was checked by its component tests (jsdom), not in a browser; exercises 8 and 9 are marked "Idea, not run". DIDs, ids and timestamps differ on your machine. This is a playground: [SECURITY.md](SECURITY.md).

Start the stack once: `npm ci && npm run up` (the community, VTC, is on by default; `WITH_VTC=0` leaves it out). Stop it with `npm run down`, wipe it with `npm run reset`. Each exercise names the mode it needs;
`npm run up -- --tunnel` (public quick-tunnel URLs, messaging on, [MODES.md](MODES.md)) starts tunnel mode for that run, and later commands follow the stack that is running.

## 1. Your first signed call

*Mode: any mode.*

```sh
npm run hello
```

You should see four lines: the VTA DID, `authenticated as did:key:...`, `304 supported Trust Tasks` (the number depends on the VTA version) and
`signed call auth/whoami -> {...roles:["application"], scopes:["ctx:my-app"]...}`. You just signed a Trust Task with your app key and the VTA checked it.
If it fails: `could not reach the VTA` means the stack is down (`npm run up`, `npm run vta:logs`); a 401 after a restart means a stale credential (`npm run vta:provision`).

## 2. The status page

*Mode: any mode. The Messaging row reads "off (REST only)" in `local` and "transport connected (...), not a peer ping" in `tunnel` (needs a credential to ask the VTA).*

```sh
npm run dev -w @buildathon/web-vta-app      # then open http://localhost:5173
```

You should see "VTA connection status", an amber banner saying the app key is embedded in the page, and numbered cards (Connection, VTA identity,
Version, Auth and session, ...) with mostly OK pills. "DIDComm / TSP / Mediator: not advertised" are normal for a local VTA. Stop it with Ctrl-C.
If it fails: a "NetworkError" or fetch failure means the stack is down (`npm run doctor`; the page talks to the VTA through the dev server, so its port does not matter); a blank "no credential" means `.env` is missing (`npm run up`).

## 3. Join a community and see the member screens (React)

*Mode: any mode. The membership card's "Credential delivery" row explains, per mode, why no credential arrives ([MESSAGING.md](MESSAGING.md)): there is no inbox for it in `local`, and in `tunnel` the page applies as a `did:peer:2` naming the mediator, so the VTC pushes the credential frames to it (with `VTC_APPLICANT=did:key` it applies as the app `did:key`, which names no mediator). `credentialsDelivered` stays false until you send your own credential back: it reports that, not frame arrival.*

```sh
npm run dev -w @buildathon/community-dashboard      # open http://localhost:5173
```

You start as **Visitor** (or "Left" with a Re-apply button if this identity has been a member before). Choose a way to join that is not greyed out
(`review`), press **Apply to join**: the page shows the exact request that will be signed. Press **Sign and send**: the badge becomes **In review** and
the page re-checks every 10 seconds. Approve it as the community admin from a second terminal:

```sh
npm run vtc:approve          # approved <request id> (did:key:...)
```

Press **Refresh status** (or wait up to 10 s): the badge becomes **Member**, with a membership card and Community, Directory, My card and Account tabs.
Open **Under the hood** to see every signed Trust Task the page made. CLI view of the same state: `npm run vtc:status` (`member yes: role=member ...`) and `npm run vtc:profile`.
Watch `credentialsDelivered` turn true (any mode; **verified live 2026-10-30 (one machine, one run)**, local and tunnel): on the membership card, "Credential delivery" says the flag is
false and why. Press **Send my membership credential back**, read the confirm (you sign a credential naming the community as its subject; the
community stores it). In local mode it is unbound to the community's grant (the page never receives the grant without messaging), so
the membership pair is recorded as incomplete; in tunnel mode, if "Credential frames" was listening when the administrator approved,
the card says the grant arrived and the credential is bound to it (pair complete). Press **Yes, send my membership credential back**.
A toast says `The community answered "stored" for your unbound membership credential.` (or `bound`), a **Receipt** block shows the
community's answer, and the row turns to **reciprocal credential held** (or **bound credential held**). In local mode (and with `VTC_APPLICANT=did:key`)
`npm run vtc:status` then prints `credentialsDelivered=true`; in tunnel mode the page is the `did:peer:2`, which `vtc:status` (the `did:key`) is not.
To start over: `npm run vtc:leave -- --yes`. If it fails: "Problem" with a network code means the VTC is not up (`WITH_VTC=1 npm run up`, then `npm run vtc:hello`).

### 3b. The community is the database: change it from the CLI, press Refresh

The dashboard shows what the community said the last time it asked; it does not own any of it. Try it with two terminals.

1. Apply in the page (section 3), then press **Pause checking** so that only a refresh can move the page.
2. In a second terminal approve from the CLI: `npm run vtc:approve`. The page still says **In review**: nothing told it.
3. Press **Refresh status** (or switch to another tab and back after 15 s: the page re-reads on return). The badge becomes **Member**,
   and the line above the screen reads `As of 14:03:22, from vtc/join-requests/status, 5 ms` (from the **Under the hood** log).
4. Do it the other way: as a member open **Account**, and from the CLI run `npm run vtc:leave -- --yes`. Press **Refresh all**:
   the page follows to **Left**. Nothing in the page was "wrong": it was an old answer.
5. Press **Refresh all** twice quickly: the second press is greyed out for a second (a member) or five (a visitor or applicant), the
   community's admission budgets. The membership card has its own **Refresh**, because its sign-in is rate-limited like an anonymous caller.
6. After applying, the page keeps your request id in `localStorage` as a **local hint** (it says so, with a **Forget local hints**
   button). It is only used to ask about the right request. Press the button: the hint disappears and the page re-reads.

Why: the VTC re-reads your records on every call; the page does the same, and never patches its own copy after an action.
`npm run e2e` runs this exercise in a real browser; the component tests cover it without one.

## 4. Tamper, replay and wrong recipient

*Mode: any mode (it needs no stack).*

```sh
npm run demo -w @buildathon/inbox-verifier
```

```
good      -> 200 https://example.org/spec/buildathon/note/0.1#response
replay    -> 200 ...                      (same note again: answered, not run twice)
tampered  -> 400 proofInvalid
wrong rcpt-> 400 wrongRecipient
bad payload-> 400 malformedRequest
OK: accepted once, replay not re-executed, tamper/misaddress/malformed rejected
```

Now by hand: `npm start -w @buildathon/inbox-verifier` in one terminal, then in another
`npm run send -w @buildathon/inbox-verifier -- --replay` (the second line is the identical reply) and `... -- --tamper` (`400 ... "code":"proofInvalid"`).
`curl localhost:4000/notes` lists each accepted note once. No VTA is needed: a `did:key` carries its own public key.

## 5. Reading refusals: who can call what

*Mode: `local` or `tunnel` with the VTC (`WITH_VTC=1`, which is the default in tunnel mode).*

```sh
npm run vtc:refusals
```

```
stranger (did:key:z6Mk...)
  answered   vtc/join-requests/manifest/0.4
  refused    vtc/community/profile/show/0.1  permissionDenied: ... the signer holds no entry in this community
  refused    vtc/members/list/0.2            permissionDenied: ... DID not in ACL
  refused    auth/whoami/0.1                 permissionDenied: the signer is not the key of a live session...
app identity (a member, after exercise 3)
  answered   vtc/join-requests/manifest/0.4
  answered   vtc/community/profile/show/0.1
  refused    vtc/members/list/0.2            ... DID is not permitted to authenticate ...
  refused    auth/whoami/0.1                 ...
```

The community decides from the signer's records at the moment of the call: public, members, or admins only. Run it before and after joining to see
`profile/show` flip from refused to answered. The full matrix is in [VTC-SURFACE.md](VTC-SURFACE.md). If every line says "refused" for the app identity,
you are not a member yet (exercise 3).

## 6. Call a task you have not used before

*Mode: any mode.*

```sh
npm run vta:call                                 # lists the Trust Tasks this VTA serves
npm run vta:call -- vta/contexts/list/1.0        # {"contexts":[{"id":"my-app",...}]}
npm run vta:call -- vta/health/details/0.1       # {"sealed":true,"status":"ok","storageEncrypted":false,...}
npm run vta:call -- acl/list/0.1                 # refused (HTTP 403): permissionDenied: ... admin or initiator role required
npm run vta:call -- vta/memory/put/0.1 '{"key":"k","value":"v"}'     # refused: malformedRequest ... "contextId" is a required property
npm run vta:call -- vta/memory/put/0.1 '{"contextId":"my-app","key":"k","value":"v"}'   # {"key":"k"}
npm run vta:call -- vta/memory/list/0.1 '{"contextId":"my-app"}'      # {"items":[{"key":"k","value":"v"}]}
```

A refusal names what is wrong: your app is not an admin (`acl/list`), or the payload does not match the task's schema (read it at
`https://trusttasks.org/spec/<slug>`). Your app is scoped to its own context. See [trust-tasks/03-using-tasks.md](trust-tasks/03-using-tasks.md).
`storageEncrypted: false` is the plaintext seed from [SECURITY.md](SECURITY.md) showing up in the VTA's own report.

## 7. A look at the Farm (read-only)

*Mode: any mode; needs the internet, touches the Farm read-only.*

```sh
npm run farm:probe
```

You should see a table of GET/HEAD/OPTIONS checks against the two public Farms (API health, DID host, portal, and your agent if `FARM_AGENT` is set)
and a side-by-side summary. It sends no Trust Task and no credentials. To go further, read [FARM.md](FARM.md); creating a Farm agent needs a browser passkey and is not covered here.
If it fails: a timeout means the Farm or your network is down; that is information, not an error in the kit.

## 8. Extend it: personas

*Mode: any mode.*

Idea, not run: give each of two app identities its own context (`npm run vta:provision -- alice`, `ENV_FILE=.env.alice`), then use `vta:call` and
`vtc:status` with `ENV_FILE=.env.alice` to see two members with different cards. The VTA also serves persona and attribute tasks (see the list in exercise 6).

## 8b. Approve on a second device (software approver)

*Mode: `local` or `tunnel` (not `farm`). A real phone needs more than this kit has: [MOBILE-WALLET.md](MOBILE-WALLET.md).*

A VTA can refuse a task until a different key agrees to that exact task. Set it up on a fresh stack, then ask for a gated task and approve it from a second terminal:

```sh
npm run reset                  # only if a stack exists
npm run approvals:setup            # mints the throwaway approver key
WITH_VTC=1 npm run up
npm run approvals:demo             # WAITING FOR APPROVAL   match code: 032df1
npm run approver -- --match-code 032df1      # in a second terminal: decision sent: approve -> granted
```

You should see the demo print `approved and executed` with the context renamed. Try a wrong code (refused before anything is signed) and `npm run approver -- --deny "not expected"`
(the demo stops and does not ask again). This is a second key on the same laptop, not a second device: [APPROVALS.md](APPROVALS.md) says what it does and does not protect.

## 8c. Ping the VTA over TSP and catch the credential push (tunnel mode)

*Mode: `tunnel` only. Start it with the mediator open to the page: `MODE=tunnel MEDIATOR_CORS_ALLOW_ORIGIN=http://localhost:3000 npm run up`. Needs the images in [MODES.md](MODES.md).*

```sh
npm run tsp:ping                   # login, relationship invite, signed messaging/ping/0.2 over TSP
npm run dev -w @buildathon/tsp-ping   # the same in a browser: http://localhost:3000, press "Send ping"
docker compose logs vta | grep -E "tsp|trust-task"     # what the VTA did with it
```

With the pinned images (mediator 0.48.0) you should see the client log in, send, and end with `pong from the VTA ... nonce echoed` (the page shows the same verdict). That is **verified** in tunnel mode.
In the VTA log you see `TSP trust-task dispatched ... status=200 OK`. Try `npm run tsp:ping -- --throwaway` (a DID the VTA does not know: 403) and the page with the credential field cleared.
If you use an older mediator image (`MEDIATOR_IMAGE`) the ping times out and the VTA log says `failed to send TSP reply ... unsupported TSP major version`: that mediator does not read TSP 1.0 ([MESSAGING.md](MESSAGING.md)).

Credential push by hand: run `npm run tsp:listen` in one shell, then `npm run vtc:join` and `npm run vtc:approve` in another (both apply as the `did:peer:2` by default; set `VTC_APPLICANT=did:key` in `.env` for the `did:key` way); the listener prints `frame from the peer: .../credential-exchange/issue/0.1` (twice, **verified**).
It proves the frames arrive, not that a wallet could use them. A `did:key` listener sends a relationship invite first; that is how the VTC learns to use TSP for it. A `did:peer:2` needs none.

With no ping first (the tunnel default): `npm run tsp:peer-push` listens and applies as a `did:peer:2` whose `TSPTransport` service names the mediator, approves, and ends with `PASS: the credential reached the did:peer over TSP with no earlier contact.` (**verified**, [MESSAGING.md](MESSAGING.md#tunnel-mode-delivers-the-credential-to-the-applicant)).
The join status still says `credentialsDelivered: false` afterwards; that flag reports the member's own credential sent back, not frame arrival.

In the browser instead of `tsp:listen` (**verified live 2026-10-30 (one machine, one run)**; unit- and component-tested): start the dashboard
(`npm run dev -w @buildathon/community-dashboard`, note the origin Vite prints, usually `http://localhost:5173`), and make sure the mediator
allows exactly that origin: start the tunnel stack with `MEDIATOR_CORS_ALLOW_ORIGIN=http://localhost:5173 npm run up -- --tunnel`, or recreate
only the mediator ([MODES.md](MODES.md#browser-access-cors)). Apply in the page, open **Credential frames** under the in-review screen and press
*Listen for credential frames*; the status turns to `listening`. Then `npm run vtc:approve` in a terminal. The panel lists a
`relationship invite` and `credential-exchange/issue/0.1` frames with their times, the tally counts them, and the panel keeps running when the
page turns to "member". It still says frames arriving is not `credentialsDelivered`. Without the CORS setting, *Listen* fails with
`Could not start listening: ...` and the exact `MEDIATOR_CORS_ALLOW_ORIGIN=<origin>` line. Do not run `npm run tsp:listen` as the same DID at
the same time: a frame may go to either listener.

## 8d. A collaboration room on data rooms (mock mode, no stack)

*Mode: none needed. Mock mode (`COLLAB_MODE=mock`, the default when `COLLAB_ROOM` is not set) runs a data-room host inside the page; no VTA,
VTC or Docker. `COLLAB_MODE=live` uses the VTC and VTA instead and is unverified live (no room exists in the local stack).*

```sh
npm run dev -w @buildathon/collab-room       # open http://localhost:5173 (or the port Vite prints)
```

After a moment of setup (a real two-member MLS group for the sealed room) you see two rooms: **Project room (open)**, plaintext, and
**Deal room (attributed)**, MLS-sealed so the host stores only ciphertext. Things to try:

- **Chat**: the newest 20 messages, oldest first; press **Load older**. Toggle **Plain text / Markdown on** and send `a **bold** move`.
  Messages show **Bob Builder** with an avatar (his room profile), a short `did:key:…` with an identicon for Carol (no profile), and **You**.
  Hover a name for the full DID.
- **Live**: the badge reads "Live (polling every 3 s)". Bob is simulated and posts every 12 s, alternating between the two rooms; his message appears with no reload. Switch to
  another tab and back: the badge says the poll slowed to 15 s while hidden.
- **Notes**: open "Kickoff agenda". Its `<script>`, `<img onerror>` and `javascript:` link show as plain text, the `example.org` link shows its URL,
  and the markdown image is a link that was never loaded. **Edit**, change it, **Save new version**: the version count goes up.
- **Files**: `site-plan.png` and the animated `celebration.gif` are shown (judged by their bytes); `diagram.svg` and `photo.png` (claims to be a PNG,
  is HTML) are download-only with the reason; the text and `.md` files are shown inline. In the sealed room, upload a file over 256 KiB to see the limit.
- **Search**: "File names" for `celebration`, then switch to "Full text" for `riverside` or `"contingency reserve"`; press a result to jump to it.

Everything lives in page memory and is gone on reload. The tests behind each point: `npm test -w @buildathon/collab-room`. How it is built:
[templates/collab-room/README.md](../templates/collab-room/README.md) and [packages/rooms-client/README.md](../packages/rooms-client/README.md).
If it fails: a blank page with an error usually means the workspace is not installed (`npm ci` at the repo root).

## 9. Extend it: your own task and an extension

*Mode: any mode.*

Idea, not run: change `NOTE_TYPE`, the schema and the handler in `templates/inbox-verifier/src/inbox.ts`, run its demo, then send from your VTA app by swapping
`newIdentity()` for `identityFromCredential(...)` in `send.ts`. A browser wallet or extension can sign instead of the embedded key: see the wallet panel in `templates/web-vta-app`.

## 10. Where next

The [Trust Tasks guide](trust-tasks/README.md): concepts, finding, using, developing and evaluating tasks, with a custom-task walkthrough. Then [TRACKS.md](TRACKS.md) for project ideas
and [ARCHITECTURE.md](ARCHITECTURE.md) for the code tour.
