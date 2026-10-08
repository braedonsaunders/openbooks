import { sql } from 'drizzle-orm';
import { db } from '../../platform/db.ts';
import { orgFeatureEnabled } from '../../organization/org-feature-lock.ts';
import { CompensationError } from './errors.ts';
import { businessToday } from '../../platform/business-date.ts';
import { requireAggregateCompensationRead } from '../authorization.ts';
import { requireActorId, requireCivilDate, requireOrgId } from '../recruiting/input.ts';
import type { PayRateBasis } from '../../projects/pay-rate-basis.ts';

export interface CompensationWageSummary {
  asOf: string;
  workers: number;
  covered: number;
  missing: number;
  ambiguous: number;
  groups: { currency: string; basis: PayRateBasis; workers: number; average: string; min: string; max: string }[];
}

export interface CompensationArchitectureSummary {
  families: number;
  levels: number;
  bands: number;
  bandVersions: number;
}

/** Architecture totals share one live permission and employer-scope read. */
export async function compensationArchitectureSummary(query: {
  orgId: string;
  actorId: string;
  asOf: string;
}): Promise<CompensationArchitectureSummary> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const asOf = requireCivilDate(query.asOf, 'asOf');
  const allowed = await requireAggregateCompensationRead(db, orgId, actorId);
  if (!await orgFeatureEnabled(orgId, 'hrmCompensation', db)) throw new CompensationError('REFUSED', 'Enable Compensation in Company Settings → Features to read compensation summaries');
  const result = await db.execute<CompensationArchitectureSummary>(sql`
    with visible_bands as materialized (
      select effective_from, effective_to from hrm_pay_bands
       where org_id = ${orgId}
         and (${allowed === null} or employer_subsidiary_id is null
           or employer_subsidiary_id = any(${`{${[...(allowed ?? [])].join(',')}}`}::uuid[]))
    )
    select
      (select count(*)::int from hrm_job_families where org_id = ${orgId} and is_active) as families,
      (select count(*)::int from hrm_job_levels where org_id = ${orgId} and is_active) as levels,
      (select count(*)::int from visible_bands where effective_from <= ${asOf}::date
        and (effective_to is null or effective_to >= ${asOf}::date)) as bands,
      (select count(*)::int from visible_bands) as "bandVersions"
  `);
  if (!result.rows[0]) throw new Error('Compensation architecture totals could not be read');
  return result.rows[0];
}

/**
 * Actual employee wages, with no annualization, FX conversion or policy-rate
 * substitution: each group averages wages quoted in one currency and one
 * cadence (hour, week, two weeks, half-month, month or year).
 */
export async function compensationWageSummary(query: { orgId: string; actorId: string }): Promise<CompensationWageSummary> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const allowed = await requireAggregateCompensationRead(db, orgId, actorId);
  if (!await orgFeatureEnabled(orgId, 'hrmCompensation', db)) throw new CompensationError('REFUSED', 'Enable Compensation in Company Settings → Features to read compensation summaries');
  const asOf = await businessToday(orgId);
  const workers = sql`select distinct e.worker_party_id
    from worker_employments e
    join worker_employment_versions v on v.org_id = e.org_id and v.employment_id = e.id
      and v.recorded_until is null and v.status in ('active', 'on_leave')
      and v.effective_from <= ${asOf}::date and (v.effective_to is null or v.effective_to >= ${asOf}::date)
    where e.org_id = ${orgId} and (${allowed === null}
      or e.employer_subsidiary_id = any(${`{${[...(allowed ?? [])].join(',')}}`}::uuid[]))`;
  const wages = sql`with workers as (${workers}), wages as (
    select w.worker_party_id, count(r.id)::int as matches, min(r.rate) as rate,
      min(r.currency) as currency, min(r.basis) as basis
    from workers w left join labor_cost_rates r on r.org_id = ${orgId}
      and r.employee_party_id = w.worker_party_id and r.is_active
      and r.effective_from <= ${asOf}::date and (r.effective_to is null or r.effective_to >= ${asOf}::date)
    group by w.worker_party_id
  )`;
  const [counts, groups] = await Promise.all([
    db.execute<{ workers: number; covered: number; missing: number; ambiguous: number }>(sql`${wages}
      select count(*)::int as workers, count(*) filter (where matches = 1)::int as covered,
        count(*) filter (where matches = 0)::int as missing,
        count(*) filter (where matches > 1)::int as ambiguous from wages`),
    db.execute<{ currency: string; basis: PayRateBasis; workers: number; average: string; min: string; max: string }>(sql`${wages}
      select currency, basis, count(*)::int as workers, round(avg(rate), 4)::text as average,
        min(rate)::text as min, max(rate)::text as max
      from wages where matches = 1 group by currency, basis order by currency, basis`),
  ]);
  if (!counts.rows[0]) throw new Error('Compensation wage coverage could not be read');
  return { asOf, ...counts.rows[0], groups: groups.rows };
}
