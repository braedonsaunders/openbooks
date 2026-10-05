import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../platform/db.ts';
import { orgFeatureEnabled } from './org-feature-lock.ts';

export type OrganizationCurrencyOption = {
  value: string;
  label: string;
  /** Null is available everywhere; the empty string denotes the organization. */
  scopeValue: string | null;
};

/** Currency registry constrained by Company Features and legal-entity scope.
 * The same policy backs native pickers and mutation validation. */
export async function organizationCurrencyOptions(
  exec: SqlExecutor,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<OrganizationCurrencyOption[]> {
  const multi = await orgFeatureEnabled(orgId, 'multiCurrency', exec);
  if (multi) return (await exec.execute<OrganizationCurrencyOption>(sql`
    select code as value, code || ' · ' || name as label, null::text as "scopeValue"
      from currencies order by code
  `)).rows;
  const rows = (await exec.execute<OrganizationCurrencyOption>(sql`
    select c.code as value, c.code || ' · ' || c.name as label, '' as "scopeValue"
      from orgs o join currencies c on c.code = o.base_currency where o.id = ${orgId}
    union all
    select c.code as value, c.code || ' · ' || c.name as label, s.id::text as "scopeValue"
      from subsidiaries s join currencies c on c.code = s.base_currency
      where s.org_id = ${orgId} and s.is_active
    order by value, "scopeValue"
  `)).rows;
  return rows.filter((row) => row.scopeValue === ''
    ? allowedSubsidiaryIds === null
    : allowedSubsidiaryIds === null || allowedSubsidiaryIds.has(row.scopeValue!));
}

export async function organizationCurrencyAvailable(
  exec: SqlExecutor,
  orgId: string,
  currency: string,
  legalEntityId: string | null,
): Promise<boolean> {
  const multi = await orgFeatureEnabled(orgId, 'multiCurrency', exec);
  return (await exec.execute(sql`
    select c.code from currencies c where c.code = ${currency} and (
      ${multi}
      or (${legalEntityId}::uuid is null and exists(select 1 from orgs where id = ${orgId} and base_currency = c.code))
      or exists(select 1 from subsidiaries where org_id = ${orgId} and id = ${legalEntityId}::uuid and is_active and base_currency = c.code)
    )
  `)).rows.length === 1;
}
