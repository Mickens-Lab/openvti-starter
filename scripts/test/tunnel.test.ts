import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseMode } from "../env.js";
import {
  composeEnv, composeProject, existingVolumes, hostFromLog, mediatorDidFromToml, memoryWarning, messagingVerdict, profileArgs, protocolsOf,
  tunnelUrls, vtcMessagingVerdict, volumeGuard, webvhAtHost, type TunnelState,
} from "../lib/tunnel.js";
import { pins } from "../pins.js";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
const state: TunnelState = { vtaHost: "vta-x.trycloudflare.com", vtcHost: "vtc-x.trycloudflare.com", medHost: "med-x.trycloudflare.com", mediatorDid: "did:peer:2.fake", startedAt: "t", pids: [1] };

test("mode selection accepts exactly local, tunnel, farm; default local", () => {
  assert.equal(parseMode(undefined), "local");
  assert.equal(parseMode(" tunnel "), "tunnel");
  assert.equal(parseMode("farm"), "farm");
  for (const bad of ["messaging", "Tunnel", "", "local,tunnel"]) assert.throws(() => parseMode(bad), /MODE must be "local", "tunnel" or "farm"/);
});

test("hostFromLog finds the quick-tunnel host and ignores the control plane", () => {
  const log = [
    "2026-01-01T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
    "ERR failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": EOF",
    "|  https://pretty-sample-words-here.trycloudflare.com  |",
  ].join("\n");
  assert.equal(hostFromLog(log), "pretty-sample-words-here.trycloudflare.com");
  assert.equal(hostFromLog("only https://api.trycloudflare.com/tunnel"), undefined);
  assert.equal(hostFromLog(""), undefined);
});

test("compose environment names the hosts, the mediator DID and turns the loopback allowance off", () => {
  assert.deepEqual(composeEnv(state), {
    VTA_PUBLIC_HOST: "vta-x.trycloudflare.com", VTC_PUBLIC_HOST: "vtc-x.trycloudflare.com", MEDIATOR_PUBLIC_HOST: "med-x.trycloudflare.com",
    MEDIATOR_DID: "did:peer:2.fake", VTA_ALLOW_PRIVATE_ENDPOINTS: "0",
  });
  assert.equal(composeEnv({ ...state, mediatorDid: undefined }).MEDIATOR_DID, "");
  assert.deepEqual(tunnelUrls({ ...state, vtcHost: "" }), { vta: "https://vta-x.trycloudflare.com", vtc: undefined, mediator: "https://med-x.trycloudflare.com" });
});

test("profiles: tunnel always adds messaging and vtc; local adds vtc only on request", () => {
  assert.deepEqual(profileArgs("local", false), []);
  assert.deepEqual(profileArgs("local", true), ["--profile", "vtc"]);
  assert.deepEqual(profileArgs("tunnel", false), ["--profile", "vtc", "--profile", "messaging"]);
});

test("volumes are matched by compose project name", () => {
  assert.equal(composeProject("/x/Openvti-Buildathon-Starter", ""), "openvti-buildathon-starter");
  assert.equal(composeProject("/x/y", "custom"), "custom");
  const all = ["p_vta-data", "p_mediator-data", "other_vta-data", "p_unrelated"];
  assert.deepEqual(existingVolumes(all, "p"), ["vta-data", "mediator-data"]);
  assert.deepEqual(existingVolumes(all, "q"), []);
});

test("stale-volume refusal: no volumes is always fine", () => {
  assert.deepEqual(volumeGuard({ want: "tunnel", marker: null, volumes: [] }), { ok: true });
  assert.deepEqual(volumeGuard({ want: "local", marker: "tunnel", volumes: [] }), { ok: true });
});
test("stale-volume refusal: local data is never reused by tunnel, and says how to reset", () => {
  for (const marker of ["local", null] as const) {
    const g = volumeGuard({ want: "tunnel", marker, volumes: ["vta-data"] });
    assert.equal(g.ok, false);
    assert.match((g as any).message, /MODE=local run/);
    assert.match((g as any).message, /npm run reset/);
  }
});
test("stale-volume refusal: every tunnel run needs fresh volumes, even after another tunnel run", () => {
  const g = volumeGuard({ want: "tunnel", marker: "tunnel", volumes: ["vta-data", "mediator-data"] });
  assert.equal(g.ok, false);
  assert.match((g as any).message, /new hostnames and therefore new DIDs/);
  assert.match((g as any).message, /npm run reset/);
});
test("stale-volume refusal: tunnel leftovers never reach local mode, with or without the marker", () => {
  for (const marker of ["tunnel", null] as const) {
    const g = volumeGuard({ want: "local", marker, volumes: ["vta-data", "mediator-data"] });
    assert.equal(g.ok, false);
    assert.match((g as any).message, /npm run reset/);
  }
});
test("local to local keeps its volumes, including a legacy local volume with no marker", () => {
  assert.deepEqual(volumeGuard({ want: "local", marker: "local", volumes: ["vta-data", "vtc-data"] }), { ok: true });
  assert.deepEqual(volumeGuard({ want: "local", marker: null, volumes: ["vta-data"] }), { ok: true });
});

test("memory warning only when below the estimate; silent when unknown", () => {
  assert.equal(memoryWarning(undefined), undefined);
  assert.equal(memoryWarning(16 * 1024 * 1024), undefined);
  assert.match(memoryWarning(2 * 1024 * 1024)!, /only 2\.0 GB.*8 GB/);
});

test("messaging verdict is loud when didcomm or tsp is missing (the silent REST fallback)", () => {
  const ok = messagingVerdict(["tsp", "didcomm", "rest"]);
  assert.equal(ok.state, "ok");
  assert.match(ok.text, /transport connected.*not a peer ping/);
  for (const p of [["rest"], ["didcomm", "rest"], []]) {
    const v = messagingVerdict(p);
    assert.equal(v.state, "degraded");
    assert.match(v.text, /MESSAGING DEGRADED/);
    assert.match(v.text, /REST only/);
  }
  assert.equal(messagingVerdict(undefined).state, "unknown");
});
test("ping payload shapes", () => {
  assert.deepEqual(protocolsOf(["tsp", "rest"]), ["tsp", "rest"]);
  assert.deepEqual(protocolsOf({ protocols: ["didcomm"] }), ["didcomm"]);
  assert.equal(protocolsOf({ protocols: [1] }), undefined);
  assert.equal(protocolsOf(null), undefined);
});
test("VTC public-profile transports must be advertised AND serviceable", () => {
  const t = (protocol: string, advertised = true, serviceable = true) => ({ protocol, advertised, serviceable, endpoint: "fake" });
  assert.equal(vtcMessagingVerdict({ transports: [t("tsp"), t("didcomm"), t("rest")] }).state, "ok");
  assert.equal(vtcMessagingVerdict({ transports: [t("tsp"), t("didcomm", true, false), t("rest")] }).state, "degraded");
  assert.equal(vtcMessagingVerdict({ transports: [t("rest")] }).state, "degraded");
  assert.equal(vtcMessagingVerdict({}).state, "unknown");
});

test("pins carry the mediator, the VTA feature list with tsp, and the build files agree", () => {
  const p = pins();
  assert.match(p.messaging.mediator.ref, /^[0-9a-f]{40}$/);
  assert.equal(p.messaging.mediator.version, "0.48.0");
  assert.ok(p.messaging.mediator.features.split(",").includes("tsp"));
  assert.ok(p.vti.vta.features!.split(",").includes("tsp"));
  assert.match(read("docker/mediator.Dockerfile"), /ARG MEDIATOR_REF\b/);
  assert.ok(read("docker-compose.yml").includes(`redis:${p.messaging.redis.tag}`), "compose redis default matches pins.json");
});

test("compose: messaging profile holds redis and mediator; vta and vtc stay profile-free of messaging", () => {
  const c = read("docker-compose.yml");
  for (const svc of ["redis", "mediator"]) assert.match(c, new RegExp(`\\n  ${svc}:\\n    profiles: \\["messaging"\\]`));
  assert.doesNotMatch(c, /\n  vta:\n    profiles/);
  assert.match(c, /VTA_ALLOW_PRIVATE_ENDPOINTS: "\$\{VTA_ALLOW_PRIVATE_ENDPOINTS:-1\}"/, "local mode keeps the loopback allowance");
});

test("entrypoints are valid sh and say what tunnel mode is", () => {
  for (const f of ["vta-entrypoint.sh", "vtc-entrypoint.sh", "mediator-entrypoint.sh"]) {
    const r = spawnSync("sh", ["-n", new URL(`../../${f}`, import.meta.url).pathname], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  const m = read("mediator-entrypoint.sh");
  assert.match(m, /OPEN/);
  assert.match(m, /explicit_deny/);
  assert.match(m, />\/tmp\/setup\.out/, "mediator-setup stdout (it prints the admin private key) is not left in container logs");
  assert.match(m, /^did_method = "did:webvh"$/m, "the tunnel mediator mints a short did:webvh (a did:peer:2 applicant must fit in 1000 bytes)");
  assert.match(m, /^public_url = "https:\/\/\$MEDIATOR_HOST"$/m, "the did:webvh is bound to the mediator's tunnel host");
  assert.match(m, /sed -i "s\|\^did_web_self_hosted = /, "the self-hosted DID log path is made absolute (mediator-setup writes a working-dir path)");
  assert.match(m, /grep -q "\^did_web_self_hosted = /, "and the patch is checked");
  assert.match(read("vta-entrypoint.sh"), /refusing to start: this volume was set up for/);
  // local mode must still render the old config
  assert.match(read("vta-entrypoint.sh"), /MESSAGING_TOML='kind = "skip"'/);
});

// The CORS block of mediator-entrypoint.sh, run against a throwaway config (the rest of the script needs the image).
function runCorsBlock(origin: string | undefined, config: string): { status: number | null; stderr: string; out: string } {
  const sh = read("mediator-entrypoint.sh");
  const start = sh.indexOf('if [ -n "${MEDIATOR_CORS_ALLOW_ORIGIN:-}" ]');
  const end = sh.indexOf("echo \"DEV ONLY");
  assert.ok(start > 0 && end > start, "CORS block present");
  const dir = mkdtempSync(join(tmpdir(), "med-cors-"));
  try {
    const cfg = join(dir, "mediator.toml");
    writeFileSync(cfg, config);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, CONFIG: cfg };
    if (origin !== undefined) env.MEDIATOR_CORS_ALLOW_ORIGIN = origin;
    const r = spawnSync("sh", ["-c", `set -eu\n${sh.slice(start, end)}`], { encoding: "utf8", env });
    return { status: r.status, stderr: r.stderr, out: readFileSync(cfg, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const medConfig = '[security]\n# cors_allow_origin = "https://affinidi.com"\njwt_mode = "generate"\n';

test("mediator CORS: unset leaves the config alone (cross-origin access stays off)", () => {
  const r = runCorsBlock(undefined, medConfig);
  assert.equal(r.status, 0);
  assert.equal(r.out, medConfig);
  assert.match(read("docker-compose.yml"), /MEDIATOR_CORS_ALLOW_ORIGIN: "\$\{MEDIATOR_CORS_ALLOW_ORIGIN:-\}"/, "compose default is empty");
});

test("mediator CORS: an origin replaces the commented key, and a later change replaces the active one", () => {
  const a = runCorsBlock("http://localhost:5173", medConfig);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.out, /^cors_allow_origin = "http:\/\/localhost:5173"$/m);
  assert.equal(a.out.match(/cors_allow_origin/g)?.length, 1);
  const b = runCorsBlock("https://*.example.org", a.out);
  assert.match(b.out, /^cors_allow_origin = "https:\/\/\*\.example\.org"$/m);
  assert.equal(b.out.match(/cors_allow_origin/g)?.length, 1);
});

test("mediator CORS: values that could break the TOML are refused, and a config without the key fails loudly", () => {
  for (const bad of ['http://a"b', "a b", "x\ny", "a|b", "$(id)"]) {
    const r = runCorsBlock(bad, medConfig);
    assert.notEqual(r.status, 0, JSON.stringify(bad));
    assert.equal(r.out, medConfig);
  }
  const r = runCorsBlock("http://localhost:5173", "[security]\n");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not set cors_allow_origin/);
});

test("mediatorDidFromToml: the did:webvh (or a did:peer) from mediator_did, without the did:// prefix", () => {
  const webvh = "did:webvh:QmSCID:med-x.trycloudflare.com";
  assert.equal(mediatorDidFromToml(`mediator_did = "did://${webvh}"\n`), webvh);
  assert.equal(mediatorDidFromToml(`# a comment\nmediator_did = "${webvh}"`), webvh);
  assert.equal(mediatorDidFromToml(`mediator_did = "did://did:peer:2.Vz6Mk.Ez6LS.SeyJ0"`), "did:peer:2.Vz6Mk.Ez6LS.SeyJ0");
  assert.equal(mediatorDidFromToml(`# mediator_did = "did://${webvh}"`), undefined, "a commented line is not the DID");
  assert.equal(mediatorDidFromToml(`mediator_did = "vta://mediator"`), undefined);
  assert.equal(mediatorDidFromToml(""), undefined);
});

test("webvhAtHost: a did.jsonl log is bound to the tunnel host, or says it is stale", () => {
  const log = (did: string) => JSON.stringify({ versionId: "1-Qm", state: { "@context": ["https://www.w3.org/ns/did/v1"], id: did } });
  const ok = webvhAtHost(log("did:webvh:QmSCID:med-x.trycloudflare.com"), "med-x.trycloudflare.com");
  assert.equal(ok.ok, true);
  assert.equal(ok.did, "did:webvh:QmSCID:med-x.trycloudflare.com");
  const stale = webvhAtHost(log("did:webvh:QmSCID:old-y.trycloudflare.com"), "med-x.trycloudflare.com");
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /stale/);
  assert.equal(webvhAtHost("not a log", "med-x.trycloudflare.com").ok, false);
});
