import assert from "node:assert/strict";
import { test } from "node:test";
import { flag, option, positionals } from "../lib/rooms-args.js";

test("positionals skip flags and the value of --name", () => {
  const a = ["did:example:room", "hello", "world", "--markdown", "--name", "A B"];
  assert.deepEqual(positionals(a), ["did:example:room", "hello", "world"]);
  assert.equal(flag(a, "markdown"), true);
  assert.equal(flag(a, "follow"), false);
  assert.equal(option(a, "name"), "A B");
  assert.equal(option(a, "nothing"), undefined);
});
