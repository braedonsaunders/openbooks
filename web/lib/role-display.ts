/**
 * Display names for finding-assignment team roles.
 *
 * Role names live in the tenant database, seeded in English by BUILT_IN_ROLES
 * (engine/src/organization/permissions.ts). An unrenamed seed role must render through the
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
  Production: 'production',
  Buyer: 'buyer',
  Cashier: 'cashier',
  'Project Coordinator': 'projectCoordinator',
}

/**
 * Description for a role as shown in pickers and the roles admin. A built-in
 * role's one-line "can and cannot" description renders through the catalog
 * (admin.roles.builtInDescriptions.<key>) so it follows the reader's locale;
 * a custom role shows the description its administrator wrote.
 */
export function displayRoleDescription(
  role: { key: string; isBuiltIn: boolean; description: string | null },
  builtInDescription: (key: string) => string | null,
): string | null {
  if (role.isBuiltIn) return builtInDescription(role.key) ?? role.description
  return role.description
}

export function displayRoleName(storedName: string, translatedByKey: (key: string) => string): string {
  const key = SEEDED_ROLE_NAMES[storedName]
  return key ? translatedByKey(key) : storedName
}
