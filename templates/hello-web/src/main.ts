import { explainFetchFailure, VtaClient } from "@starter/vta-client";

declare const __CRED__: { credential: string; url: string; target: string; context: string };
const out = document.getElementById("out")!;

document.getElementById("go")!.addEventListener("click", async () => {
  out.textContent = "calling...";
  try {
    if (!__CRED__.credential) throw new Error("no VTA_CREDENTIAL: run `npm run up` at the repo root, then restart this dev server.");
    const vta = await VtaClient.fromCredential(__CRED__.credential, location.origin + __CRED__.url);
    await vta.authenticate();
    out.textContent = JSON.stringify({ me: vta.me.did, whoami: await vta.whoami() }, null, 2);
  } catch (e) {
    const msg = (e as Error).message;
    // A blocked cross-origin call and an unreachable server look alike in a browser; this says which things to check.
    const hint = explainFetchFailure(e, { url: location.origin + __CRED__.url, origin: location.origin, proxied: true, target: __CRED__.target });
    out.textContent = `failed: ${msg}${hint ? `\n\n${hint}` : ""}`;
  }
});
