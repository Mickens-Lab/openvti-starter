import assert from "node:assert/strict";
import { test } from "node:test";
import { VtaKeyOracle } from "../src/vta-keys.js";

function fakeVta(startEpoch: number) {
  let epoch = startEpoch;
  const applied: number[] = [];
  return {
    applied,
    call: async (type: string, payload: any) => {
      if (type.endsWith("/rooms/keys/list/0.2")) return { rooms: [{ roomId: "r", member: "did:example:m", epoch }] };
      if (type.endsWith("/rooms/keys/commit/0.1")) { if (payload.epoch === epoch + 1) { epoch = payload.epoch; applied.push(payload.epoch); } return { epoch }; }
      throw new Error(`unexpected ${type}`);
    },
  };
}

test("catchUp applies the host's commits above the VTA's epoch, in order", async () => {
  const vta = fakeVta(2);
  const asked: number[] = [];
  const source = { commits: async (_r: string, since: number) => { asked.push(since); return since >= 4 ? { commits: [], roomEpoch: 4 } : { commits: [{ epoch: 3, commit: "c3" }, { epoch: 4, commit: "c4" }], roomEpoch: 4 }; } };
  const r = await new VtaKeyOracle(vta as any).catchUp("r", source);
  assert.deepEqual(vta.applied, [3, 4]);
  assert.deepEqual(r, { applied: 2, epoch: 4 });
  assert.equal(asked[0], 2);
});

test("catchUp does nothing when the VTA is already current, and for a room it does not hold", async () => {
  const current = fakeVta(4);
  assert.deepEqual(await new VtaKeyOracle(current as any).catchUp("r", { commits: async () => ({ commits: [], roomEpoch: 4 }) }), { applied: 0, epoch: 4 });
  assert.deepEqual(await new VtaKeyOracle(fakeVta(2) as any).catchUp("other", { commits: async () => { throw new Error("must not be asked"); } }), { applied: 0 });
});

test("a replayed commit is not counted as applied", async () => {
  const vta = fakeVta(3);
  const r = await new VtaKeyOracle(vta as any).catchUp("r", { commits: async (_r, since) => (since >= 3 && vta.applied.length === 0 ? { commits: [{ epoch: 3, commit: "c3" }], roomEpoch: 3 } : { commits: [] }) });
  assert.equal(r.applied, 0);
});
