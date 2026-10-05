import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../platform/db.ts";
import { recordBillingLink } from "./billing-history-import.ts";

test("billing import accepts only observable replays of the same native table and record", async (t) => {
  for (const target of [
    { native_id: "other-record", native_table: "parties" },
    { native_id: "same-record", native_table: "documents" },
    undefined,
    { native_id: "same-record", native_table: "parties" },
  ]) {
    let calls = 0;
    const execute = t.mock.method(db, "execute", async () => {
      calls++;
      if (calls === 1) return { rows: [], rowCount: 0 };
      if (calls === 2) return { rows: [], rowCount: 0 };
      assert.equal(calls, 3, "a conflict must be re-read before a replay is accepted");
      return { rows: target ? [target] : [], rowCount: target ? 1 : 0 };
    });
    try {
      const result = recordBillingLink("org", "chargebee", "site", "customer", "customer-1", "parties", "same-record", null);
      if (target?.native_id === "same-record" && target.native_table === "parties") {
        assert.equal(await result, "replayed");
      } else {
        await assert.rejects(result, (error: unknown) => {
          const refusal = error as { code: string; status: number; message: string; remedy: string };
          assert.equal(refusal.code, target ? "billing_import_link_conflict" : "billing_import_link_unrecorded");
          assert.equal(refusal.status, 409);
          assert.match(refusal.message, /chargebee customer customer-1/);
          assert.match(refusal.remedy, target ? /Review the existing link/ : /Retry the import/);
          return true;
        });
      }
      assert.equal(calls, 3);
    } finally { execute.mock.restore(); }
  }
});
