import assert from "node:assert/strict";
import { test } from "node:test";
import { builderCreateArgs, builderName, limitedBuildArgv, limitsFromEnv, parseLimitFlags } from "../lib/build-limits.js";

test("defaults: 6g and a quarter of the cores; BUILD_LIMITS=0 turns it off", () => {
  assert.deepEqual(limitsFromEnv({}, 12), { memory: "6g", cpus: 3 });
  assert.deepEqual(limitsFromEnv({}, 1), { memory: "6g", cpus: 1 });
  assert.equal(limitsFromEnv({ BUILD_LIMITS: "0" }, 12), undefined);
  assert.deepEqual(limitsFromEnv({ BUILD_MEMORY: "4096M", BUILD_CPUS: "2.5" }, 12), { memory: "4096m", cpus: 2.5 });
});

test("malformed values are rejected", () => {
  assert.throws(() => limitsFromEnv({ BUILD_MEMORY: "lots" }, 4), /BUILD_MEMORY/);
  assert.throws(() => limitsFromEnv({ BUILD_CPUS: "0" }, 4), /BUILD_CPUS/);
});

test("the builder carries memory (no swap), cpu quota and low shares, and is named after them", () => {
  const l = { memory: "6g", cpus: 2.5 };
  assert.equal(builderName(l), "buildathon2-m6g-c2_5");
  const a = builderCreateArgs(l).join(" ");
  assert.match(a, /memory=6g/);
  assert.match(a, /memory-swap=6g/);
  assert.match(a, /cpu-quota=250000/);
  assert.match(a, /cpu-shares=64/);
  assert.match(a, /cpuset-cpus=0-1\b/);
  assert.deepEqual(limitsFromEnv({ BUILD_CPUS: "64" }, 12), { memory: "6g", cpus: 12 });
});

test("builds go through the limited builder with --load, or fall back to plain niced docker build", () => {
  const l = { memory: "6g", cpus: 2 };
  assert.deepEqual(limitedBuildArgv(l, ["-t", "x", "."]), ["nice", "-n", "10", "docker", "buildx", "build", "--builder", "buildathon2-m6g-c2", "--load", "-t", "x", "."]);
  assert.deepEqual(limitedBuildArgv(undefined, ["."]), ["nice", "-n", "10", "docker", "build", "."]);
});

test("flags set the limits in both spellings and leave the other arguments alone", () => {
  const r = parseLimitFlags(["vta", "--memory", "8g", "--cpus=4", "--clone"]);
  assert.deepEqual(r.rest, ["vta", "--clone"]);
  assert.deepEqual(r.env, { BUILD_MEMORY: "8g", BUILD_CPUS: "4" });
  assert.deepEqual(parseLimitFlags(["--no-limits"]).env, { BUILD_LIMITS: "0" });
  assert.match(parseLimitFlags(["--memory"]).error!, /needs a value/);
});
