import assert from "node:assert/strict";
import test from "node:test";
import { processTriggerForApply } from "./processes.ts";

test("approved changes map to the checklist they owe, or none", () => {
  assert.deepEqual(
    processTriggerForApply({ kind: "hire", effectiveFrom: "2026-09-01" }),
    { trigger: "hire", effectiveDate: "2026-09-01" },
  );
  assert.deepEqual(
    processTriggerForApply({ kind: "termination", effectiveDate: "2026-09-30" }),
    { trigger: "termination", effectiveDate: "2026-09-30" },
  );
  assert.equal(processTriggerForApply({ kind: "status_change" }), null);
  assert.deepEqual(
    processTriggerForApply({ kind: "assignment_change", departmentChanged: true, windowStart: "2026-10-01" }),
    { trigger: "transfer", effectiveDate: "2026-10-01" },
  );
  assert.equal(
    processTriggerForApply({ kind: "assignment_change", departmentChanged: false, windowStart: "2026-10-01" }),
    null,
  );
});
