// Mint the admin did:key BEFORE the VTA first boots: the VTA seeds it as
// super-admin during `vta setup --from`.
import "./lib/cli.js";
import { existsSync, writeFileSync } from "node:fs";
import { newIdentity } from "@starter/vta-client";
import { devBanner } from "./banner.js";
import { ADMIN_FILE, loadAdmin, saveAdmin } from "./env.js";

devBanner();
const fresh = !existsSync(ADMIN_FILE);
const id = fresh ? newIdentity() : loadAdmin();
if (fresh) saveAdmin(id);
writeFileSync(".vta/admin.env", `ADMIN_DID=${id.did}\n`, { mode: 0o600 });
console.log(`admin DID: ${id.did}`);
console.log(`wrote ${ADMIN_FILE} (private key) and .vta/admin.env (read by docker compose)`);
