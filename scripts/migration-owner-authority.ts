const RELEASE_BASELINE = /^baselines\/[a-z0-9_]+\.sql$/;

/** Forward migrations that administer PostgreSQL catalogs or private
 * maintenance authority, by exact published identity. */
const MAINTENANCE_PUBLISHERS = new Map<string, string>();

/** A release baseline creates the private retirement authority and system
 * function privileges, so it applies with the maintenance login; bootstrap
 * then hands every business object to the business owner. Other migrations
 * apply as the provisioned business owner. */
export function migrationBusinessOwnerRole(
  filename: string,
  digest: string,
  businessOwner: string | undefined,
): string | undefined {
  if (RELEASE_BASELINE.test(filename)) return undefined;
  const required = MAINTENANCE_PUBLISHERS.get(filename);
  if (!required) return businessOwner;
  if (digest !== required)
    throw new Error("Maintenance authority publisher differs from its published identity");
  return undefined;
}

export function migrationRequiresMaintenanceAuthority(filename: string): boolean {
  return RELEASE_BASELINE.test(filename) || MAINTENANCE_PUBLISHERS.has(filename);
}
