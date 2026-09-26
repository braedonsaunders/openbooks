import assert from "node:assert/strict";
import test from "node:test";
import { retry } from "./retry.ts";

test("retry re-runs deadlock, serialization and connection failures, never a refusal", async () => {
  const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
  const dropped = new Error("query failed", { cause: new Error("read ECONNRESET") });
  for (const transient of [deadlock, dropped]) {
    let calls = 0;
    assert.equal(await retry(async () => { if (calls++ === 0) throw transient; return "ok"; }, 2, 0), "ok");
  }
  const refusal = new Error("refusing: target org is not a sandbox");
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw refusal; }, 3, 0), refusal);
  assert.equal(calls, 1, "a refusal is raised on the first attempt, not retried");
});
