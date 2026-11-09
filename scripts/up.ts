// One entry point for all modes. `--local`, `--tunnel`, `--farm` choose the mode for this one command without touching .env
// (later commands follow the stack that is running); `--no-vtc` / `WITH_VTC=0` leaves the community out:
//   npm run up      start the stack for MODE (local, tunnel or farm)
//   npm run down    stop it and keep the data (a tunnel stack is not resumable, so there it also deletes its volumes)
//   npm run reset   stop it, stop any tunnels, delete volumes, .vta/ and the kit's own keys in .env (your other .env lines stay); any mode
//   MODE=local   keygen + docker compose up (VTA) + provision   [+ VTC with WITH_VTC=1]
//   MODE=tunnel  keygen, 3 public quick tunnels, mediator, VTA, VTC (default; WITH_VTC=0 to skip), provision, probe
//   MODE=farm    mint the admin key and print the portal steps; once VTA_URL is in
//                .env, provision.
import "./lib/cli.js";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { devBanner, tunnelBanner } from "./banner.js";
import { clearGeneratedEnv, die, ENV_FILE, LOCAL_VTC_URL, env, modeInfo, removeEnv, runtime, updateEnv, vtcChoice, withVtc } from "./env.js";
import { runtimeModeError } from "./lib/binary.js";
import { anyRunFiles, requireBinaries, resetBinaries, resolveNow, startVta, stopBinaries } from "./lib/binary-run.js";
import { confirm } from "./lib/prompt.js";
import { modeLine, parseModeFlags } from "./lib/modes.js";
import {
  clearStackFiles, dc, existingStackVolumes, have, imageLabel, readStackMode, readTunnel, sleep, startTunnel, stopTunnels, waitFor200,
  writeStackMode, writeTunnel,
} from "./lib/compose.js";
import { currentMode, imagesAvailable, imageSpecs, imageStatus, realDocker, useImages, type ImageKind } from "./lib/images.js";
import { composeEnv, mediatorDidFromToml, tunnelUrls, TUNNEL_FILE, volumeGuard, type TunnelState } from "./lib/tunnel.js";
import { runPreflight } from "./doctor.js";
import { pins } from "./pins.js";

const run = (cmd: string, args: string[], extraEnv: Record<string, string> = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, DEV_BANNER_SHOWN: "1", ...extraEnv } });
  if (r.status !== 0) die(`\`${cmd} ${args.join(" ")}\` failed (exit ${r.status}).`);
};
/** Set by the VTC block below: did the user ask for the VTC (WITH_VTC or --vtc)? An unrequested VTC is dropped, not fatal, when no image can be had. */
let vtcRequested = false;
/** Pick (and, if needed, pull) the images, exporting VTA_IMAGE etc. for compose. Fatal if one cannot be had (except an unrequested VTC). */
function prepareImages(kinds: ImageKind[]): void {
  let rs;
  try { rs = useImages(pins(), kinds, { pull: true, get: env }); } catch (e) { return die((e as Error).message); }
  const failed = rs.flatMap((r) => (r.ok ? [] : [r]));
  const vtc = failed.find((r) => r.kind === "vtc");
  if (vtc && !vtcRequested) {
    process.env.WITH_VTC = "0";
    console.log(`note: no community (VTC) image could be had, so this run starts without it:\n  ${vtc.message}\nSet WITH_VTC=0 to stop seeing this.`);
  }
  const bad = failed.filter((r) => r !== vtc || vtcRequested).map((r) => r.message);
  if (bad.length) die(`no usable image:\n  ${bad.join("\n  ")}\n(images are built locally: npm run setup builds what this mode needs; docs/IMAGES.md.)`);
}
const npm = (s: string, extraEnv: Record<string, string> = {}) => run("npm", ["run", "--silent", s], extraEnv);
/** Refuse to reuse volumes across modes. In a terminal, offer the reset instead of just refusing. */
const guard = async (want: "local" | "tunnel") => {
  const g = volumeGuard({ want, marker: readStackMode(), volumes: existingStackVolumes() });
  if (g.ok) return;
  if (await confirm(`\n${g.message}\n\nReset it now? This deletes that stack's volumes, .vta/ and the kit's keys in ${ENV_FILE}.`)) {
    await resetAll();
    return;
  }
  die(g.message);
};
/** Tunnel-mode variables that keys in .env would otherwise carry over from a dead stack. */
const TUNNEL_ENV_KEYS = ["VTA_URL", "VTA_DID", "VTA_CONTEXT", "APP_DID", "VTA_CREDENTIAL", "VTC_URL", "VTC_DID"];

async function tunnelUp(): Promise<void> {
  tunnelBanner();
  await runPreflight({ mode: "tunnel", withVtc: withVtc() });
  const p = pins();
  if (!have("cloudflared")) die("MODE=tunnel needs the `cloudflared` binary on PATH (quick tunnels, no account). Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ . Validated with " + p.messaging.cloudflared.validated + ".");
  prepareImages(["vta", ...(withVtc() ? ["vtc" as const] : []), "mediator"]);
  const wantVtc = withVtc();
  const features = imageLabel(process.env.VTA_IMAGE ?? "vta-buildathon:local", "org.buildathon.vta-features");
  if (features !== undefined && features !== "" && !features.split(",").includes("tsp")) {
    die(`the VTA image was built without \`tsp\` (features: ${features}); MODE=tunnel needs it. Rebuild: npm run images:build vta.`);
  }
  await guard("tunnel");
  if (readTunnel()) die(`${TUNNEL_FILE} exists: a tunnel stack was started and not taken down. Run npm run down first.`);

  npm("vta:keygen");
  removeEnv(TUNNEL_ENV_KEYS);
  console.log("starting 3 quick tunnels (about 15 s)...");
  const state: TunnelState = { vtaHost: "", vtcHost: "", medHost: "", startedAt: new Date().toISOString(), pids: [] };
  try {
    // 1. tunnels first: every DID and config below names these hostnames.
    const wanted: ["vtaHost" | "medHost" | "vtcHost", string, number][] = [["vtaHost", "vta", 8100], ["medHost", "mediator", 7037]];
    if (wantVtc) wanted.push(["vtcHost", "vtc", 8200]);
    for (const [key, name, port] of wanted) {
      const t = await startTunnel(name, Number(process.env[`${name.toUpperCase()}_PORT`] ?? port));
      state[key] = t.host;
      state.pids.push(t.pid);
    }
    writeTunnel(state);
    const urls = tunnelUrls(state);
    // 2. mediator (needs only its own host; it mints a did:webvh bound to that host), then read its DID for the VTA and VTC configs.
    console.log("starting redis + mediator...");
    let r = dc("tunnel", wantVtc, ["up", "-d", "--wait", "--no-build", "redis", "mediator"], { inherit: true });
    if (r.status !== 0) throw new Error("the mediator did not become healthy; see `docker compose --profile messaging logs mediator`.");
    const line = dc("tunnel", wantVtc, ["exec", "-T", "mediator", "grep", "-m1", "^mediator_did", "/conf/mediator.toml"]).stdout;
    state.mediatorDid = mediatorDidFromToml(line ?? "");
    if (!state.mediatorDid) throw new Error("could not read the mediator DID from its config.");
    writeTunnel(state);
    if (!(await waitFor200(`${urls.mediator}/mediator/v1/livez`, 90_000))) throw new Error(`the mediator is up but ${urls.mediator} does not answer through the tunnel (DNS can lag; try the probe again in a minute).`);
    // The mediator's DID is a did:webvh that the VTA, the VTC and every client resolve at its tunnel host: wait until it is served.
    if (!(await waitFor200(`${urls.mediator}/.well-known/did.jsonl`, 90_000))) throw new Error(`the mediator's DID log is not reachable at ${urls.mediator}/.well-known/did.jsonl.`);
    // 3. VTA, then check its did:webvh resolves at the public host before anything else needs it.
    console.log("starting the VTA...");
    r = dc("tunnel", wantVtc, ["up", "-d", "--wait", "vta"], { inherit: true });
    if (r.status !== 0) throw new Error("the VTA did not become healthy; see `docker compose logs vta`.");
    if (!(await waitFor200(`${urls.vta}/.well-known/did.jsonl`, 90_000))) throw new Error(`the VTA DID log is not reachable at ${urls.vta}.`);
    writeStackMode("tunnel");
    updateEnv({ VTA_URL: urls.vta, ...(urls.vtc ? { VTC_URL: urls.vtc } : {}) });
    npm("vta:provision", { VTA_URL: urls.vta });
    if (wantVtc) {
      npm("vtc:up", { VTA_URL: urls.vta, ...composeEnv(state) });
      if (!(await waitFor200(`${urls.vtc}/health`, 120_000))) throw new Error(`the VTC does not answer at ${urls.vtc}; see \`docker compose --profile vtc logs vtc\`.`);
    }
  } catch (e) {
    console.error(`\n${(e as Error).message}\nThe stack is left running for inspection. Tear it down with: npm run down`);
    process.exit(1);
  }
  await sleep(1000);
  console.log("\nrunning the tunnel probe:");
  const probe = spawnSync("npm", ["run", "--silent", "tunnel:probe"], { stdio: "inherit", env: { ...process.env, DEV_BANNER_SHOWN: "1", MODE: "tunnel" } });
  if (probe.status !== 0) die("the tunnel probe found a problem (above). The stack is left running; fix it or tear it down with npm run down.");
  console.log(`\nVTA ${tunnelUrls(state).vta}\n${wantVtc ? `VTC ${tunnelUrls(state).vtc}\n` : ""}These URLs are public and die with this run. Tear down: npm run down.`);
}

function tunnelDown(): void {
  const t = readTunnel();
  dc("tunnel", true, ["down", "-v", "--remove-orphans"], { inherit: true });
  const n = stopTunnels(t?.pids ?? []);
  clearStackFiles();
  removeEnv(TUNNEL_ENV_KEYS);
  console.log(`stopped ${n} tunnel(s); deleted the tunnel volumes (their DIDs were bound to hosts that are gone) and the tunnel keys in .env.`);
}

/** Stop the stack and keep its data (local). A tunnel stack is never resumable, so there `down` also deletes the volumes. */
async function stop(): Promise<void> {
  if (runtime() === "binary") {
    const n = await stopBinaries();
    console.log(`stopped ${n.length ? n.join(" and ") : "nothing (no binary was running)"}.`);
    return;
  }
  if (anyRunFiles()) await stopBinaries(); // a stack started with RUNTIME=binary and now taken down without it
  const r = dc("tunnel", true, ["down", "--remove-orphans"], { inherit: true });
  if (r.status !== 0) console.error("docker compose down did not finish cleanly (is Docker running?).");
}

/** Everything: stop the stack and any tunnels, delete the volumes, the generated keys (`.vta/`) and the kit's own `.env` keys. Works in every mode. */
async function resetAll(): Promise<void> {
  const t = readTunnel();
  const binary = runtime() === "binary";
  if (binary || anyRunFiles()) await resetBinaries();
  const hadDocker = !binary && have("docker");
  if (hadDocker) {
    const r = dc("tunnel", true, ["down", "-v", "--remove-orphans"], { inherit: true });
    if (r.status !== 0) console.error("docker compose down -v did not finish cleanly (is Docker running?). Volumes may remain: docker volume ls.");
  }
  const n = stopTunnels(t?.pids ?? []);
  clearStackFiles();
  rmSync(".vta", { recursive: true, force: true });
  const kept = clearGeneratedEnv();
  console.log(`reset: ${binary ? "binaries stopped, .vta/run deleted" : "containers and volumes removed"}${n ? `, ${n} tunnel(s) stopped` : ""}, .vta/ deleted, the kit's keys removed from ${ENV_FILE}${kept.length ? ` (kept your own: ${kept.join(", ")})` : ""}.`);
}

const flags = parseModeFlags(process.argv.slice(2));
if (flags.error) die(flags.error);
const sub = flags.rest[0] === "down" || flags.rest[0] === "reset" ? flags.rest[0] : "up";
const down = sub === "down";
if (sub === "up") devBanner();
// A flag applies to this command only (child scripts inherit it through the environment); nothing is written to .env.
const info = flags.mode ? { mode: flags.mode, source: "flag" as const } : modeInfo();
if (flags.mode) process.env.MODE = flags.mode;
if (flags.vtc !== undefined) process.env.WITH_VTC = flags.vtc ? "1" : "0";
const m = info.mode;
const binary = runtime() === "binary";
const rtErr = runtimeModeError(runtime(), m);
if (rtErr && sub === "up") die(rtErr);
if (m !== "farm" && sub === "up" && binary) {
  // No images in this runtime. An unrequested VTC with no `vtc` binary is dropped; a requested one is an error (requireBinaries).
  const choice = vtcChoice();
  vtcRequested = choice.explicit;
  let vtc = choice.on;
  if (vtc && !choice.explicit && !resolveNow(true).ok && resolveNow(false).ok) {
    vtc = false;
    console.log("note: no `vtc` binary was found (VTI_BIN_DIR / VTC_BIN), so this run starts without the community (VTC). Set WITH_VTC=0 to stop seeing this.");
  }
  process.env.WITH_VTC = vtc ? "1" : "0";
} else if (m !== "farm" && sub === "up") {
  // The VTC is on by default in every mode. If its image can be neither found nor pulled and nobody asked for it, start without it and say so.
  const choice = vtcChoice();
  vtcRequested = choice.explicit;
  let vtc = choice.on;
  if (vtc && !choice.explicit) {
    const specs = imageSpecs(pins(), env("IMAGE_REGISTRY"));
    const [row] = imageStatus(specs, realDocker, currentMode(env), ["vtc"], { vtc: env("VTC_IMAGE") }, imagesAvailable(pins()));
    if (row.state === "missing") {
      vtc = false;
      console.log(`note: the community (VTC) image is not available (${row.fix}), so this run starts without it. Set WITH_VTC=0 to stop seeing this.`);
    }
  }
  process.env.WITH_VTC = vtc ? "1" : "0";
}
console.log(modeLine(m, info.source, withVtc()));
if (sub === "reset") {
  await resetAll();
} else if (down && (m === "tunnel" || existsSync(TUNNEL_FILE))) {
  tunnelDown();
} else if (down && m !== "farm") {
  await stop();
  console.log(runtime() === "binary" ? "stopped; the state in .vta/run is kept (npm run up resumes it, npm run reset wipes everything)." : "stopped; the volumes are kept (npm run up resumes it, npm run reset wipes everything).");
} else if (m === "tunnel") {
  await tunnelUp();
} else if (m === "local" && binary) {
  await runPreflight({ mode: "local", withVtc: withVtc() });
  const bins = requireBinaries(withVtc());
  npm("vta:keygen");
  await startVta(bins.vta);
  writeStackMode("local");
  npm("vta:provision");
  if (withVtc()) {
    npm("vtc:up");
    process.stdout.write("waiting for the VTC");
    const t0 = Date.now();
    const ready = await waitFor200(`${LOCAL_VTC_URL}/health`, 90_000);
    console.log(ready ? ` ... ready (${Math.round((Date.now() - t0) / 1000)} s)` : "\nthe VTC is not answering yet; check npm run vtc:logs, then try npm run vtc:hello.");
  }
} else if (m === "local") {
  await runPreflight({ mode: "local", withVtc: withVtc() });
  await guard("local");
  prepareImages(withVtc() ? ["vta", "vtc"] : ["vta"]);
  npm("vta:keygen");
  run("docker", ["compose", ...(withVtc() ? ["--profile", "vtc"] : []), "up", "-d", "--wait"]);
  writeStackMode("local");
  npm("vta:provision");
  if (withVtc()) {
    npm("vtc:up");
    // The VTC finishes its own setup after the hand-off; wait for it so the next command does not hit a closed port.
    process.stdout.write("waiting for the VTC to finish setup");
    const t0 = Date.now();
    const ready = await waitFor200(`${LOCAL_VTC_URL}/health`, 90_000);
    console.log(ready ? ` ... ready (${Math.round((Date.now() - t0) / 1000)} s)` : "\nthe VTC is not answering yet; check `docker compose --profile vtc logs vtc`, then try npm run vtc:hello.");
  }
} else if (down) {
  console.log("MODE=farm: nothing runs locally. Delete the agent in the VTA Farm portal if you are done (npm run reset clears the local keys).");
} else if (env("VTA_URL")?.startsWith("https://")) {
  npm("vta:keygen");
  npm("vta:provision");
} else {
  npm("farm:setup");
}
