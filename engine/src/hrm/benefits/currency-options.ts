import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../platform/db.ts';
import { orgFeatureEnabled } from '../../organization/org-feature-lock.ts';
import { actorAllowedSubsidiaryIds } from '../../organization/actor-subsidiaries.ts';
import { requireAggregateBenefitsRead } from '../authorization.ts';
import { BenefitsError } from './errors.ts';

export type BenefitCurrencyOption = {
  value: string;
  label: string;
  /** Null applies to every entity; otherwise this is the owning entity. */
  scopeValue: string | null;
};

/** Uses the authoritative currency registry and Company Features policy. */
export async function benefitCurrencyOptions(exec: SqlExecutor, orgId: string, actorId: string): Promise<BenefitCurrencyOption[]> {
  await requireAggregateBenefitsRead(exec, orgId, actorId);
  const multi = await orgFeatureEnabled(orgId, 'multiCurrency', exec);
  if (multi) return (await exec.execute<BenefitCurrencyOption>(sql`
    select code as value, code || ' · ' || name as label, null::text as "scopeValue" from currencies order by code
  `)).rows;
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  const rows = (await exec.execute<BenefitCurrencyOption>(sql`
    select c.code as value, c.code || ' · ' || c.name as label, '' as "scopeValue"
      from orgs o join currencies c on c.code = o.base_currency where o.id = ${orgId}
    union all
    select c.code as value, c.code || ' · ' || c.name as label, s.id::text as "scopeValue"
      from subsidiaries s join currencies c on c.code = s.base_currency where s.org_id = ${orgId} and s.is_active
    order by value, "scopeValue"
  `)).rows;
  return rows.filter((row) => row.scopeValue === '' ? allowed === null : allowed === null || allowed.has(row.scopeValue!));
}

/** Currency policy is enforced on writes as well as in the picker. */
export async function requireBenefitCurrency(exec: SqlExecutor, orgId: string, currency: string, legalEntityId: string | null): Promise<void> {
  const multi = await orgFeatureEnabled(orgId, 'multiCurrency', exec);
  const eligible = (await exec.execute(sql`
    select c.code from currencies c where c.code = ${currency} and (
      ${multi} or (${legalEntityId}::uuid is null and exists(select 1 from orgs where id = ${orgId} and base_currency = c.code))
      or exists(select 1 from subsidiaries where org_id = ${orgId} and id = ${legalEntityId}::uuid and is_active and base_currency = c.code)
    )
  `)).rows;
  if (eligible.length !== 1) {
    throw new BenefitsError('REFUSED', `Currency ${currency} is not available for this employer — choose its enabled currency in Benefits. Foreign currencies require Company Settings → Features → Multi-currency.`);
  }
}
