# polls

A command-line client for community polls: create a poll, list and open polls, vote, see the results, close or cancel.
It is built on [@buildathon/polls-client](../../packages/polls-client/README.md), which explains the parties and the
rules. **The kit's pinned VTC does not serve elections and the stack runs no ballot box**, so start with the offline mock.

## Offline, in one command

```sh
npm run demo -w @buildathon/polls
```

The demo runs a mock community, VTA and ballot box in-process. A manager creates a poll, three members vote (one
changes their mind), the manager closes it early, and the result is printed:

```
3. ada  voted Pizza  -> replaced
4. too early  No result yet: the poll is still open and does not show running totals.
6. result
    * Pizza            #############.......   2  66.7%
```

## The CLI against the mock

```sh
npm run mock -w @buildathon/polls          # terminal 1: prints an `export ...` line
# terminal 2: paste that line, then
npm start -w @buildathon/polls -- create --question "Release on Friday?" --option Yes --option No --closes 2h --id release
npm start -w @buildathon/polls -- list
npm start -w @buildathon/polls -- show release
npm start -w @buildathon/polls -- vote release yes
npm start -w @buildathon/polls -- close release
npm start -w @buildathon/polls -- results release
```

`npm start -w @buildathon/polls -- help` lists every command and flag. `create` takes:

- `--multiple` or `--max N` for multiple choice;
- `--required` to forbid abstaining;
- `--closes 90m|2h|3d|<time>` and `--opens <time>` for the voting window;
- `--refuse-revote`, `--private`, `--live-results` and `--no-early-close`.

## Against a real community

You need a VTC built with `--features voting` that trusts a ballot box, which this kit does not provide. Then set
these in `.env`:

| Variable | Meaning |
|---|---|
| `VTC_URL`, `VTA_URL`, `VTA_CREDENTIAL`, `VTA_CONTEXT` | As written by `npm run up` |
| `POLL_BALLOT_BOX` | The ballot box DID for `create` (`npm start -w @buildathon/polls -- boxes --admin` lists the trusted ones) |
| `POLL_MEMBER_DID` | Your member DID, which the VTA holds the key for. Defaults to `APP_DID` |
| `BALLOT_BOX_URL` | Optional. Otherwise it is resolved from the ballot box's did:webvh `TrustTaskHTTPS` service |

For create, close and cancel, add `--admin` to sign with `.vta/admin.json`, which needs `vtc.elections.manage`. To
vote, the app's VTA role needs `pcs-voter`; the `application` role lacks it. None of this has been run live. See the
"Verified and not" table in the package README.
