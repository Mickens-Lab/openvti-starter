import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { DEFAULT_VTC_URL, devProxy, VTA_PROXY, VTC_PROXY } from "../../scripts/lib/dev-proxy.ts";
import { agentUrl, farmId, type FarmTable } from "../../scripts/farm-select.ts";

// Reads the repo-root .env, as templates/community-dashboard does. DEV ONLY: in live mode VTA_CREDENTIAL holds a private key
// and is exposed to the page so the demo can act as the provisioned app.
//
// COLLAB_MODE=mock|live picks the backend:
//   mock (the default when no room is configured): an in-browser MockRoomHost seeded with an open and an attributed room and
//        a simulated second member; no stack, no credential, nothing leaves the page.
//   live: the VTC at VTC_URL over /__vtc (rooms/* and vtc/rooms/memberships/list), the VTA at VTA_URL over /__vta
//        (rooms/keys/*). COLLAB_ROOM=<room DID> opens one room directly and makes live the default. Unverified live.
// Both proxies are set up in every mode, so the page stays same-origin and any dev-server port works.
export default defineConfig(({ mode }) => {
  const e = loadEnv(mode, "../..", ["VTA_", "VTC_", "MODE", "FARM", "COLLAB_"]);
  let stackMode: string | undefined;
  try { stackMode = JSON.parse(readFileSync(new URL("../../.vta/mode.json", import.meta.url), "utf8")).mode; } catch { /* no stack */ }
  const runMode = process.env.MODE || e.MODE || stackMode || "local";
  const farm = runMode === "farm";
  // FARM=ic3|firstperson + FARM_AGENT=<name> derive the agent URL when VTA_URL is not set.
  const table: FarmTable = JSON.parse(readFileSync(new URL("../../scripts/farm-hosts.json", import.meta.url), "utf8"));
  const fe = (k: string) => process.env[k] ?? e[k];
  if (farm && !e.VTA_URL) {
    const u = agentUrl(table.farms[farmId(table, fe("FARM"))], process.env.VTA_URL, fe("FARM_AGENT"));
    if (u) e.VTA_URL = u;
  }
  const vtcUrl = process.env.VTC_URL ?? e.VTC_URL;

  const room = (fe("COLLAB_ROOM") ?? "").trim();
  const asked = (fe("COLLAB_MODE") ?? "").trim().toLowerCase();
  if (asked && asked !== "mock" && asked !== "live") throw new Error(`COLLAB_MODE must be "mock" or "live" (got "${asked}").`);
  const collabMode = asked || (room ? "live" : "mock");

  const proxy = devProxy({ vtaUrl: e.VTA_URL, vtcUrl: vtcUrl ?? DEFAULT_VTC_URL });

  return {
    envDir: "../..",
    envPrefix: ["VITE_", "VTA_", "VTC_"],
    plugins: [react()],
    define: {
      __COLLAB_MODE__: JSON.stringify(collabMode),
      __COLLAB_ROOM__: JSON.stringify(room),
      __FARM__: JSON.stringify(farm),
      __VTA_BROWSER_URL__: JSON.stringify(VTA_PROXY),
      __VTA_URL__: JSON.stringify(e.VTA_URL ?? "http://localhost:8100"),
      __VTC_BROWSER_URL__: JSON.stringify(VTC_PROXY),
      __VTC_URL__: JSON.stringify(vtcUrl ?? "http://localhost:8200"),
    },
    // 5173 is only the preferred port: the proxy keeps the page same-origin, so Vite may move to 5174 or you can pass `--port 3050`.
    server: { port: 5173, proxy },
    build: { target: "es2022" },
  };
});
