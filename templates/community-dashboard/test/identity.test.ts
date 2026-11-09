import assert from "node:assert/strict";
import { test } from "node:test";
import { didPeerFromSeed } from "@starter/tsp-client";
import { identityFromSeed } from "@starter/vta-client";
import { applicantLine, decodeApplicantDid, mediatorGate, readMediatorDoc, summarizeDidLog } from "../src/identity.ts";

const MED = "did:webvh:QmScid:med.example.test";
const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ORIGIN = "http://localhost:5173";

/** A did.jsonl whose latest entry is `state` (an earlier entry first, to show the last one wins). */
const didLog = (state: Record<string, unknown>) => [JSON.stringify({ state: { id: "did:webvh:QmOld:old.example.test" } }), JSON.stringify({ versionId: "2-Qm", state })].join("\n");
const MED_DOC = {
  id: MED,
  verificationMethod: [
    { id: `${MED}#key-0`, type: "Multikey", controller: MED, publicKeyMultibase: "z6MkPublicExample" },
    { id: `${MED}#key-1`, type: "JsonWebKey2020", publicKeyJwk: { kty: "OKP", crv: "X25519", x: "public-x", d: "SECRET-D" }, privateKeyMultibase: "zSECRET" },
  ],
  authentication: [`${MED}#key-0`],
  keyAgreement: [`${MED}#key-1`],
  service: [{ id: `${MED}#tsp`, type: "TSPTransport", serviceEndpoint: "https://med.example.test/tsp" }, { id: `${MED}#dm`, type: "DIDCommMessaging", serviceEndpoint: { uri: "wss://med.example.test/ws", accept: ["didcomm/v2"] } }],
};

test("a did:peer:2 decodes to its keys by position, their purposes and types, and the TSPTransport service naming the mediator", () => {
  const p = didPeerFromSeed(seed, MED);
  const d = decodeApplicantDid(p.did);
  assert.equal(d.method, "did:peer:2");
  assert.deepEqual(d.keys.map((k) => [k.id, k.type, k.purposes.join()]), [["#key-1", "X25519", "keyAgreement"], ["#key-2", "Ed25519", "authentication"]]);
  assert.equal(`${p.did}${d.keys[1].id}`, p.authKid);
  assert.equal(`${p.did}${d.keys[0].id}`, p.keyAgreementKid);
  for (const k of d.keys) assert.ok(k.publicKey.startsWith("z") && p.did.includes(k.publicKey));
  assert.deepEqual(d.services, [{ id: "#service", type: "TSPTransport", endpoint: MED }]);
  assert.equal(d.mediatorDid, MED);
  assert.match(d.note, /no lookup is made/);
  assert.match(d.note, /names the mediator by its DID/);
});

test("a did:key decodes to its one key, no service and no mediator", () => {
  const id = identityFromSeed(seed);
  const d = decodeApplicantDid(id.did);
  assert.equal(d.method, "did:key");
  assert.equal(d.keys.length, 1);
  assert.equal(d.keys[0].type, "Ed25519");
  assert.equal(`did:key:${d.keys[0].publicKey}`, id.did);
  assert.deepEqual(d.services, []);
  assert.equal(d.mediatorDid, undefined);
  assert.match(d.note, /no mediator/);
});

test("nothing decoded ever carries the seed or the private key-agreement key", () => {
  const p = didPeerFromSeed(seed, MED);
  const text = JSON.stringify([decodeApplicantDid(p.did), decodeApplicantDid(identityFromSeed(seed).did)]);
  assert.ok(!text.includes(p.secretJwk.d));
  assert.ok(!text.includes(Buffer.from(seed).toString("hex")));
});

test("a broken did:peer:2 or another method is reported, not thrown", () => {
  const bad = decodeApplicantDid("did:peer:2.Vnotbase58");
  assert.ok(bad.error);
  assert.equal(decodeApplicantDid("did:web:example.test").method, "other");
});

test("the mediator gate: none in local or farm mode, the tunnel's mediator otherwise", () => {
  assert.match(mediatorGate("local", null).text, /^No mediator in local mode/);
  assert.equal(mediatorGate("local", MED).did, undefined);
  assert.match(mediatorGate("farm", null).text, /no mediator for a hosted community/);
  assert.match(mediatorGate("tunnel", null).text, /\.vta\/tunnel\.json has no mediator DID/);
  const t = mediatorGate("tunnel", MED);
  assert.equal(t.did, MED);
  assert.match(t.text, /does not check the log's hashes or proofs/);
});

test("the applicant line says which DID the page applies as, and why it fell back", () => {
  assert.match(applicantLine("did:peer"), /did:peer:2 whose TSPTransport service names/);
  assert.equal(applicantLine("did:key"), "This page applies as its did:key.");
  assert.match(applicantLine("did:key", "the reason."), /would apply as a did:peer:2, but the reason\.$/);
});

test("summarizeDidLog shows the latest entry's id, methods, relationships and services, and only public key material", () => {
  const v = summarizeDidLog(didLog(MED_DOC));
  assert.equal(v.id, MED);
  assert.deepEqual(v.verificationMethods, [
    { id: `${MED}#key-0`, type: "Multikey", publicKey: "z6MkPublicExample" },
    { id: `${MED}#key-1`, type: "JsonWebKey2020", publicKey: "kty=OKP crv=X25519 x=public-x" },
  ]);
  assert.deepEqual(v.relationships, [{ name: "authentication", ids: [`${MED}#key-0`] }, { name: "keyAgreement", ids: [`${MED}#key-1`] }]);
  assert.deepEqual(v.services, [
    { id: `${MED}#tsp`, type: "TSPTransport", endpoint: "https://med.example.test/tsp" },
    { id: `${MED}#dm`, type: "DIDCommMessaging", endpoint: '{"uri":"wss://med.example.test/ws","accept":["didcomm/v2"]}' },
  ]);
  assert.ok(!JSON.stringify(v).includes("SECRET"));
  assert.throws(() => summarizeDidLog("not json"));
});

const fakeFetch = (fn: (url: string) => Response | Promise<Response>) => (async (u: string | URL | Request) => fn(String(u))) as typeof fetch;

test("readMediatorDoc fetches https://<host>/.well-known/did.jsonl and summarizes it", async () => {
  const seen: string[] = [];
  const r = await readMediatorDoc(MED, ORIGIN, fakeFetch((u) => { seen.push(u); return new Response(didLog(MED_DOC)); }));
  assert.deepEqual(seen, ["https://med.example.test/.well-known/did.jsonl"]);
  assert.ok(r.ok && r.idMatches && r.doc.services.length === 2);
});

test("readMediatorDoc: a blocked fetch says so with the exact MEDIATOR_CORS_ALLOW_ORIGIN line and the recreate command", async () => {
  const r = await readMediatorDoc(MED, ORIGIN, fakeFetch(() => { throw new TypeError("Failed to fetch"); }));
  assert.ok(!r.ok);
  assert.match(r.text, /^Could not read the mediator's DID document from this page \(Failed to fetch\)\. The applicant side above does not need it\./);
  assert.match(r.text, /^MEDIATOR_CORS_ALLOW_ORIGIN=http:\/\/localhost:5173$/m);
  assert.match(r.text, /MEDIATOR_PUBLIC_HOST=med\.example\.test MEDIATOR_CORS_ALLOW_ORIGIN=http:\/\/localhost:5173 docker compose --profile messaging up -d mediator/);
});

test("readMediatorDoc: an HTTP error, a non-did.jsonl body, a mismatched id and a non-did:webvh are each reported", async () => {
  const h = await readMediatorDoc(MED, ORIGIN, fakeFetch(() => new Response("", { status: 404 })));
  assert.ok(!h.ok && /answered HTTP 404/.test(h.text));
  const b = await readMediatorDoc(MED, ORIGIN, fakeFetch(() => new Response("<html>")));
  assert.ok(!b.ok && /did not hold a readable did\.jsonl/.test(b.text));
  const m = await readMediatorDoc(MED, ORIGIN, fakeFetch(() => new Response(didLog({ ...MED_DOC, id: "did:webvh:QmOther:med.example.test" }))));
  assert.ok(m.ok && !m.idMatches);
  const n = await readMediatorDoc("did:peer:2.Vz", ORIGIN, fakeFetch(() => { throw new Error("must not fetch"); }));
  assert.ok(!n.ok && /not a did:webvh/.test(n.text));
});
