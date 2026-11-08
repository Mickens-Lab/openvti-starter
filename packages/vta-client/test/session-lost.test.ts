import assert from "node:assert/strict";
import { test } from "node:test";
import { TrustTaskError, isSessionLost } from "../src/index.js";

test("isSessionLost recognises a superseded or missing session, and only on a 401", () => {
  assert.equal(isSessionLost(new TrustTaskError(401, { error: "unauthorized: token superseded" })), true);
  assert.equal(isSessionLost(new TrustTaskError(401, { error: "unauthorized: this task needs a session: authenticate, or send a public task" })), true);
  assert.equal(isSessionLost(new TrustTaskError(403, { error: "token superseded" })), false);
  assert.equal(isSessionLost(new TrustTaskError(401, { error: "bad signature" })), false);
  assert.equal(isSessionLost(new Error("token superseded")), false);
});
