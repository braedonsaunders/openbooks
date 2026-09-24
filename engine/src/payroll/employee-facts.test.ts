import assert from "node:assert/strict";
import test from "node:test";
import { PayrollPackError } from "./payroll-error.ts";
import { registerEmployeeFacts, resolveEmployeeFact } from "./employee-facts.ts";

const FIXTURE_FACTS = [
  {
    key: "fixture_contract_type",
    kind: "choice",
    choices: ["permanent", "temporary"],
    label: "employment contract type",
    refusalReason: "The contract type changes statutory withholding.",
    required: true,
    producer: { kind: "certificate", certificate: "fixture", field: "contract_type" },
  },
  {
    key: "fixture_weekly_hours",
    kind: "integer",
    min: 1,
    max: 60,
    label: "weekly hours",
    refusalReason: "Weekly hours set the statutory threshold.",
    required: true,
    producer: { kind: "profile_column", column: "fixture_weekly_hours" },
  },
  {
    key: "fixture_optional_flag",
    kind: "flag",
    label: "optional statutory election",
    refusalReason: "This election changes the calculation when answered.",
    required: false,
    producer: { kind: "none", notes: "Optional fixture input." },
  },
] as const;

test("required employee facts refuse missing values and name the producer remedy", () => {
  registerEmployeeFacts("ZZ", FIXTURE_FACTS);
  assert.throws(
    () => resolveEmployeeFact("ZZ", "fixture_contract_type", null),
    (error) => error instanceof PayrollPackError
      && /employment contract type/.test(error.message)
      && /declared producer/.test(error.message),
  );
});

test("employee-fact resolution validates closed choices, flags and numeric bounds", () => {
  registerEmployeeFacts("ZZ", FIXTURE_FACTS);
  assert.equal(resolveEmployeeFact("ZZ", "fixture_contract_type", " temporary "), "temporary");
  assert.equal(resolveEmployeeFact("ZZ", "fixture_weekly_hours", "40"), "40");
  assert.throws(() => resolveEmployeeFact("ZZ", "fixture_contract_type", "unknown"), /permanent, temporary/);
  assert.throws(() => resolveEmployeeFact("ZZ", "fixture_weekly_hours", "0"), /between 1 and 60/);
  assert.throws(() => resolveEmployeeFact("ZZ", "fixture_weekly_hours", "40.5"), /whole number/);
  assert.equal(resolveEmployeeFact("ZZ", "fixture_optional_flag", null), null);
  assert.equal(resolveEmployeeFact("ZZ", "fixture_optional_flag", "false"), "false");
});
