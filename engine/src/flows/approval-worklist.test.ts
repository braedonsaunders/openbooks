import assert from "node:assert/strict";
import { test } from "node:test";
import { gateDecisionCapabilities, type GateDecisionCapability } from "./approval-worklist.ts";

const capability = (canAct: boolean, sodBlocked = false): GateDecisionCapability => ({
  canAct,
  signatureRequired: false,
  sodBlocked,
  canDelegate: false,
});

test("decision capabilities resolve every gate once, keyed by gate, a few at a time", async () => {
  const ids = Array.from({ length: 11 }, (_, index) => `gate-${index}`);
  let inFlight = 0;
  let peak = 0;
  const evaluated: string[] = [];
  const capabilities = await gateDecisionCapabilities(
    [...ids, "gate-3"],
    "viewer",
    async (gateId, userId) => {
      assert.equal(userId, "viewer");
      evaluated.push(gateId);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return capability(Number(gateId.slice(5)) % 2 === 0, gateId === "gate-7");
    },
  );
  assert.deepEqual([...evaluated].sort(), [...ids].sort(), "a repeated id is evaluated once");
  assert.deepEqual([...capabilities.keys()].sort(), [...ids].sort());
  assert.equal(capabilities.get("gate-4")?.canAct, true);
  assert.equal(capabilities.get("gate-5")?.canAct, false);
  assert.equal(capabilities.get("gate-7")?.sodBlocked, true);
  assert.ok(peak > 1, "checks overlap instead of running one after another");
  assert.ok(peak <= 4, `at most four checks hold connections at once (saw ${peak})`);
});

test("a failed decision check fails the whole capability read", async () => {
  await assert.rejects(
    gateDecisionCapabilities(["gate-a", "gate-b", "gate-c"], "viewer", async (gateId) => {
      if (gateId === "gate-b") throw new Error("gate read failed");
      return capability(true);
    }),
    /gate read failed/,
  );
});

test("an empty worklist evaluates nothing", async () => {
  const capabilities = await gateDecisionCapabilities([], "viewer", async () => {
    throw new Error("must not evaluate");
  });
  assert.equal(capabilities.size, 0);
});
