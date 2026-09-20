import test from "node:test";
import assert from "node:assert/strict";
import {
  clearWorkerDuties,
  listWorkerDuties,
  registerWorkerDuty,
  runWorkerDuties,
  WorkerDutyError,
} from "./duties.ts";

test("duties register, list, and run in order", async () => {
  clearWorkerDuties();
  try {
    const order: string[] = [];
    registerWorkerDuty({ key: "a", run: async () => { order.push("a"); } });
    registerWorkerDuty({ key: "b", run: async () => { order.push("b"); } });
    assert.deepEqual(listWorkerDuties(), ["a", "b"]);
    const summary = await runWorkerDuties(new Date("2026-09-20T12:00:00Z"));
    assert.deepEqual(order, ["a", "b"]);
    assert.deepEqual(summary, [{ key: "a", ok: true }, { key: "b", ok: true }]);
  } finally {
    clearWorkerDuties();
  }
});

test("duplicate keys refuse instead of double-firing", () => {
  clearWorkerDuties();
  try {
    registerWorkerDuty({ key: "solo", run: async () => {} });
    assert.throws(
      () => registerWorkerDuty({ key: "solo", run: async () => {} }),
      (e: unknown) => e instanceof WorkerDutyError && /already registered/.test((e as Error).message),
    );
  } finally {
    clearWorkerDuties();
  }
});

test("a throwing duty is recorded, never propagated to the rest", async () => {
  clearWorkerDuties();
  try {
    let second = false;
    registerWorkerDuty({ key: "bad", run: async () => { throw new Error("boom"); } });
    registerWorkerDuty({ key: "good", run: async () => { second = true; } });
    const summary = await runWorkerDuties();
    assert.equal(second, true);
    assert.equal(summary[0]!.ok, false);
    assert.equal(summary[0]!.error, "boom");
    assert.equal(summary[1]!.ok, true);
  } finally {
    clearWorkerDuties();
  }
});

test("the worker composition entry registers the automation tick without booting", async () => {
  // scripts/worker-entry.ts is the worker's composition root outside the
  // engine module graph: importing it registers duties (pure registry
  // insert) while the worker boot behind import.meta argv-guard stays off
  // under the test runner. This proves the production worker runs the
  // automation scan every scheduler pass.
  clearWorkerDuties();
  try {
    await import("../../../scripts/worker-entry.mts");
    assert.ok(
      listWorkerDuties().includes("automation-tick"),
      "the worker registry must carry the automation tick after booting the composition entry",
    );
  } finally {
    clearWorkerDuties();
  }
});
