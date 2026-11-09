// The default CORS allow-lists in the VTA and VTC entrypoints: rendered here in a throwaway shell, no Docker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { corsTomlBody, LOCAL_CORS_SUMMARY, localCorsOrigins, originInDefaultCors } from "@starter/vta-client";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

function renderDefault(entrypoint: string): string {
  const sh = read(entrypoint);
  const a = sh.indexOf("# BEGIN default-cors");
  const b = sh.indexOf("# END default-cors");
  assert.ok(a >= 0 && b > a, `${entrypoint} has the default-cors block`);
  const r = spawnSync("sh", ["-c", `set -eu\n${sh.slice(a, b)}\ndefault_cors`], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("both entrypoints render exactly the list in vta-client", () => {
  for (const f of ["vta-entrypoint.sh", "vtc-entrypoint.sh"]) assert.equal(renderDefault(f), corsTomlBody(), f);
});

test("the default list is loopback only, exact origins, and covers the ports people land on", () => {
  const all = localCorsOrigins();
  assert.ok(all.length > 20 && all.length < 120, "modest");
  for (const o of all) assert.match(o, /^http:\/\/(localhost|127\.0\.0\.1):\d{4}$/, o);
  assert.equal(new Set(all).size, all.length, "no duplicates");
  for (const o of ["http://localhost:3050", "http://localhost:5174", "http://127.0.0.1:5173", "http://localhost:3000", "http://localhost:8000", "http://localhost:4173"]) {
    assert.ok(originInDefaultCors(o), o);
  }
  for (const o of ["http://localhost:9999", "https://localhost:5173", "http://example.com:5173", "http://localhost.evil.com:5173", "*", "http://[::1]:5173"]) {
    assert.equal(originInDefaultCors(o), false, o);
  }
  assert.match(LOCAL_CORS_SUMMARY, /3000-3009, 3050, 4000-4009, 4173, 5173-5183, 8000-8009/);
});

test("the override variables still replace the default, and the VTC config line is filled in", () => {
  assert.match(read("vta-entrypoint.sh"), /CORS="\$\{CORS_ORIGINS_TOML:-\$DEFAULT_CORS\}"/);
  assert.match(read("vtc-entrypoint.sh"), /CORS="\$\{VTC_CORS_ORIGINS_TOML:-\$DEFAULT_CORS\}"/);
  // The VTC entrypoint's own sed, against the line `vtc setup` writes.
  const dir = mkdtempSync(join(tmpdir(), "vtc-cors-"));
  try {
    const cfg = join(dir, "config.toml");
    writeFileSync(cfg, "[cors]\nallowed_origins = []\n");
    const line = read("vtc-entrypoint.sh").split("\n").find((l) => l.includes("sed -i") && l.includes("allowed_origins"))!;
    assert.ok(line, "sed line present");
    const r = spawnSync("sh", ["-c", `CONFIG=${cfg}\n${renderBlock()}\nCORS="$(default_cors)"\n${line.trim()}`], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, r.stderr);
    const out = readFileSync(cfg, "utf8");
    assert.ok(out.includes(`allowed_origins = [${corsTomlBody()}]`));
    assert.match(out, /^allowed_origins = \["/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function renderBlock(): string {
  const sh = read("vtc-entrypoint.sh");
  return sh.slice(sh.indexOf("# BEGIN default-cors"), sh.indexOf("# END default-cors"));
}
