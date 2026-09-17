/**
 * Display names for finding-assignment team roles.
 *
 * Role names live in the tenant database, seeded in English by BUILT_IN_ROLES
 * (engine/src/permissions.ts). An unrenamed seed role must render through the
 * catalog (agents.drawer.assignment.roles); a role the tenant renamed keeps
 * its stored name. `role-display.test.ts` pins the seed map to the engine
 * tuples so the two cannot drift apart.
 */

/** English seed name → drawer.assignment.roles catalog subkey. */
export const SEEDED_ROLE_NAMES: Record<string, string> = {
  Administrator: 'administrator',
  Accountant: 'accountant',
  Approver: 'approver',
  Controller: 'controller',
  Viewer: 'viewer',
  'Sales Manager': 'salesManager',
  'Sales Representative': 'salesRepresentative',
}

export function displayRoleName(storedName: string, translatedByKey: (key: string) => string): string {
  const key = SEEDED_ROLE_NAMES[storedName]
  return key ? translatedByKey(key) : storedName
}
