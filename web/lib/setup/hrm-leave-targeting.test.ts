import assert from "node:assert/strict";
import { test } from "node:test";
import { leavePolicyRuleProblem, normalizeHrmLeavePolicyInput } from "./hrm-leave-policy";
import { projectRuleSlotPrefills } from "./hrm-rule-slots";

const EMPLOYMENT_A = "00000000-0000-4000-8000-0000000000a1";
const EMPLOYMENT_B = "00000000-0000-4000-8000-0000000000b2";
const CLASSIFICATION = "00000000-0000-4000-8000-0000000000c3";

// The fold never throws; the write path raises the shape refusal through
// leavePolicyRuleProblem over the folded values, so the drawer's refusal is
// exactly that function's answer for the folded body.
function drawerRefusal(body: Record<string, unknown>): string {
  const folded = normalizeHrmLeavePolicyInput("leave-policies", body);
  const problem = leavePolicyRuleProblem({
    appliesTo: folded.appliesTo,
    accrualRule: folded.accrualRule,
    carryoverRule: folded.carryoverRule,
  });
  if (problem) return problem;
  throw new Error(`drawer accepted ${JSON.stringify(body)}; the red-proof needs a refused shape`);
}

function drawerFolded(body: Record<string, unknown>): Record<string, unknown> {
  const folded = normalizeHrmLeavePolicyInput("leave-policies", body);
  const problem = leavePolicyRuleProblem({
    appliesTo: folded.appliesTo,
    accrualRule: folded.accrualRule,
    carryoverRule: folded.carryoverRule,
  });
  assert.equal(problem, null, `drawer refused a valid body: ${problem}`);
  return folded;
}

test("targeting pickers fold into applies_to and empty means all", () => {
  const folded = drawerFolded({
    appliesEmployerSubsidiaryId: "",
    appliesDepartmentId: "",
    appliesEmploymentIds: [EMPLOYMENT_A, EMPLOYMENT_B, EMPLOYMENT_A],
    appliesClassificationIds: [],
    accrualKind: "per_year",
    accrualHours: "120",
    effectiveFrom: "2026-01-01",
  });
  assert.deepEqual(folded.appliesTo, {
    employer_subsidiary_id: null,
    department_id: null,
    employment_ids: [EMPLOYMENT_A, EMPLOYMENT_B],
    classification_ids: null,
  });
  // The slot keys never reach the column writer.
  assert.equal("appliesEmploymentIds" in folded, false);
  assert.equal("appliesClassificationIds" in folded, false);
  assert.equal("accrualTiers" in folded, false);
});

test("the tier table folds into accrual_rule.tiers", () => {
  const folded = drawerFolded({
    accrualKind: "per_year",
    accrualHours: "80",
    accrualTiers: [
      { after_years: 5, hours: "120" },
      { after_years: 10, hours: "160" },
    ],
    effectiveFrom: "2026-01-01",
  });
  assert.deepEqual(folded.accrualRule, {
    kind: "per_year",
    hours: "80",
    tiers: [
      { after_years: 5, hours: "120" },
      { after_years: 10, hours: "160" },
    ],
  });
});

test("a tiers-only drawer body still folds the complete accrual rule", () => {
  const folded = drawerFolded({
    accrualKind: "per_year",
    accrualHours: "80",
    accrualPeriodsPerYear: "",
    accrualTiers: [{ after_years: 3, hours: "100" }],
  });
  assert.deepEqual((folded.accrualRule as Record<string, unknown>).tiers, [
    { after_years: 3, hours: "100" },
  ]);
});

test("malformed employment ids refuse with the field named", () => {
  assert.match(
    drawerRefusal({ appliesEmploymentIds: ["not-a-uuid"] }),
    /applies-to employments must be ids/,
  );
  assert.match(
    drawerRefusal({
      appliesTo: { employer_subsidiary_id: null, department_id: null, employment_ids: [] },
    }),
    /non-empty list/,
  );
});

test("descending, zero-based, and zero-hour tiers refuse", () => {
  const tiers = (rows: unknown) => ({
    accrualKind: "per_year",
    accrualHours: "80",
    accrualTiers: rows,
  });
  assert.match(
    drawerRefusal(
      tiers([
        { after_years: 5, hours: "120" },
        { after_years: 3, hours: "100" },
      ]),
    ),
    /ascends strictly/,
  );
  assert.match(drawerRefusal(tiers([{ after_years: 0, hours: "120" }])), /positive whole number/);
  assert.match(drawerRefusal(tiers([{ after_years: 5, hours: "0" }])), /greater than zero/);
  assert.match(
    drawerRefusal({ accrualKind: "none", accrualTiers: [{ after_years: 5, hours: "120" }] }),
    /nothing to lift/,
  );
});

test("stored targeting and tiers prefill the drawer slots on edit", () => {
  const projected = projectRuleSlotPrefills("leave-policies", {
    id: "00000000-0000-4000-8000-000000000042",
    applies_to: {
      employer_subsidiary_id: null,
      department_id: null,
      employment_ids: [EMPLOYMENT_A],
      classification_ids: [CLASSIFICATION],
    },
    accrual_rule: { kind: "per_year", hours: "80", tiers: [{ after_years: 5, hours: "120" }] },
  });
  assert.deepEqual(projected.applies_employment_ids, [EMPLOYMENT_A]);
  assert.deepEqual(projected.applies_classification_ids, [CLASSIFICATION]);
  assert.deepEqual(projected.accrual_tiers, [{ after_years: 5, hours: "120" }]);
  // Policies without targeting prefill empty pickers, never stale rows.
  const bare = projectRuleSlotPrefills("leave-policies", {
    id: "00000000-0000-4000-8000-000000000043",
    applies_to: { employer_subsidiary_id: null, department_id: null },
    accrual_rule: { kind: "per_year", hours: "80" },
  });
  assert.equal(bare.applies_employment_ids, undefined);
  assert.equal(bare.accrual_tiers, undefined);
});
