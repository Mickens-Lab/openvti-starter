# MCP agent (stub)

**Status: partial.** This directory provisions a context-scoped agent identity
and writes an MCP host config. It does not include or run `vta-mcp`, and the
last step (an MCP host talking to `vta-mcp` talking to this VTA) was **not
tested**.

## What `vta-mcp` needs

[`vta-mcp`](https://github.com/OpenVTC/verifiable-trust-infrastructure/tree/main/vta-mcp)
is a Rust stdio MCP server exposing VTA operations (list keys, sign, vault, any
Trust Task via `vta_call`) as MCP tools. It is `publish = false`: there is no
npm or crates.io package, so someone must `cargo build --release -p vta-mcp` in
the VTI repo (a cold Rust build, like the VTA image) and hand out the binary.
Its auth modes:

| Mode | Needs | Fit here |
|---|---|---|
| Token | `VTA_URL` + `VTA_TOKEN` (REST bearer, no refresh) | What this stub uses |
| did:key | `--agent-did/--agent-key/--vta-did/--mediator-did` (DIDComm) | Needs a mediator; this VTA runs without one |
| Session | `--vta <slug>` from a `pnm` login | Operator authority; do not use for agents |

## Steps

```sh
# 1. A dedicated agent: its own context, its own did:key, an ACL entry scoped to it
ENV_FILE=.env.mcp-agent npm run vta:provision -- mcp-agent

# 2. A bearer token from the VTA, and an MCP config that carries it
npm run mint -w @starter/mcp-agent     # writes templates/mcp-agent/.mcp.json (gitignored)
```

Step 2 was run against a live VTA: the agent authenticates and `whoami` shows
`scopes: ["ctx:mcp-agent"]`. Point your MCP host (Claude Code, Claude Desktop) at the
generated `.mcp.json` and set `VTA_MCP_BIN` to the binary path before minting.

## Guardrails to keep

- Keep the agent's ACL scoped to its own context. That bounds what any tool can do.
- Keep `--read-only` and `--confirm sensitive` unless the demo needs more. An MCP
  host approves a tool, not a call; once `vta_call` is approved every operation rides it.
- Tokens are short-lived. Re-run `mint` when calls start failing with 401.

## No binary? Do it in TypeScript

The same idea works without `vta-mcp`: write an MCP server (the
`@modelcontextprotocol/sdk` package) whose tools call `VtaClient` from
`packages/vta-client` with the agent credential from `.env.mcp-agent`. That
route is fully supported by what is in this repo, and for a 4-hour event it is
the lower-risk choice.
