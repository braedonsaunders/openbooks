import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";

/**
 * Budget cell identity for budgetary control.
 *
 * An approved budget line, an open commitment and a posted actual meet in one
 * budget cell only when their whole dimension identity is equal: account,
 * subsidiary, department, project, location, class, and every custom segment
 * value carried in `extra_dims` (fund included). Matching is exact — a budget
 * written for a fund alone does not cover postings that also carry another
 * custom segment, so the budget worksheet offers every active custom segment
 * as part of its slice.
 *
 * A row that names no fund belongs to the organization's default fund. That
 * is the rule fund balancing applies to postings, and it is applied here to
 * budget lines, commitments and actuals alike, so a budget written before
 * fund accounting was switched on reads as the default fund's appropriation
 * instead of as an appropriation no fund can ever reach. Writers stamp the
 * default fund explicitly, so new rows never depend on this reading.
 */
export const FUND_SEGMENT_KEY = "fund";

/** `column` with the organization's default fund filled in when it names none. */
export function effectiveExtraDimsSql(column: SQL, orgId: string): SQL {
  return sql`(case when ${column} ? 'fund' then ${column}
    else ${column} || coalesce((
      select jsonb_build_object('fund', sd.default_value_id::text)
        from segment_definitions sd
       where sd.org_id = ${orgId} and sd.key = 'fund' and sd.source_kind = 'custom'
         and sd.default_value_id is not null
    ), '{}'::jsonb) end)`;
}

export interface BudgetSegmentOption {
  id: string;
  code: string | null;
  name: string;
}

export interface BudgetSegment {
  key: string;
  name: string;
  defaultValueId: string | null;
  values: BudgetSegmentOption[];
}

/** Active custom segments and their active values, in display order. */
export async function loadBudgetSegments(runner: SqlExecutor, orgId: string): Promise<BudgetSegment[]> {
  const rows = (await runner.execute<{
    key: string; name: string; defaultValueId: string | null;
    valueId: string | null; valueCode: string | null; valueName: string | null;
  }>(sql`
    select sd.key, sd.name, sd.default_value_id as "defaultValueId",
           sv.id as "valueId", sv.code as "valueCode", sv.name as "valueName"
      from segment_definitions sd
      left join segment_values sv
        on sv.org_id = sd.org_id and sv.segment_id = sd.id and sv.is_active
     where sd.org_id = ${orgId} and sd.source_kind = 'custom' and sd.is_active
     order by sd.sort_order, sd.key, sv.code nulls last, sv.name, sv.id
  `)).rows;
  const segments = new Map<string, BudgetSegment>();
  for (const row of rows) {
    let segment = segments.get(row.key);
    if (!segment) {
      segment = { key: row.key, name: row.name, defaultValueId: row.defaultValueId, values: [] };
      segments.set(row.key, segment);
    }
    if (row.valueId) segment.values.push({ id: row.valueId, code: row.valueCode, name: row.valueName ?? "" });
  }
  return [...segments.values()];
}

/** A custom segment assignment the budget cannot store, named by segment key. */
export class BudgetDimensionError extends Error {
  constructor(readonly segmentKey: string) {
    super(`invalid_dimension: ${segmentKey}`);
    this.name = "BudgetDimensionError";
  }
}

/**
 * Canonical stored custom dimensions for a budget cell: every key must be an
 * active custom segment and every value one of its active values; an empty
 * value means the segment is not set. When the organization has a default
 * fund and the cell names no fund, the default fund is written explicitly.
 */
export function resolveBudgetExtraDims(
  segments: readonly BudgetSegment[],
  raw: unknown,
): Record<string, string> {
  if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new BudgetDimensionError("extraDims");
  }
  const byKey = new Map(segments.map((segment) => [segment.key, segment]));
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (value === null || value === undefined || value === "") continue;
    const segment = byKey.get(key);
    if (!segment || typeof value !== "string" || !isUuid(value) || !segment.values.some((option) => option.id === value)) {
      throw new BudgetDimensionError(key);
    }
    resolved[key] = value;
  }
  const fund = byKey.get(FUND_SEGMENT_KEY);
  if (fund?.defaultValueId && !resolved[FUND_SEGMENT_KEY]) resolved[FUND_SEGMENT_KEY] = fund.defaultValueId;
  return Object.fromEntries(Object.entries(resolved).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
