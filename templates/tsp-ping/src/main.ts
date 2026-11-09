// Browser TSP ping: the same tspPing() the CLI uses, with the browser's own WebSocket.
import { describePong, tspPing } from "@starter/tsp-client";
import { decodeCredential, seedFromMultibase } from "@starter/vta-client";
import { noPongText } from "./verdict.ts";

declare const __DEFAULTS__: { vtaDid: string; mediatorDid: string; credential: string };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const vta = $<HTMLInputElement>("vta"), med = $<HTMLInputElement>("med"), cred = $<HTMLInputElement>("cred");
vta.value = __DEFAULTS__.vtaDid;
med.value = __DEFAULTS__.mediatorDid;
cred.value = __DEFAULTS__.credential;

const go = $<HTMLButtonElement>("go");
go.onclick = async () => {
  const log = $("log"), verdict = $("verdict");
  log.hidden = verdict.hidden = false;
  log.textContent = "";
  verdict.className = "verdict";
  verdict.textContent = "pinging...";
  go.disabled = true;
  try {
    const seed = cred.value.trim() ? seedFromMultibase(decodeCredential(cred.value).privateKeyMultibase) : undefined;
    const r = await tspPing({
      vtaDid: vta.value.trim(), mediatorDid: med.value.trim(), ...(seed ? { seed } : {}),
      log: (l) => { log.textContent += `${l}\n`; },
    });
    verdict.className = "verdict ok";
    verdict.textContent = describePong(r);
  } catch (e) {
    verdict.className = "verdict bad";
    verdict.textContent = noPongText(e, location.origin, med.value);
  } finally {
    go.disabled = false;
  }
};
