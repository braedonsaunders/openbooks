import type { SqlExecutor } from '../../platform/db.ts';
import { organizationCurrencyOptions, organizationCurrencyAvailable } from '../../organization/currency-options.ts';
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
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  return organizationCurrencyOptions(exec, orgId, allowed);
}

/** Currency policy is enforced on writes as well as in the picker. */
export async function requireBenefitCurrency(exec: SqlExecutor, orgId: string, currency: string, legalEntityId: string | null): Promise<void> {
  if (!(await organizationCurrencyAvailable(exec, orgId, currency, legalEntityId))) {
    throw new BenefitsError('REFUSED', `Currency ${currency} is not available for this employer — choose its enabled currency in Benefits. Foreign currencies require Company Settings → Features → Multi-currency.`);
  }
}
