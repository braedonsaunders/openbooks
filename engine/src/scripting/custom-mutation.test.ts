import assert from "node:assert/strict";
import test from "node:test";
import {
  beforePostCustomMutationError,
  mergeBeforePostCustomMutation,
  runScript,
  type ScriptContext,
} from "./scripting.ts";

const context: ScriptContext = {
  trigger: "before_submit",
  document: {
    kind: "expense_report",
    custom: { employeePartyId: "employee-1", settlementMethod: "payroll" },
  },
  org: { id: "not-a-database-tenant", name: "Script test", baseCurrency: "USD" },
};

test("before-submit custom mutations must be objects", async () => {
  const result = await runScript(
    `function main() { return { set: { custom: "invalid" } }; }`,
    context,
    2_000,
  );

  assert.equal(result.status, "error");
  assert.match(result.abortReason ?? "", /before_submit scripts may only set custom to an object/);
  assert.equal(
    beforePostCustomMutationError("invalid", "before_submit"),
    "before_submit scripts may only set custom to an object",
  );
});

test("before-submit custom mutations merge with persisted document fields", () => {
  const merged = mergeBeforePostCustomMutation(context.document?.custom, { triageTag: "reviewed" });

  assert.deepEqual(merged, {
    employeePartyId: "employee-1",
    settlementMethod: "payroll",
    triageTag: "reviewed",
  });
});
