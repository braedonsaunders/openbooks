import { CONDITION_OPS, type AutomationRules, type ConditionNode } from "./triggers.ts";

/**
 * HR-16 condition evaluator — ONE pure function with a fixture matrix.
 *
 * rules → conditions → actions: rules scope WHO the automation applies to
 * (entity scope filters), conditions are the all/any WHEN tree over the
 * subject snapshot, actions run only when both pass. Fail-closed throughout:
 * an unknown op, an unknown field, or an unresolvable value is a REFUSAL
 * (throw), never a silent false — a condition that cannot be evaluated must
 * never quietly match, and must never quietly skip either: the run records
 * the refusal as its error so the inbox shows it.
 */

export class ConditionRefusal extends Error {}

export type SubjectSnapshot = {
  /** Entity kind, e.g. 'employment', 'leave_request', 'timesheet_week'. */
  entity: string;
  /** Current field values by field name. */
  fields: Record<string, unknown>;
  /** Previous field values (for changed_to); absent when not a change. */
  previous?: Record<string, unknown> | null;
  /** Scope attributes for rules matching (subsidiary, department, …). */
  scope?: Record<string, unknown>;
};

function compareValues(op: string, field: string, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "is_null":
      return actual === null || actual === undefined;
    case "in":
      if (!Array.isArray(expected)) {
        throw new ConditionRefusal(
          `condition on '${field}' uses 'in' with a non-array value — fix the automation's when-clause to list the allowed values`,
        );
      }
      return expected.includes(actual);
    case "contains":
      if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
      if (Array.isArray(actual)) return actual.includes(expected);
      throw new ConditionRefusal(
        `condition on '${field}' uses 'contains' over a non-string, non-array value — fix the automation's when-clause`,
      );
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toComparable(actual, field);
      const b = toComparable(expected, field);
      if (a === null || b === null) {
        throw new ConditionRefusal(
          `condition on '${field}' compares values that are not both numbers, dates, or strings — fix the automation's when-clause`,
        );
      }
      const cmp = a < b ? -1 : a > b ? 1 : 0;
      if (op === "gt") return cmp > 0;
      if (op === "gte") return cmp >= 0;
      if (op === "lt") return cmp < 0;
      return cmp <= 0;
    }
    case "changed_to":
      return actual === expected;
    default:
      throw new ConditionRefusal(
        `unknown condition op '${op}' on '${field}' (known ops: ${CONDITION_OPS.join(", ")}) — fix the automation's when-clause`,
      );
  }
}

function toComparable(value: unknown, field: string): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const asDate = Date.parse(value);
    if (!Number.isNaN(asDate) && /^\d{4}-\d{2}-\d{2}/.test(value)) return asDate;
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  throw new ConditionRefusal(
    `condition on '${field}' compares a value of unsupported type — use a number, an ISO date, or a string`,
  );
}

/** Evaluate one node of the all/any tree. Unknown op or field → throw. */
export function evaluateConditionNode(node: ConditionNode, snapshot: SubjectSnapshot): boolean {
  if ("all" in node) return node.all.every((child) => evaluateConditionNode(child, snapshot));
  if ("any" in node) return node.any.some((child) => evaluateConditionNode(child, snapshot));
  const { field, op, value } = node;
  if (!(field in snapshot.fields)) {
    throw new ConditionRefusal(
      `condition field '${field}' is not present on entity '${snapshot.entity}' — fix the automation's when-clause to use a field the ${snapshot.entity} registry declares`,
    );
  }
  const actual = snapshot.fields[field];
  if (op === "changed_to") {
    if (!snapshot.previous || !(field in snapshot.previous)) {
      throw new ConditionRefusal(
        `condition on '${field}' uses 'changed_to' outside a field-change trigger — use 'eq' for state checks, or fire this automation from a field_change trigger`,
      );
    }
    if (snapshot.previous[field] === actual) return false;
  }
  return compareValues(op, field, actual, value);
}

/** Rules scope WHO: every stated filter must match the snapshot scope. */
export function matchAutomationRules(rules: AutomationRules, snapshot: SubjectSnapshot): boolean {
  const scope = snapshot.scope ?? {};
  if (rules.subsidiaryId != null && scope["subsidiaryId"] !== rules.subsidiaryId) return false;
  if (rules.departmentId != null && scope["departmentId"] !== rules.departmentId) return false;
  if (rules.locationId != null && scope["locationId"] !== rules.locationId) return false;
  if (rules.workerType != null && scope["workerType"] !== rules.workerType) return false;
  if (rules.positionId != null && scope["positionId"] !== rules.positionId) return false;
  for (const predicate of rules.attributes) {
    const actual = scope[predicate.key];
    if (predicate.op === "eq" && actual !== predicate.value) return false;
    if (predicate.op === "neq" && actual === predicate.value) return false;
    if (predicate.op === "in") {
      if (!Array.isArray(predicate.value) || !predicate.value.includes(actual)) return false;
    }
  }
  return true;
}

/**
 * Full gate: rules first (no match → skip, not an error), then the
 * conditions tree (refusal → throw, so the run records the error).
 * Returns 'match' | 'no_match'. Throws ConditionRefusal.
 */
export function evaluateAutomation(
  rules: AutomationRules,
  conditions: { root?: ConditionNode | null },
  snapshot: SubjectSnapshot,
): "match" | "no_match" {
  if (!matchAutomationRules(rules, snapshot)) return "no_match";
  if (!conditions.root) return "match";
  return evaluateConditionNode(conditions.root, snapshot) ? "match" : "no_match";
}
