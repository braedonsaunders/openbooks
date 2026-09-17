/**
 * Display names for CRM opportunity statuses.
 *
 * Status names live in the tenant database, seeded in English by
 * ensureCrmDefaults (engine/src/crm.ts). An unrenamed seed status must render
 * through the catalog (crm.opportunities.statuses); a status the tenant
 * renamed keeps its stored name. `crm-status-display.test.ts` pins the seed
 * map to the engine tuples so the two cannot drift apart.
 */

/** English seed name → opportunities.statuses catalog subkey. */
export const SEEDED_OPPORTUNITY_STATUS_NAMES: Record<string, string> = {
  Qualification: 'qualification',
  Discovery: 'discovery',
  Proposal: 'proposal',
  Negotiation: 'negotiation',
  'Closed won': 'closedWon',
  'Closed lost': 'closedLost',
}

export function displayOpportunityStatusName(
  storedName: string,
  translatedByKey: (key: string) => string,
): string {
  const key = SEEDED_OPPORTUNITY_STATUS_NAMES[storedName]
  return key ? translatedByKey(key) : storedName
}
