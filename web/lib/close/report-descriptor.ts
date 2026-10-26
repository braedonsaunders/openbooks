import {
  REPORT_ENTITIES,
  type ReportCustomQuery,
  type ReportRule,
  type ReportRuleGroup,
} from "@openbooks/reports";
import { periodPresetName } from "../period-label-catalog";

/** A plain-language summary of the parameters a report already has baked into
 * its definition — shown next to each attached report so a package author can
 * see what it produces before layering their own overrides on top. */
export type ReportDescriptor = {
  dateRange: string | null;
  breakouts: string[];
  filters: string[];
  measures: string[];
};

function columnLabels(entity: string): Map<string, string> {
  const found = REPORT_ENTITIES.find((candidate) => candidate.key === entity);
  return new Map((found?.columns ?? []).map((column) => [column.key, column.label]));
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value == null) return "";
  return String(value);
}

const OPERATOR_TEXT: Record<string, (value: unknown) => string> = {
  eq: (v) => `= ${formatValue(v)}`,
  neq: (v) => `≠ ${formatValue(v)}`,
  in: (v) => `in ${formatValue(v)}`,
  not_in: (v) => `not in ${formatValue(v)}`,
  gte: (v) => `≥ ${formatValue(v)}`,
  lte: (v) => `≤ ${formatValue(v)}`,
  contains: (v) => `contains ${formatValue(v)}`,
  between_days_ago: (v) => `within ${formatValue(v)} days`,
  due_within_days: (v) => `due within ${formatValue(v)} days`,
  is_true: () => "is yes",
  is_false: () => "is no",
  is_null: () => "is empty",
  is_not_null: () => "is set",
  since_today: () => "since today",
  this_week: () => "this week",
  this_month: () => "this month",
  this_year: () => "this year",
  before_now: () => "before now",
};

function walkFilters(
  group: ReportRuleGroup | null | undefined,
  labels: Map<string, string>,
  out: { filters: string[]; dateRange: string | null },
  locale: string,
): void {
  if (!group) return;
  for (const rule of group.rules) {
    if ("rules" in rule) {
      walkFilters(rule, labels, out, locale);
      continue;
    }
    const leaf = rule as ReportRule;
    if (leaf.op === "period_preset") {
      // The preset's name from the locale catalogs, keyed by its stable id.
      out.dateRange = periodPresetName(String(leaf.value), locale);
      continue;
    }
    const label = labels.get(leaf.field) ?? leaf.field;
    const op = OPERATOR_TEXT[leaf.op];
    out.filters.push(`${label} ${op ? op(leaf.value) : leaf.op}`);
  }
}

export function describeQuery(query: ReportCustomQuery, locale: string): ReportDescriptor {
  const labels = columnLabels(query.entity);
  const acc = { filters: [] as string[], dateRange: null as string | null };
  walkFilters(query.filters, labels, acc, locale);
  const breakouts = (query.breakouts ?? []).map((breakout) => {
    const label = labels.get(breakout.column) ?? breakout.column;
    return breakout.bin ? `${label} (${breakout.bin})` : label;
  });
  const measures = (query.measures ?? []).map(
    (measure) =>
      measure.label ??
      `${measure.fn}${measure.column ? ` of ${labels.get(measure.column) ?? measure.column}` : ""}`,
  );
  return { dateRange: acc.dateRange, breakouts, filters: acc.filters, measures };
}

export function describeStatement(params?: Record<string, string> | null): ReportDescriptor {
  const filters = params ? Object.entries(params).map(([key, value]) => `${key} = ${value}`) : [];
  return { dateRange: null, breakouts: [], filters, measures: [] };
}
