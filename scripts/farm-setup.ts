// MODE=farm step 1: mint the admin did:key and print exactly what to do in the
// VTA Farm portal. Makes no network request.
import "./lib/cli.js";
import { existsSync } from "node:fs";
import { newIdentity } from "@starter/vta-client";
import { selectedFarm } from "./farm-config.js";
import { restUrl } from "./farm-select.js";
import { farmImageTag } from "./pins.js";
import { ADMIN_FILE, ENV_FILE, loadAdmin, saveAdmin, updateEnv } from "./env.js";

const fresh = !existsSync(ADMIN_FILE);
const id = fresh ? newIdentity() : loadAdmin();
if (fresh) saveAdmin(id);
const { id: farmKey, farm } = selectedFarm();
updateEnv({ MODE: "farm", FARM: farmKey });
const agentHint = process.env.FARM_AGENT ? restUrl(farm, process.env.FARM_AGENT) : farm.restUrlTemplate;
console.log(`
MODE=farm FARM=${farmKey} written to ${ENV_FILE}. Admin key ${fresh ? "created" : "reused"}: ${ADMIN_FILE}

Admin DID (paste into the portal):

  ${id.did}

Farm: ${farm.name}${farm.preferred ? " (preferred)" : ""}. Switch with FARM=ic3|firstperson (default ic3).
${farm.issues.map((i) => "KNOWN ISSUE: " + i).join("\n")}

Next, in a browser (needs a passkey; an invite link if the farm asks for one):
  1. Open ${farm.portalUrl} (https://vta.farm links to the Farms).
  2. Create an agent (name + VTA image; pick the image "${farmImageTag()}" to match this kit's pin).
     A VTC needs a community (full stack), which is "on request".
  3. Open the agent's Connections tab, choose "Connect to PNM", paste the admin DID
     above into "Admin DID" and press "Connect to VTA". Wait for "Running".
  4. Copy from the portal into ${ENV_FILE}:
       VTA_URL=${agentHint}
       VTA_DID=did:webvh:...
     Shortcut: put FARM_AGENT=<name> in ${ENV_FILE} and the URL (and the DID, read from
     the farm's DID host) are derived for you; explicit VTA_URL / VTA_DID still win.
       VTC_URL=https://vtc-<name>.<domain>     (community only)
       VTC_DID=did:webvh:...                    (community only)
  5. npm run farm:check      (read-only reachability check)
  6. npm run vta:provision && npm run hello
`);
