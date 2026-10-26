// Filter → SQL compilation for custom reports. The report studio stores one
// canonical nested and/or rule tree and compiles it for a plain pg client.
//
// Identifiers are never interpolated from user input: column keys must
// resolve through the entity catalog, and values always bind as numbered
// parameters collected by SqlParams.

import { columnRef, type ReportEntity } from "./entities";
import { addDays, utcCivilDate } from "./fiscal-calendar";
import type { ReportCustomQuery, ReportRule, ReportRuleGroup } from "./types";

const MAX_TREE_DEPTH = 5;
const MAX_TREE_RULES = 60;

/** Ordered bind-parameter sink. `add(v)` returns the `$n` placeholder.
 *  `offset` numbers the first placeholder after params a caller has already
 *  bound (the insights compiler binds its org id first, then reuses this sink
 *  for an entity's baseFilter). */
export class SqlParams {
  readonly values: unknown[] = [];
  constructor(private readonly offset: number = 0) {}
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.offset + this.values.length}`;
  }
}

function isRuleGroup(r: ReportRule | ReportRuleGroup): r is ReportRuleGroup {
  return typeof r === "object" && r !== null && Array.isArray((r as ReportRuleGroup).rules);
}

export interface FilterDateContext {
  asOf?: string;
}

function civilAnchor(opts: FilterDateContext): string {
  const value = opts.asOf;
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (
    !match ||
    Number(match[1]) < 1 ||
    utcCivilDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      .toISOString()
      .slice(0, 10) !== value
  ) {
    throw new Error("Relative report filters require a valid organization civil asOf date");
  }
  return value!;
}

/** Half-open calendar period anchored to the caller's organization date. */
function currentPeriodClause(
  col: string,
  unit: "day" | "week" | "month" | "year",
  params: SqlParams,
  opts: FilterDateContext,
): string {
  const day = params.add(civilAnchor(opts));
  return `(${col} >= date_trunc('${unit}', ${day}::date) AND ${col} < date_trunc('${unit}', ${day}::date) + interval '1 ${unit}')`;
}

/** Compile one leaf clause. Returns null when the clause is invalid or a
 *  no-op (unknown column, missing value). Null is a leaf-level signal only:
 *  compileRuleGroup never drops it (see below), and leaf callers that accept
 *  half-built studio input must throw on null themselves.
 */
export function compileRule(
  entity: ReportEntity,
  rule: { column: string; op: string; value?: unknown },
  params: SqlParams,
  opts: FilterDateContext = {},
): string | null {
  const col = columnRef(entity, rule.column);
  if (!col) return null;
  const v = rule.value;
  switch (rule.op) {
    case "eq":
      if (v === null || typeof v === "undefined" || v === "") return null;
      return `${col} = ${params.add(v)}`;
    case "neq":
      if (v === null || typeof v === "undefined" || v === "") return null;
      return `${col} <> ${params.add(v)}`;
    // Per-element bound params (`IN ($1, $2)`).
    case "in":
      if (Array.isArray(v) && v.length) {
        return `(${col} IN (${v.map((x) => params.add(x)).join(", ")}))`;
      }
      return null;
    case "not_in":
      if (Array.isArray(v) && v.length) {
        return `(${col} NOT IN (${v.map((x) => params.add(x)).join(", ")}))`;
      }
      return null;
    case "gte":
      if (v === null || typeof v === "undefined" || v === "") return null;
      return `${col} >= ${params.add(v)}`;
    case "lte":
      if (v === null || typeof v === "undefined" || v === "") return null;
      return `${col} <= ${params.add(v)}`;
    case "is_null":
      return `${col} IS NULL`;
    case "is_not_null":
      return `${col} IS NOT NULL`;
    case "is_true":
      return `${col} IS TRUE`;
    case "is_false":
      return `${col} IS FALSE`;
    case "contains":
      if (v === null || typeof v === "undefined" || v === "") return null;
      return `${col}::text ILIKE ${params.add("%" + String(v).replace(/[\\%_]/g, (character) => `\\${character}`) + "%")}`;
    case "between_days_ago":
    case "due_within_days": {
      const days = Number(v ?? 30);
      if (!Number.isSafeInteger(days) || days < 0 || days > 3652058) return null;
      const anchor = civilAnchor(opts);
      const date = addDays(anchor, rule.op === "between_days_ago" ? -days : days);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000")) return null;
      return `${col} ${rule.op === "between_days_ago" ? ">=" : "<="} ${params.add(date)}::date`;
    }
    case "since_today":
      return currentPeriodClause(col, "day", params, opts);
    case "this_week":
      return currentPeriodClause(col, "week", params, opts);
    case "this_month":
      return currentPeriodClause(col, "month", params, opts);
    case "this_year":
      return currentPeriodClause(col, "year", params, opts);
    case "before_now":
      return `${col} < ${params.add(civilAnchor(opts))}::date`;
    default:
      return null;
  }
}

/** Nested and/or tree. Throws on absurd trees (depth/size caps) since
 *  those only arise from hand-crafted payloads, not the studio UI.
 *
 *  An uncompilable leg THROWS — it is never silently dropped. Dropping a leg
 *  runs the report unfiltered on that leg (whole-table when every leg drops),
 *  and under `not: true` it inverts the remainder, returning exactly the rows
 *  the operator asked to exclude. Stored plans pass validation first, so a
 *  throw here names a plan the saver should have refused.
 */
export function compileRuleGroup(
  entity: ReportEntity,
  group: ReportRuleGroup,
  params: SqlParams,
  opts: FilterDateContext = {},
): string | null {
  let ruleCount = 0;

  function walk(g: ReportRuleGroup, depth: number): string | null {
    if (depth > MAX_TREE_DEPTH) throw new Error("Filter tree too deep");
    const combinator = g.combinator === "or" ? " OR " : " AND ";
    const parts: string[] = [];
    for (const r of g.rules ?? []) {
      if (++ruleCount > MAX_TREE_RULES) throw new Error("Filter tree too large");
      if (isRuleGroup(r)) {
        const compiled = walk(r, depth + 1);
        if (compiled === null) {
          throw new Error("Filter group contains an empty subgroup that compiles to nothing");
        }
        parts.push(compiled);
        continue;
      }
      const compiled = compileRule(
        entity,
        { column: r.field, op: r.op, value: r.value },
        params,
        opts,
      );
      if (compiled === null) {
        throw new Error(
          `Filter rule for '${r.field}' (${r.op}) cannot be compiled — refusing to run unfiltered`,
        );
      }
      parts.push(compiled);
    }
    if (!parts.length) return null;
    const joined = parts.length === 1 ? parts[0]! : `(${parts.join(combinator)})`;
    return g.not ? `NOT (${joined})` : joined;
  }

  return walk(group, 1);
}

/** Resolve a stored canonical filter tree into one WHERE fragment. */
export function compileCustomFilters(
  entity: ReportEntity,
  plan: Pick<ReportCustomQuery, "filters">,
  params: SqlParams,
  opts: FilterDateContext = {},
): string | null {
  if (plan.filters && Array.isArray(plan.filters.rules) && plan.filters.rules.length) {
    return compileRuleGroup(entity, plan.filters, params, opts);
  }
  return null;
}
