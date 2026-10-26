import assert from "node:assert/strict";
import test from "node:test";
import {
  assignedValue,
  describeViolation,
  ruleEffectiveOn,
  segmentDependencyViolations,
  valueAllowed,
  type SegmentDependencyRule,
} from "./segment-dependency-rules.ts";

const CLASS = {
  id: "seg-class",
  key: "class",
  name: "Class",
  sourceKind: "builtin" as const,
  storageColumn: "class_id",
};
const DEPARTMENT = {
  id: "seg-dept",
  key: "department",
  name: "Department",
  sourceKind: "builtin" as const,
  storageColumn: "department_id",
};
const FUND = {
  id: "seg-fund",
  key: "fund",
  name: "Fund",
  sourceKind: "custom" as const,
  storageColumn: null,
};

function pairing(
  overrides: Partial<SegmentDependencyRule> & Pick<SegmentDependencyRule, "allowedValueId">,
): SegmentDependencyRule {
  return {
    id: `rule-${overrides.allowedValueId}`,
    segment: CLASS,
    valueId: "class-x",
    valueLabel: "X",
    controlling: DEPARTMENT,
    allowedLabel: overrides.allowedValueId.toUpperCase(),
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  };
}

// Class X only with department A or B.
const RULES = [pairing({ allowedValueId: "dept-a" }), pairing({ allowedValueId: "dept-b" })];

test("a line with the dependent value needs one of the allowed controlling values", () => {
  assert.deepEqual(
    segmentDependencyViolations(
      RULES,
      { classId: "class-x", departmentId: "dept-a" },
      "2026-07-15",
    ),
    [],
  );
  assert.deepEqual(
    segmentDependencyViolations(
      RULES,
      { classId: "class-x", departmentId: "dept-b" },
      "2026-07-15",
    ),
    [],
  );
  const wrong = segmentDependencyViolations(
    RULES,
    { classId: "class-x", departmentId: "dept-c" },
    "2026-07-15",
  );
  assert.equal(wrong.length, 1);
  assert.deepEqual(wrong[0]!.allowedLabels, ["DEPT-A", "DEPT-B"]);
  assert.equal(wrong[0]!.controllingValueId, "dept-c");
  const missing = segmentDependencyViolations(RULES, { classId: "class-x" }, "2026-07-15");
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.controllingValueId, null);
});

test("values without rules stay unrestricted", () => {
  assert.deepEqual(
    segmentDependencyViolations(
      RULES,
      { classId: "class-y", departmentId: "dept-c" },
      "2026-07-15",
    ),
    [],
  );
  assert.deepEqual(
    segmentDependencyViolations(RULES, { departmentId: "dept-c" }, "2026-07-15"),
    [],
  );
});

test("effective windows bound each pairing and the allowed set is the union of effective pairings", () => {
  const dated = [
    pairing({ allowedValueId: "dept-a", effectiveTo: "2026-06-30" }),
    pairing({ allowedValueId: "dept-b", effectiveFrom: "2026-07-01" }),
  ];
  assert.equal(ruleEffectiveOn(dated[0]!, "2026-06-30"), true);
  assert.equal(ruleEffectiveOn(dated[0]!, "2026-07-01"), false);
  assert.deepEqual(
    segmentDependencyViolations(
      dated,
      { classId: "class-x", departmentId: "dept-a" },
      "2026-06-15",
    ),
    [],
  );
  assert.equal(
    segmentDependencyViolations(dated, { classId: "class-x", departmentId: "dept-a" }, "2026-07-15")
      .length,
    1,
  );
  assert.deepEqual(
    segmentDependencyViolations(
      dated,
      { classId: "class-x", departmentId: "dept-b" },
      "2026-07-15",
    ),
    [],
  );
  // Before any pairing applies the value is unrestricted.
  const future = [pairing({ allowedValueId: "dept-a", effectiveFrom: "2027-01-01" })];
  assert.deepEqual(
    segmentDependencyViolations(
      future,
      { classId: "class-x", departmentId: "dept-c" },
      "2026-07-15",
    ),
    [],
  );
});

test("custom segments read extra dimensions; explicit blanks count as no value", () => {
  assert.equal(assignedValue(FUND, { extraDims: { fund: "fund-1" } }), "fund-1");
  assert.equal(assignedValue(FUND, { extraDims: { fund: null } }), null);
  assert.equal(assignedValue(FUND, { extraDims: { fund: "" } }), null);
  assert.equal(assignedValue(DEPARTMENT, { departmentId: "" }), null);
  const fundRules = [pairing({ segment: FUND, valueId: "fund-1", allowedValueId: "dept-a" })];
  assert.deepEqual(
    segmentDependencyViolations(
      fundRules,
      { extraDims: { fund: "fund-1" }, departmentId: "dept-a" },
      "2026-07-15",
    ),
    [],
  );
  assert.equal(
    segmentDependencyViolations(
      fundRules,
      { extraDims: { fund: "fund-1" }, departmentId: "dept-b" },
      "2026-07-15",
    ).length,
    1,
  );
});

test("rules against different controlling segments are evaluated independently", () => {
  const LOCATION = {
    id: "seg-loc",
    key: "location",
    name: "Location",
    sourceKind: "builtin" as const,
    storageColumn: "location_id",
  };
  const rules = [...RULES, pairing({ controlling: LOCATION, allowedValueId: "loc-1" })];
  const both = segmentDependencyViolations(
    rules,
    { classId: "class-x", departmentId: "dept-c", locationId: "loc-2" },
    "2026-07-15",
  );
  assert.deepEqual(both.map((violation) => violation.controllingName).sort(), [
    "Department",
    "Location",
  ]);
  assert.deepEqual(
    segmentDependencyViolations(
      rules,
      { classId: "class-x", departmentId: "dept-a", locationId: "loc-1" },
      "2026-07-15",
    ),
    [],
  );
});

test("pickers offer only values the line's other values allow", () => {
  assert.equal(
    valueAllowed(RULES, "seg-class", "class-x", { departmentId: "dept-a" }, "2026-07-15"),
    true,
  );
  assert.equal(
    valueAllowed(RULES, "seg-class", "class-x", { departmentId: "dept-c" }, "2026-07-15"),
    false,
  );
  assert.equal(valueAllowed(RULES, "seg-class", "class-x", {}, "2026-07-15"), false);
  assert.equal(
    valueAllowed(RULES, "seg-class", "class-y", { departmentId: "dept-c" }, "2026-07-15"),
    true,
  );
});

test("the refusal names the line, the allowed values and the remedy", () => {
  const [violation] = segmentDependencyViolations(
    RULES,
    { classId: "class-x", departmentId: "dept-c" },
    "2026-07-15",
  );
  const message = describeViolation(violation!, "Line 3");
  assert.match(message, /^Line 3: Class "X" is allowed only with Department DEPT-A or DEPT-B/);
  assert.match(message, /Setup → Segments/);
});
