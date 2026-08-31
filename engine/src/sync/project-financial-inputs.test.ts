import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const syncSource = readFileSync(
  new URL("./project-financial-inputs.ts", import.meta.url),
  "utf8",
);

test("project financial writes fence every mutable time-entry preimage", () => {
  for (const field of [
    "employee_party_id",
    "project_id",
    "item_id",
    "department_id",
    "time_type_id",
    "billing_status",
    "costing_basis",
    "worked_on",
    "hours",
    "cost_rate",
    "bill_rate",
    "is_billable",
  ]) {
    assert.match(
      syncSource,
      new RegExp(
        `te\\.${field}\\s+is not distinct from input\\."before${
          field === "employee_party_id"
            ? "EmployeeId"
            : field === "project_id"
              ? "ProjectId"
              : field === "item_id"
                ? "ItemId"
                : field === "department_id"
                  ? "DepartmentId"
                  : field === "time_type_id"
                    ? "TimeTypeId"
                    : field
                        .split("_")
                        .map((part) => part[0]!.toUpperCase() + part.slice(1))
                        .join("")
        }"`,
      ),
      `time-entry ${field} must be guarded by its captured before-value`,
    );
  }
  assert.match(
    syncSource,
    /te\.custom ->> 'sourceBillingStatus'\s+is not distinct from input\."beforeSourceStatus"/,
  );
  assert.match(syncSource, /if \(write\.rows\.length !== batch\.length\)/);
});

test("project financial writes fence project preimages and fail on a skipped row", () => {
  assert.match(
    syncSource,
    /p\.project_type_id\s+is not distinct from input\."beforeProjectTypeId"/,
  );
  assert.match(
    syncSource,
    /p\.contract_value\s+is not distinct from input\."beforeContractValueRaw"/,
  );
  assert.match(
    syncSource,
    /if \(\(updated\.rowCount \?\? 0\) !== batch\.length\)[\s\S]*?concurrent project edits/,
  );
});
