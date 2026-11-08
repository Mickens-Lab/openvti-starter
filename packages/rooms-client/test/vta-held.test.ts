import assert from "node:assert/strict";
import { test } from "node:test";
import { VtaKeyOracle } from "../src/vta-keys.js";

test("held() lists the rooms and members the VTA holds group state for", async () => {
  const vta = { call: async (type: string) => { assert.match(type, /rooms\/keys\/list\/0\.2$/); return { rooms: [{ roomId: "r1", member: "did:example:p", epoch: 2 }, { bogus: true }] }; } };
  assert.deepEqual(await new VtaKeyOracle(vta as any).held(), [{ roomId: "r1", member: "did:example:p", epoch: 2 }]);
});

test("held() is empty when the VTA holds nothing", async () => {
  assert.deepEqual(await new VtaKeyOracle({ call: async () => ({ rooms: [] }) } as any).held(), []);
  assert.deepEqual(await new VtaKeyOracle({ call: async () => ({}) } as any).held(), []);
});
