// RUNTIME=binary: the pure parts (env validation, path resolution, config rendering), and a check that the rendered
// setup files stay equal to the heredocs in the entrypoint scripts, which remain the Docker source of truth.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { corsTomlBody } from "@buildathon/vta-client";
import {
  applyApproverPolicy, binaryCheck, judgeVersion, parseVersionOutput, semverFromTag, fillVtcCors, parseRuntime, renderVtaSetup, renderVtcSetup, resolveBinaries, runPaths, runtimeModeError, setupKeyDid, vtaDidFromLog,
} from "../lib/binary.js";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

test("RUNTIME defaults to docker and rejects anything else", () => {
  assert.equal(parseRuntime(undefined), "docker");
  assert.equal(parseRuntime(""), "docker");
  assert.equal(parseRuntime(" binary "), "binary");
  assert.throws(() => parseRuntime("podman", ".env.x"), /RUNTIME must be "docker" or "binary".*\.env\.x/);
});

test("binary runtime refuses MODE=tunnel, nothing else", () => {
  assert.match(runtimeModeError("binary", "tunnel")!, /mediator/);
  assert.equal(runtimeModeError("binary", "local"), undefined);
  assert.equal(runtimeModeError("binary", "farm"), undefined);
  assert.equal(runtimeModeError("docker", "tunnel"), undefined);
});

const fsOf = (files: string[], dirs: string[]) => ({ isExecutable: (p: string) => files.includes(p), isDir: (p: string) => dirs.includes(p) });

test("binaries: no default folder; an unset VTI_BIN_DIR names the variable", () => {
  const r = resolveBinaries({ withVtc: false, ...fsOf([], []) });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problems.join() : "", /VTI_BIN_DIR/);
});

test("binaries: folder lookup, vtc only when requested, and each problem names its variable", () => {
  const f = fsOf(["/b/vta"], ["/b"]);
  assert.deepEqual(resolveBinaries({ binDir: "/b", withVtc: false, ...f }), { ok: true, vta: "/b/vta", vtc: undefined });
  const need = resolveBinaries({ binDir: "/b", withVtc: true, ...f });
  assert.ok(!need.ok && need.problems.length === 1 && /no executable `vtc`.*VTC_BIN/.test(need.problems[0]));
  const nodir = resolveBinaries({ binDir: "/nope", withVtc: false, ...f });
  assert.ok(!nodir.ok && /VTI_BIN_DIR=\/nope is not a directory/.test(nodir.problems[0]));
  const missing = resolveBinaries({ binDir: "/b", withVtc: false, ...fsOf([], ["/b"]) });
  assert.ok(!missing.ok && /no executable `vta`/.test(missing.problems[0]));
});

test("binaries: VTA_BIN / VTC_BIN override the folder, and a bad override is reported", () => {
  const f = fsOf(["/x/vta", "/x/vtc", "/b/vta"], ["/b"]);
  assert.deepEqual(resolveBinaries({ binDir: "/b", vtaBin: "/x/vta", vtcBin: "/x/vtc", withVtc: true, ...f }), { ok: true, vta: "/x/vta", vtc: "/x/vtc" });
  assert.deepEqual(resolveBinaries({ vtaBin: "/x/vta", withVtc: false, ...f }), { ok: true, vta: "/x/vta", vtc: undefined });
  const bad = resolveBinaries({ binDir: "/b", vtaBin: "/y/vta", withVtc: false, ...f });
  assert.ok(!bad.ok && /VTA_BIN=\/y\/vta is not an executable file/.test(bad.problems[0]));
});

test("doctor rows: ok rows carry the path, failures point at the doc", () => {
  assert.deepEqual(binaryCheck({ ok: true, vta: "/b/vta" }).map((c) => c.level), ["ok"]);
  const rows = binaryCheck({ ok: false, problems: ["a", "b"] });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((c) => c.level === "fail" && /BINARIES\.md/.test(c.fix ?? "")));
});

test("state paths all sit under the run folder", () => {
  const p = runPaths("/r");
  for (const [k, v] of Object.entries(p)) assert.ok(v === "/r" || v.startsWith("/r/"), k);
  assert.equal(p.vtaPid, "/r/vta.pid");
  assert.equal(p.vtcConfig, "/r/vtc/config.toml");
});

// Render the entrypoints' own heredocs in a shell and compare.
function heredoc(file: string, opener: string, vars: Record<string, string>): string {
  const sh = read(file);
  const a = sh.indexOf(opener);
  assert.ok(a >= 0, `${file}: ${opener}`);
  const start = sh.indexOf("\n", a) + 1;
  const end = sh.indexOf("\nTOML\n", start);
  const body = sh.slice(start, end + 1);
  const assigns = Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join("\n");
  const r = spawnSync("sh", ["-c", `set -eu\n${assigns}\ncat <<TOML\n${body}TOML`], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("the rendered VTA setup equals vta-entrypoint.sh's (except the bind address, loopback on the host)", () => {
  const shell = heredoc("vta-entrypoint.sh", "cat > /tmp/setup.toml <<TOML", {
    CONFIG: "/c/config.toml", PORT: "8100", ADMIN_DID: "did:key:fake", CORS: corsTomlBody(), PUBLIC_URL: "http://localhost:8100",
    MESSAGING_TOML: 'kind = "skip"', SERVICES_TOML: "didcomm = false\ntsp     = false",
  }).replace(/\/var\/lib\/vta\/data/, "/c/data");
  const ts = renderVtaSetup({ configPath: "/c/config.toml", dataDir: "/c/data", port: 8100, adminDid: "did:key:fake", host: "0.0.0.0" });
  assert.equal(ts, shell);
  assert.match(renderVtaSetup({ configPath: "a", dataDir: "b", port: 1, adminDid: "d" }), /^host = "127\.0\.0\.1"$/m);
  assert.match(renderVtaSetup({ configPath: "a", dataDir: "b", port: 1, adminDid: "d", cors: '"http://localhost:1"' }), /^cors_origins = \["http:\/\/localhost:1"\]$/m);
});

test("the rendered VTC setup equals vtc-entrypoint.sh's", () => {
  const shell = heredoc("vtc-entrypoint.sh", "cat > /tmp/vtc-setup.toml <<TOML", {
    CONFIG: "/c/config.toml", BASE_URL: "http://localhost:8200", VTA_DID: "did:webvh:fake:localhost", CTX: "vtc", KEY: "/c/key.json", MESSAGING_TOML: "",
  });
  assert.equal(renderVtcSetup({ configPath: "/c/config.toml", port: 8200, vtaDid: "did:webvh:fake:localhost", context: "vtc", keyFile: "/c/key.json" }), shell);
});

test("VTA DID is the first id without a fragment; the setup key DID is found in its JSON", () => {
  const log = '{"state":{"id":"did:webvh:Qfake:localhost%3A8100","service":[{"id":"did:webvh:Qfake:localhost%3A8100#vta-rest"}]}}';
  assert.equal(vtaDidFromLog(log), "did:webvh:Qfake:localhost%3A8100");
  assert.equal(vtaDidFromLog("nothing"), undefined);
  assert.equal(setupKeyDid('{"did":"did:key:z6Mkfake","k":1}'), "did:key:z6Mkfake");
});

test("VTC config: the empty allowed_origins line is filled once; a different shape is reported", () => {
  const out = fillVtcCors("[cors]\nallowed_origins = []\n[x]\n")!;
  assert.ok(out.includes(`allowed_origins = [${corsTomlBody()}]`));
  assert.match(out, /^allowed_origins = \["/m);
  assert.equal(fillVtcCors("[cors]\nallowed_origins = [\"x\"]\n"), undefined);
  assert.ok(fillVtcCors("[cors]\nallowed_origins = []\n", '"http://localhost:1"')!.includes('["http://localhost:1"]'));
});

test("approver policy: switches enforcement on, seeds the set and the rule; refuses when the config has no policy", () => {
  const cfg = "[policy]\nenforcement = false\napprovals = []\n\n[policy.approver_sets]\n";
  const out = applyApproverPolicy(cfg, "did:key:fake");
  assert.match(out, /^enforcement = true$/m);
  assert.doesNotMatch(out, /^approvals = \[\]$/m);
  assert.match(out, /^\[policy\.approver_sets\]\ndemo-approvers = \["did:key:fake"\]$/m);
  assert.match(out, /\[\[policy\.approvals\]\]\ntaskType\s+= "https:\/\/trusttasks\.org\/spec\/vta\/contexts\/update\/1\.0"/);
  assert.throws(() => applyApproverPolicy("[server]\n", "did:key:fake"), /could not switch policy\.enforcement on/);
});

test("pin tags and --version output parse to x.y.z", () => {
  assert.equal(semverFromTag("vta-service-v0.65.0"), "0.65.0");
  assert.equal(semverFromTag("vtc-service-v0.15.0"), "0.15.0");
  assert.equal(semverFromTag("nightly"), undefined);
  assert.equal(parseVersionOutput("vta", "vta 0.78.0\n"), "0.78.0");
  assert.equal(parseVersionOutput("vtc", "vtc v0.26.0-rc.1"), "0.26.0-rc.1");
  assert.equal(parseVersionOutput("vta", "vtc 0.26.0"), undefined);
  assert.equal(parseVersionOutput("vta", "usage: vta"), undefined);
});

const probe = (output?: string, error?: string) => ({ name: "vta" as const, bin: "/b/vta", pinTag: "vta-service-v0.65.0", output, error });

test("version: an exact match passes", () => {
  const v = judgeVersion(probe("vta 0.65.0\n"), false);
  assert.deepEqual([v.status, v.level, v.found, v.pinned], ["match", "ok", "0.65.0", "0.65.0"]);
});

test("version: a mismatch fails with path, both versions and the fix; the override makes it a warning", () => {
  const v = judgeVersion(probe("vta 0.78.0\n"), false);
  assert.deepEqual([v.status, v.level], ["mismatch", "fail"]);
  for (const s of ["/b/vta", "0.78.0", "0.65.0"]) assert.ok(v.detail.includes(s), s);
  assert.match(v.fix!, /VTI_ALLOW_VERSION_MISMATCH=1/);
  assert.match(v.fix!, /pins/);
  const w = judgeVersion(probe("vta 0.78.0\n"), true);
  assert.deepEqual([w.status, w.level], ["mismatch", "warn"]);
  assert.match(w.detail, /VTI_ALLOW_VERSION_MISMATCH=1/);
  assert.equal(judgeVersion(probe("vta 0.65.0"), true).level, "ok");
});

test("version: unparsable or unrunnable output fails (warns with the override)", () => {
  for (const p of [probe("hello"), probe(undefined, "ENOENT"), probe("", "exit 1")]) {
    const v = judgeVersion(p, false);
    assert.deepEqual([v.status, v.level], ["unreadable", "fail"]);
    assert.match(v.detail, /could not read its version/);
    assert.equal(judgeVersion(p, true).level, "warn");
  }
  assert.equal(judgeVersion({ ...probe("vta 0.65.0"), pinTag: "bad" }, false).level, "fail");
});
