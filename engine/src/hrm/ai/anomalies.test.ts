import assert from "node:assert/strict";
import test from "node:test";
import { listFlags } from "./anomalies.ts";
import type { SqlExecutor } from "../../platform/db.ts";

test("anomaly list rejects malformed dates and employment ids before issuing SQL", async () => {
  let queries = 0;
  const exec = {
    execute: async () => {
      queries += 1;
      throw new Error("invalid filters must not reach the database");
    },
  } as unknown as SqlExecutor;
  const base = { orgId: "org", actorId: "actor" };

  await assert.rejects(
    listFlags(exec, { ...base, periodFrom: "" }),
    /periodFrom must be a valid calendar date/,
  );
  await assert.rejects(
    listFlags(exec, { ...base, periodTo: "2026-02-30" }),
    /periodTo must be a valid calendar date/,
  );
  await assert.rejects(
    listFlags(exec, { ...base, periodFrom: "2026-06-30", periodTo: "2026-06-01" }),
    /periodTo must be on or after periodFrom/,
  );
  await assert.rejects(
    listFlags(exec, { ...base, employmentId: "invalid" }),
    /employmentId must be a valid UUID/,
  );
  assert.equal(queries, 0);
});
