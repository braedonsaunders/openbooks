import assert from "node:assert/strict";
import test from "node:test";
import {
  ENGINE_PENDING,
  EnginePendingError,
  getPeriodRunEngine,
  pendingPeriodRunEngine,
  setPeriodRunEngine,
  vectorShares,
} from "./a8-shims.ts";

// Seam contract for the not-yet-landed A2/A3 engines (A8). The pending
// bindings throw a typed error routes map to 503; the fake here proves the
// seam swaps without touching callers.

test("pending period-run engine reports engine_pending", async () => {
  for (const call of [
    () => pendingPeriodRunEngine.preview({ orgId: "o", actorId: "u", ruleId: "r", periodId: "p", bookId: "b" }),
    () => pendingPeriodRunEngine.post({ orgId: "o", actorId: "u", runId: "r", reason: "close" }),
    () => pendingPeriodRunEngine.reverse({ orgId: "o", actorId: "u", runId: "r", reason: "fix" }),
    () => pendingPeriodRunEngine.rerun({ orgId: "o", actorId: "u", runId: "r" }),
  ]) {
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof EnginePendingError);
      assert.equal(error.code, ENGINE_PENDING);
      assert.match(error.ownerShard, /A[0-9]/);
      return true;
    });
  }
});

test("the engine seam swaps and restores", () => {
  const before = getPeriodRunEngine();
  setPeriodRunEngine(pendingPeriodRunEngine);
  assert.equal(getPeriodRunEngine(), pendingPeriodRunEngine);
  setPeriodRunEngine(before);
  assert.equal(getPeriodRunEngine(), before);
});

test("vector shares are exact decimals, zero-safe", () => {
  assert.deepEqual(
    vectorShares(new Map([["a", "1.0000"], ["b", "3.0000"]])),
    new Map([["a", "0.2500"], ["b", "0.7500"]]),
  );
  assert.deepEqual(vectorShares(new Map([["a", "0.0000"]])), new Map([["a", "0.0000"]]));
  assert.deepEqual(vectorShares(new Map()), new Map());
});
