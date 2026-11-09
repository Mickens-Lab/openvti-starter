import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodeCredential } from "@starter/vta-client";
import { collectEntries, createPersona, listPersonas, removePersonas, separationWarnings } from "../lib/personas.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "personas-")), "p");

test("create writes a 0600 file with a fresh did:key; admin gets no env file", () => {
  const dir = tmp();
  try {
    const a = createPersona("alice", "applicant", { dir, vta: { vtaDid: "did:webvh:Qmfake:localhost", vtaUrl: "http://localhost:8100" } });
    const b = createPersona("boss", "admin", { dir, vta: { vtaDid: "did:webvh:Qmfake:localhost" } });
    assert.notEqual(a.file.did, b.file.did);
    assert.match(a.file.did, /^did:key:z6Mk/);
    assert.equal(statSync(join(dir, "alice.json")).mode & 0o777, 0o600);
    assert.equal(statSync(a.envPath!).mode & 0o777, 0o600);
    assert.equal(decodeCredential(readFileSync(a.envPath!, "utf8").match(/VTA_CREDENTIAL=(.+)/)![1]).did, a.file.did);
    assert.equal(b.envPath, undefined);
    assert.deepEqual(readdirSync(dir).sort(), ["alice.env", "alice.json", "boss.json"]);
    assert.throws(() => createPersona("alice", "member", { dir }), /already exists/);
    assert.throws(() => createPersona("../x", "member", { dir }), /must be/);
    assert.equal(removePersonas(dir), 2);
    assert.deepEqual(listPersonas(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("warns, without blocking, when one identity is both admin and applicant", () => {
  const same = "did:key:z6MkFake";
  const ws = separationWarnings([{ did: same, role: "admin", source: ".vta/admin.json" }, { did: same, role: "applicant", source: "the app identity (.env)" }]);
  assert.equal(ws.length, 1);
  assert.match(ws[0].text, /apply and approve/);
  assert.deepEqual(separationWarnings([{ did: "did:key:z6MkA", role: "admin", source: "a" }, { did: "did:key:z6MkB", role: "applicant", source: "b" }]), []);
});

test("strict mode adds expiry, embedded-admin-key and permission warnings; default does not", () => {
  const dir = tmp();
  try {
    const now = new Date("2026-01-01T00:00:00Z");
    createPersona("old", "member", { dir, now, expiresInHours: 1 });
    createPersona("forever", "applicant", { dir, now });
    const admin = createPersona("boss", "admin", { dir, now, expiresInHours: 1 }).file;
    chmodSync(join(dir, "forever.json"), 0o644);
    const entries = collectEntries({ dir });
    assert.deepEqual(separationWarnings(entries, { dir, now: new Date("2026-02-01T00:00:00Z") }), []);
    const text = separationWarnings(entries, { strict: true, dir, now: new Date("2026-02-01T00:00:00Z"), embeddedDids: [admin.did] }).map((w) => w.text).join("\n");
    assert.match(text, /persona old expired/);
    assert.match(text, /persona forever has no expiry/);
    assert.match(text, /admin key is embedded/);
    assert.match(text, /forever\.json is readable by others/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
