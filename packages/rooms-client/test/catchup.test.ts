import assert from "node:assert/strict";
import { test } from "node:test";
import { TrustTaskError } from "@starter/vta-client";
import { VtaKeyOracle } from "../src/vta-keys.js";

const err = (status: number, code: string, message: string) => new TrustTaskError(status, { payload: { code, message } });

/**
 * A fake VTA. `group` is the real MLS epoch (what rooms/keys/list reports), `tracker` the epoch its commit bookkeeping believes.
 * A commit's bytes are "cN" and carry epoch N. Default: tracker == group. Pass a lower tracker to model the 0.72.0 off-by-one.
 */
function fakeVta(group: number, tracker = group) {
  const applied: number[] = [];
  return {
    applied,
    call: async (type: string, payload: any) => {
      if (type.endsWith("/rooms/keys/list/0.2")) return { rooms: [{ roomId: "r", member: "did:example:m", epoch: group }] };
      if (!type.endsWith("/rooms/keys/commit/0.1")) throw new Error(`unexpected ${type}`);
      if (payload.epoch === tracker) return { epoch: tracker }; // replay
      if (payload.epoch !== tracker + 1) throw err(422, "taskFailed", `conflict: commit produces epoch ${payload.epoch} but room is at ${tracker}; resume from ${tracker + 1}`);
      const bytes = Number(String(payload.commit).slice(1));
      if (bytes !== group + 1) throw err(400, "malformedRequest", "the commit did not process: ValidationError(WrongEpoch)");
      group = bytes;
      tracker = payload.epoch;
      applied.push(bytes);
      return { epoch: tracker };
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
  assert.deepEqual(await new VtaKeyOracle(fakeVta(4) as any).catchUp("r", { commits: async () => ({ commits: [], roomEpoch: 4 }) }), { applied: 0, epoch: 4 });
  assert.deepEqual(await new VtaKeyOracle(fakeVta(2) as any).catchUp("other", { commits: async () => { throw new Error("must not be asked"); } }), { applied: 0 });
});

test("a replayed commit is not counted as applied", async () => {
  const vta = fakeVta(3);
  const r = await new VtaKeyOracle(vta as any).catchUp("r", { commits: async (_r, since) => (vta.applied.length === 0 && since <= 3 ? { commits: [{ epoch: 3, commit: "c3" }], roomEpoch: 3 } : { commits: [] }) });
  assert.equal(r.applied, 0);
});

test("the 0.72.0 off-by-one: WrongEpoch for an epoch already held is skipped, 'resume from M' is answered with epoch M", async () => {
  const vta = fakeVta(2, 1); // group at 2, tracker believes 1
  const source = { commits: async (_r: string, since: number) => (since < 3 ? { commits: [{ epoch: 2, commit: "c2" }, { epoch: 3, commit: "c3" }], roomEpoch: 3 } : { commits: [], roomEpoch: 3 }) };
  const r = await new VtaKeyOracle(vta as any).catchUp("r", source);
  assert.deepEqual(vta.applied, [3]);
  assert.deepEqual(r, { applied: 1, epoch: 3 });
});

test("a genuine gap still fails: the retry reaches MLS, which refuses", async () => {
  const vta = fakeVta(2, 1);
  const source = { commits: async () => ({ commits: [{ epoch: 5, commit: "c5" }], roomEpoch: 5 }) };
  await assert.rejects(new VtaKeyOracle(vta as any).catchUp("r", source), /WrongEpoch/);
});
