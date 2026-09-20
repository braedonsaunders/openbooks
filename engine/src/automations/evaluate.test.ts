import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAutomation,
  evaluateConditionNode,
  matchAutomationRules,
  ConditionRefusal,
} from "./evaluate.ts";
import { parseAutomationRules, type ConditionNode } from "./triggers.ts";

const snapshot = {
  entity: "leave_request",
  fields: { status: "submitted", days: 3, leave_type_id: "annual", notes: "hi there", tags: ["a", "b"] },
  previous: null,
  scope: { departmentId: "dept-1", subsidiaryId: "sub-1" },
};

test("eq/neq match literal values", () => {
  assert.equal(evaluateConditionNode({ field: "status", op: "eq", value: "submitted" }, snapshot), true);
  assert.equal(evaluateConditionNode({ field: "status", op: "eq", value: "approved" }, snapshot), false);
  assert.equal(evaluateConditionNode({ field: "status", op: "neq", value: "approved" }, snapshot), true);
});

test("comparison ops over numbers", () => {
  assert.equal(evaluateConditionNode({ field: "days", op: "gt", value: 2 }, snapshot), true);
  assert.equal(evaluateConditionNode({ field: "days", op: "gte", value: 3 }, snapshot), true);
  assert.equal(evaluateConditionNode({ field: "days", op: "lt", value: 4 }, snapshot), true);
  assert.equal(evaluateConditionNode({ field: "days", op: "lte", value: 2 }, snapshot), false);
});

test("in/contains/is_null", () => {
  assert.equal(evaluateConditionNode({ field: "status", op: "in", value: ["submitted", "draft"] }, snapshot), true);
  assert.equal(evaluateConditionNode({ field: "notes", op: "contains", value: "there" }, snapshot), true);
  assert.equal(evaluateConditionNode({ field: "tags", op: "contains", value: "b" }, snapshot), true);
  assert.equal(evaluateConditionNode({ field: "absent", op: "is_null", value: null }, { ...snapshot, fields: { absent: undefined } }), true);
  assert.equal(evaluateConditionNode({ field: "status", op: "is_null", value: null }, snapshot), false);
});

test("all/any trees nest", () => {
  const node: ConditionNode = {
    all: [
      { field: "status", op: "eq", value: "submitted" },
      { any: [{ field: "days", op: "gt", value: 10 }, { field: "days", op: "lt", value: 5 }] },
    ],
  };
  assert.equal(evaluateConditionNode(node, snapshot), true);
  const no: ConditionNode = { all: [{ field: "status", op: "eq", value: "submitted" }, { field: "days", op: "gt", value: 10 }] };
  assert.equal(evaluateConditionNode(no, snapshot), false);
});

test("changed_to needs a previous image and a real change", () => {
  assert.throws(
    () => evaluateConditionNode({ field: "status", op: "changed_to", value: "submitted" }, snapshot),
    (e: unknown) => e instanceof ConditionRefusal && /outside a field-change trigger/.test((e as Error).message),
  );
  const changed = { ...snapshot, previous: { status: "draft" } };
  assert.equal(evaluateConditionNode({ field: "status", op: "changed_to", value: "submitted" }, changed), true);
  const unchanged = { ...snapshot, previous: { status: "submitted" } };
  assert.equal(evaluateConditionNode({ field: "status", op: "changed_to", value: "submitted" }, unchanged), false);
});

test("unknown op refuses, never false", () => {
  assert.throws(
    // @ts-expect-error hostile input: unknown op must refuse
    () => evaluateConditionNode({ field: "status", op: "matches", value: "x" }, snapshot),
    (e: unknown) => e instanceof ConditionRefusal && /unknown condition op 'matches'/.test((e as Error).message),
  );
});

test("unknown field refuses with the registry remedy", () => {
  assert.throws(
    () => evaluateConditionNode({ field: "salary", op: "eq", value: 1 }, snapshot),
    (e: unknown) => e instanceof ConditionRefusal && /not present on entity 'leave_request'/.test((e as Error).message),
  );
});

test("in with non-array refuses", () => {
  assert.throws(
    () => evaluateConditionNode({ field: "status", op: "in", value: "submitted" }, snapshot),
    (e: unknown) => e instanceof ConditionRefusal && /non-array/.test((e as Error).message),
  );
});

test("rules scope who: stated filters must match", () => {
  const dept = "11111111-1111-4111-8111-111111111111";
  const rules = parseAutomationRules({ departmentId: dept, attributes: [{ key: "tier", op: "eq", value: "gold" }] });
  assert.equal(matchAutomationRules(rules, { ...snapshot, scope: { departmentId: dept, tier: "gold" } }), true);
  assert.equal(matchAutomationRules(rules, snapshot), false);
  assert.equal(matchAutomationRules(parseAutomationRules({}), snapshot), true);
});

test("full gate: rules first, then conditions", () => {
  const rules = parseAutomationRules({});
  assert.equal(
    evaluateAutomation(rules, { root: { field: "days", op: "lte", value: 5 } }, snapshot),
    "match",
  );
  assert.equal(
    evaluateAutomation(rules, { root: { field: "days", op: "gt", value: 5 } }, snapshot),
    "no_match",
  );
  assert.equal(evaluateAutomation(rules, {}, snapshot), "match");
  const scoped = parseAutomationRules({ departmentId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(
    evaluateAutomation(scoped, { root: { field: "days", op: "lte", value: 5 } }, snapshot),
    "no_match",
  );
});
