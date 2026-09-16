import type {
  ReportCustomQuery,
  ReportEntity,
  ReportRule,
  ReportRuleGroup,
} from "@openbooks/reports";

/**
 * Period-window binding for allocation report drivers (finding 6.2).
 *
 * Mirrors the viewer semantics in web/lib/custom-reports.ts
 * (`reportPeriodField` / `applyPeriodOverride`) so a driver in
 * `period_activity` mode imposes the requested window through the same rule
 * the report screen's period picker uses. Kept engine-local (rather than
 * importing the web helpers or new package exports) because worktrees
 * resolve `@openbooks/reports` to main and cannot consume new package
 * exports before they land; unify behind the package helpers once they do.
 */

/** Ops whose meaning is "a time window on this field". */
const TEMPORAL_OPS = new Set([
  "since_today",
  "this_week",
  "this_month",
  "this_year",
  "before_now",
  "period_preset",
  "gte",
  "lte",
  "between",
]);

/**
 * The date field a driver window binds on an already-resolved entity: the
 * first filter leaf with a temporal op on a date-kind column, else the
 * entity-authored default, else the first date-kind column, else null (the
 * caller must refuse: no honest activity window exists).
 */
export function resolveReportPeriodField(
  entity: ReportEntity,
  plan: ReportCustomQuery,
): string | null {
  const dateColumns = new Set(
    entity.columns.filter((c) => c.kind === "date").map((c) => c.key),
  );
  let found: string | null = null;
  const walk = (node: ReportRuleGroup | undefined): void => {
    for (const r of node?.rules ?? []) {
      if (found) return;
      if (r && typeof r === "object" && Array.isArray((r as ReportRuleGroup).rules)) {
        walk(r as ReportRuleGroup);
      } else {
        const leaf = r as ReportRule;
        if (dateColumns.has(leaf.field) && TEMPORAL_OPS.has(leaf.op)) found = leaf.field;
      }
    }
  };
  walk(plan.filters ?? undefined);
  if (found) return found;
  if (entity.defaultPeriodField === null) return null;
  if (entity.defaultPeriodField !== undefined) {
    return dateColumns.has(entity.defaultPeriodField) ? entity.defaultPeriodField : null;
  }
  return entity.columns.find((c) => c.kind === "date")?.key ?? null;
}

/**
 * Replace the plan's time window on `field` with explicit [from, to]
 * bounds — the requested period wins over the stored preset, nothing else
 * changes.
 */
export function applyReportPeriodWindow(
  plan: ReportCustomQuery,
  field: string,
  bounds: { from: string; to: string },
): ReportCustomQuery {
  const strip = (node: ReportRuleGroup): ReportRuleGroup => ({
    ...node,
    rules: (node.rules ?? [])
      .map((r) => {
        if (r && typeof r === "object" && Array.isArray((r as ReportRuleGroup).rules)) {
          return strip(r as ReportRuleGroup);
        }
        const leaf = r as ReportRule;
        return leaf.field === field && TEMPORAL_OPS.has(leaf.op) ? null : leaf;
      })
      .filter((r): r is ReportRule | ReportRuleGroup => r !== null),
  });
  const base = plan.filters ? strip(plan.filters) : { combinator: "and" as const, rules: [] };
  return {
    ...plan,
    filters: {
      combinator: "and",
      rules: [
        ...(base.rules.length ? [base] : []),
        { field, op: "gte", value: bounds.from },
        { field, op: "lte", value: bounds.to },
      ],
    },
  };
}
