import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHrmCompensationInput } from "./hrm-compensation.ts";
import { applyRuleSlotColumns } from "./hrm-rule-slots.ts";
import { buildRow } from "./coerce.ts";
import { JOB_LEVELS_ENTITY } from "./hrm-compensation.ts";

describe("normalizeHrmCompensationInput", () => {
  test("other entities pass through untouched", () => {
    const body = { code: "ENG" };
    assert.equal(normalizeHrmCompensationInput("hrm-job-families", body), body);
  });

  test("weight slots fold into equal_value_criteria", () => {
    assert.deepEqual(
      normalizeHrmCompensationInput("hrm-job-levels", {
        code: "IC3",
        skillsWeight: "3",
        responsibilityWeight: "2.5",
        workingConditionsWeight: "1.5",
      }),
      {
        code: "IC3",
        equalValueCriteria: [
          { criterion: "skills", weight: "3" },
          { criterion: "responsibility", weight: "2.5" },
          { criterion: "working_conditions", weight: "1.5" },
        ],
      },
    );
    const normalized = normalizeHrmCompensationInput('hrm-job-levels', { code: 'IC3', name: 'Level three', rank: '3', skillsWeight: '3', workingConditionsWeight: '1.5' });
    const built = buildRow(JOB_LEVELS_ENTITY, normalized, { forCreate: true, coverFoldedSlots: true });
    assert.ok(!('error' in built));
    const persisted = applyRuleSlotColumns('hrm-job-levels', normalized, built.cols);
    assert.ok(!('error' in persisted));
    assert.deepEqual(persisted.cols.find((col) => col.column === 'equal_value_criteria')?.value, normalized.equalValueCriteria);
    assert.ok(persisted.cols.every((col) => !col.column.endsWith('_weight')));
  });

  test("empty slots preserve an undeclared assessment basis", () => {
    assert.deepEqual(normalizeHrmCompensationInput("hrm-job-levels", { code: "IC3", skillsWeight: "" }), {
      code: "IC3",
      equalValueCriteria: [],
    });
  });

  test("no slots leaves the body alone", () => {
    const body = { code: "IC3", name: "Three" };
    assert.equal(normalizeHrmCompensationInput("hrm-job-levels", body), body);
  });
});
