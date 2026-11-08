import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { encodeCredential, newIdentity, seedToMultibase } from "@starter/vta-client";
import { securityCheck } from "../lib/security.js";

// Every key below is generated here, per run; nothing in this file is a real or committed secret.
function tree(files: Record<string, string>, modes: Record<string, number> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "seccheck-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    chmodSync(join(root, rel), modes[rel] ?? 0o600);
  }
  return root;
}
const credential = () => {
  const id = newIdentity();
  return { cred: encodeCredential({ did: id.did, privateKeyMultibase: seedToMultibase(id.seed), vtaDid: "did:webvh:Qmfake:localhost" }), key: seedToMultibase(id.seed) };
};
const rules = (root: string) => securityCheck(root).findings.map((f) => `${f.severity}:${f.rule}`).sort();

test("a clean tree passes with no findings", () => {
  const { cred } = credential();
  const root = tree({
    ".env": `VTA_CREDENTIAL=${cred}\n`,
    ".vta/admin.json": JSON.stringify({ did: "did:key:z6MkFake" }),
    "app/dist/index.js": "console.log('hello, no secrets here');",
    "config/vta.toml": 'cors_origins = ["http://localhost:5173"]\n[secrets]\nbackend = "keyring"\n',
  });
  try { assert.deepEqual(securityCheck(root).findings, []); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a deliberately bad tree is flagged for every rule", () => {
  const { cred, key } = credential();
  const root = tree({
    ".env": `VTA_CREDENTIAL=${cred}\n`,
    ".vta/admin.json": JSON.stringify({ did: "did:key:z6MkFake", privateKeyMultibase: key }),
    "web/dist/assets/app.js": `const c="${cred}";`,                   // the exact credential from .env
    "web/dist/other.js": `x={privateKeyMultibase:"${key}"}`,          // key shape, no match to a known value needed
    "config/vta.toml": 'cors_origins = ["*"]\n[secrets]\nbackend = "plaintext"\n',
    "server.sh": "# backend = \"plaintext\" in a comment is ignored\necho ok\n",
  }, { ".env": 0o644, ".vta/admin.json": 0o640 });
  try {
    const found = securityCheck(root).findings;
    const has = (rule: string, file: RegExp) => found.some((f) => f.rule === rule && file.test(f.file));
    assert.ok(has("permissions", /^\.env$/));
    assert.ok(has("permissions", /admin\.json$/));
    assert.ok(has("bundle-credential", /app\.js$/));
    assert.ok(has("bundle-credential", /other\.js$/));
    assert.ok(has("wide-cors", /vta\.toml:1$/));
    assert.ok(found.some((f) => f.rule === "plaintext-secrets" && f.severity === "warn" && /vta\.toml:3$/.test(f.file)));
    assert.equal(found.filter((f) => /server\.sh/.test(f.file)).length, 0, "comments are ignored");
    // No finding may repeat a secret value.
    assert.ok(!JSON.stringify(found).includes(key) && !JSON.stringify(found).includes(cred));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unrelated build that merely contains a JWT-like token is not flagged", () => {
  const jwt = "eyJ" + Buffer.from(JSON.stringify({ alg: "none", note: "x".repeat(80) })).toString("base64url").slice(3);
  const root = tree({ "dist/a.js": `var t="${jwt}"` });
  try { assert.deepEqual(rules(root), []); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("key files that git does not ignore are flagged", () => {
  const root = tree({ ".env": "X=1\n", ".vta/admin.json": "{}", ".gitignore": ".vta/\n" });
  try {
    execFileSync("git", ["init", "-q", root]);
    assert.deepEqual(rules(root), ["error:not-ignored"]); // .env is not ignored, .vta is
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the starter's own entrypoints give only the documented plaintext warnings (no local state is read)", () => {
  const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
  const root = tree({ "vta-entrypoint.sh": read("vta-entrypoint.sh"), "vtc-entrypoint.sh": read("vtc-entrypoint.sh"), "docker-compose.yml": read("docker-compose.yml") });
  try { assert.deepEqual(rules(root), ["warn:plaintext-secrets", "warn:plaintext-secrets"]); } finally { rmSync(root, { recursive: true, force: true }); }
});
