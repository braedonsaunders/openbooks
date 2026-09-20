import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";

/**
 * Canonical labor_cost_rates writer (extracted from the Labor Costing
 * setup route, HR-12): the ONE home for a wage.
 *
 * payroll/rate.ts and payroll/retro.ts both depend on this table's version
 * history — the setup route used to write it inline, and the compensation
 * push needs the same write. A second inline writer is not acceptable, so
 * both call this service: close the previous open row in the same scope
 * the day before the new start, then upsert (same scope + same start = a
 * correction in place that keeps the row's window), plus the audit_log row
 * carrying actor, reason, and exact before/after state.
 *
 * MUST run inside the caller's withOrgTransaction(orgId): the same-scope
 * advisory lock is taken BEFORE any read, so concurrent starts in one
 * scope serialize into one ordered timeline, and close + upsert + audit
 * commit as one unit. Throws raw storage errors (the overlap exclusion
 * surfaces as code 23P01); the caller maps them, never leaks driver text.
 */

export interface LaborCostRateScope {
  readonly employeePartyId: string | null;
  readonly jobTitle: string | null;
  readonly tradeId: string | null;
  readonly departmentId: string | null;
  readonly subsidiaryId: string | null;
}

/** Exact serialized state of one labor_cost_rates row — the audit unit. */
export type LaborCostRateRow = {
  id: string;
  rate: string;
  currency: string;
  basis: string;
  annualHours: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  isActive: boolean;
}

export const LABOR_COST_RATE_ROW_COLUMNS = sql`id, rate::text as rate, currency, basis,
       annual_hours::text as "annualHours", effective_from::text as "effectiveFrom",
       effective_to::text as "effectiveTo", notes, is_active as "isActive"`;

/**
 * Same-scope advisory lock, taken BEFORE any read/close in the wage
 * timeline. Keyed on the hash of (org, scope tuple) — exactly the scope
 * the close and exclusion constraint arbitrate — so concurrent starts in
 * one scope form one ordered timeline. A hash collision merely serializes
 * two unrelated scopes; it can never under-serialize.
 */
export function laborCostRateScopeLock(orgId: string, scope: LaborCostRateScope): SQL {
  return sql`select pg_advisory_xact_lock(hashtextextended(
      ${orgId} || ':labor_cost_rates:' ||
      coalesce(${scope.employeePartyId}::text, '~') || '|' ||
      coalesce(lower(${scope.jobTitle}::text), '~') || '|' ||
      coalesce(${scope.tradeId}::text, '~') || '|' ||
      coalesce(${scope.departmentId}::text, '~') || '|' ||
      coalesce(${scope.subsidiaryId}::text, '~'), 0))`;
}

export interface SupersedeLaborCostRateQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly scope: LaborCostRateScope;
  /** First day the new rate governs (YYYY-MM-DD, finite civil date). */
  readonly effectiveFrom: string;
  /** Normalized numeric(19,4) decimal string, >= 0. */
  readonly rate: string;
  readonly currency: string;
  readonly basis: "hour" | "year";
  /** Normalized numeric(19,4) decimal string, > 0. */
  readonly annualHours: string;
  readonly notes: string | null;
  /** Attributable reason carried on the audit row (caller supplies the default). */
  readonly reason: string;
}

export interface SupersedeLaborCostRateResult {
  readonly rateId: string;
  /** True when a same-start row was corrected in place (window kept). */
  readonly corrected: boolean;
  readonly before: readonly LaborCostRateRow[];
  readonly after: LaborCostRateRow;
}

const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message: string): never {
  throw new Error(`supersedeLaborCostRate refused: ${message}`);
}

/**
 * Close + upsert + audit in the caller's transaction. Exactly one scope
 * member must be set (the labor_cost_rates_one_scope storage rule); a
 * backdated start is capped the day before its successor so history stays
 * gapless and ordered without tripping the overlap exclusion.
 */
export async function supersedeLaborCostRate(
  query: SupersedeLaborCostRateQuery,
): Promise<SupersedeLaborCostRateResult> {
  const { orgId, actorId, scope, effectiveFrom } = query;
  if (!orgId) fail("orgId required");
  if (!actorId) fail("actorId required");
  if (!CIVIL_DATE_RE.test(effectiveFrom)) fail("effectiveFrom (YYYY-MM-DD) required");
  const scopeMembers = [
    scope.employeePartyId,
    scope.jobTitle,
    scope.tradeId,
    scope.departmentId,
    scope.subsidiaryId,
  ].filter((v) => v !== null && v !== undefined && String(v).length > 0);
  if (scopeMembers.length !== 1) fail("exactly one wage scope member must be set");
  if (query.basis !== "hour" && query.basis !== "year") fail("basis must be hour or year");

  // Deterministic same-scope serialization BEFORE any read: a concurrent
  // start blocks here until this scope's writer commits, so two starts
  // can neither race the close nor double-book the timeline.
  await db.execute(laborCostRateScopeLock(orgId, scope));

  // Exact before-state: every active row this save will close or correct.
  const before = await db.execute<LaborCostRateRow>(sql`
    select ${LABOR_COST_RATE_ROW_COLUMNS}
      from labor_cost_rates
     where org_id = ${orgId}
       and employee_party_id is not distinct from ${scope.employeePartyId}
       and lower(job_title) is not distinct from lower(${scope.jobTitle})
       and trade_id is not distinct from ${scope.tradeId}
       and department_id is not distinct from ${scope.departmentId}
       and subsidiary_id is not distinct from ${scope.subsidiaryId}
       and is_active
       and (effective_from = ${effectiveFrom}::date
            or (effective_from < ${effectiveFrom}::date
                and (effective_to is null or effective_to >= ${effectiveFrom}::date)))
     order by effective_from`);

  // Close the previous open row in this scope the day before the new
  // start, then upsert (same scope + same start = correction in place).
  await db.execute(sql`
    update labor_cost_rates set effective_to = (${effectiveFrom}::date - 1), updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId}
       and employee_party_id is not distinct from ${scope.employeePartyId}
       and lower(job_title) is not distinct from lower(${scope.jobTitle})
       and trade_id is not distinct from ${scope.tradeId}
       and department_id is not distinct from ${scope.departmentId}
       and subsidiary_id is not distinct from ${scope.subsidiaryId}
       and effective_from < ${effectiveFrom}::date
       and (effective_to is null or effective_to >= ${effectiveFrom}::date)`);
  // A mid-timeline start (a backdate) must end the day before its
  // successor: without the cap the new row overlaps the next start and
  // the overlap exclusion refuses the save. Forward starts have no
  // successor, so the cap stays open.
  const successor = await db.execute<{ start: string }>(sql`
    select min(effective_from)::text as start
      from labor_cost_rates
     where org_id = ${orgId}
       and employee_party_id is not distinct from ${scope.employeePartyId}
       and lower(job_title) is not distinct from lower(${scope.jobTitle})
       and trade_id is not distinct from ${scope.tradeId}
       and department_id is not distinct from ${scope.departmentId}
       and subsidiary_id is not distinct from ${scope.subsidiaryId}
       and is_active
       and effective_from > ${effectiveFrom}::date`);
  const successorFrom = successor.rows[0]?.start ?? null;
  const upserted = await db.execute<LaborCostRateRow>(sql`
    insert into labor_cost_rates
      (org_id, employee_party_id, job_title, trade_id, department_id, subsidiary_id, currency,
       rate, basis, annual_hours, effective_from, effective_to, notes, created_by, updated_by)
    values (${orgId}, ${scope.employeePartyId}, ${scope.jobTitle}, ${scope.tradeId}, ${scope.departmentId}, ${scope.subsidiaryId}, ${query.currency},
            ${query.rate}, ${query.basis}, ${query.annualHours}, ${effectiveFrom},
            (case when ${successorFrom}::date is null then null else (${successorFrom}::date - 1) end),
            ${query.notes}, ${actorId}, ${actorId})
    on conflict (org_id,
                 coalesce(employee_party_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 coalesce(lower(job_title), ''),
                 coalesce(trade_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 effective_from)
    -- A same-start correction replaces terms in place and keeps the
    -- row's window: resetting effective_to here would reopen the row
    -- past its successor and trip the overlap exclusion.
    do update set rate = excluded.rate, currency = excluded.currency, basis = excluded.basis, annual_hours = excluded.annual_hours,
                  notes = excluded.notes, is_active = true,
                  updated_at = now(), updated_by = ${actorId}
              where labor_cost_rates.org_id = ${orgId}
    returning ${LABOR_COST_RATE_ROW_COLUMNS}`);
  const after = upserted.rows[0];
  if (!after) fail("the wage upsert matched no row — the save is refused, never a silent success");
  const corrected = before.rows.some((row: LaborCostRateRow) => row.effectiveFrom === effectiveFrom);

  // Attributable evidence commits with the data it describes: the
  // authenticated actor, the change reason, and the exact before/after
  // row state — one transaction, so a failure anywhere leaves neither a
  // gap nor an orphan audit.
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'labor_cost_rates', ${after.id},
            ${corrected ? "update" : "insert"},
            ${JSON.stringify({ reason: query.reason, scope, effectiveFrom, before: before.rows, after })},
            ${actorId})`);
  return { rateId: after.id, corrected, before: before.rows, after };
}
