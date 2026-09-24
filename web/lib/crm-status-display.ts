import { SEEDED_ACCOUNT_STATUS_NAMES, SEEDED_OPPORTUNITY_STATUS_NAMES } from '../../engine/src/crm/crm-default-statuses.ts'

export { SEEDED_ACCOUNT_STATUS_NAMES, SEEDED_OPPORTUNITY_STATUS_NAMES }

/**
 * Display names for CRM opportunity statuses.
 *
 * Status names live in the tenant database, seeded in English by
 * ensureCrmDefaults (engine/src/crm/crm.ts). An unrenamed seed status must render
 * through the catalog (crm.opportunities.statuses); a status the tenant
 * renamed keeps its stored name. The dependency-free
 * engine/src/crm/crm-default-statuses.ts module is the shared seed/display
 * source.
 */

export function displayOpportunityStatusName(
  storedName: string,
  translatedByKey: (key: string) => string,
): string {
  const key = SEEDED_OPPORTUNITY_STATUS_NAMES[storedName]
  return key ? translatedByKey(key) : storedName
}

export function displayAccountStatusName(
  storedName: string,
  translatedByKey: (key: string) => string,
): string {
  const key = SEEDED_ACCOUNT_STATUS_NAMES[storedName]
  return key ? translatedByKey(key) : storedName
}
