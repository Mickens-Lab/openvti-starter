// Mint a short-lived bearer token for a context-scoped agent and write an MCP
// host config that runs `vta-mcp` in its REST "token" mode (VTA_URL + VTA_TOKEN).
//
//   ENV_FILE=.env.mcp-agent npm run vta:provision -- mcp-agent
//   ENV_FILE=.env.mcp-agent npx tsx templates/mcp-agent/mint-token.ts
//
// Writes templates/mcp-agent/.mcp.json (gitignored: it contains the token).
// UNVERIFIED against a real vta-mcp binary; see README.md.
import { writeFileSync } from "node:fs";
import { VtaClient } from "@starter/vta-client";
import { env } from "../../scripts/env.js";

const cred = env("VTA_CREDENTIAL");
if (!cred) throw new Error("No credential. Run the vta:provision command above first.");
const vta = await VtaClient.fromCredential(cred, env("VTA_URL"));
const token = await vta.authenticate();
const who = await vta.whoami();
console.log(`agent ${vta.me.did} scopes=${JSON.stringify(who.scopes)} roles=${JSON.stringify(who.roles)}`);

const bin = process.env.VTA_MCP_BIN ?? "vta-mcp";
const config = {
  mcpServers: {
    vta: {
      command: bin,
      // --read-only and --confirm are vta-mcp's own policy on top of the ACL.
      args: ["--read-only", "--confirm", "sensitive"],
      env: { VTA_URL: vta.baseUrl, VTA_TOKEN: token },
    },
  },
};
const out = new URL(".mcp.json", import.meta.url);
writeFileSync(out, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(`wrote ${out.pathname}. The token is short-lived: re-run this to refresh it.`);
