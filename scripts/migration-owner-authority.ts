const MAINTENANCE_PUBLISHERS = new Map([
  ["generated/0539_query_console_and_script_authority_hardening.sql","3047fe5e55f5532ee11f4287d2479e7b2d98f53ce6ee1e40cbc1f2e6afbb30b9"],
  ["generated/0622_query_console_catalog_privileges.sql","40b2a2f129e20507e8d8143f8a6cdfb9f964f5e4248c5a07cce77fdd5735070b"],
  ["generated/0626_tenant_retirement.sql","4da9e2c44bff6ed85de4fa5eebf94075070e86f0308f65e243bb5c3a22352988"],
]);

/** Catalog privileges and private authority require the maintenance login, not the business
 * owner. Subsequent public migrations retain the provisioned business owner. */
export function migrationBusinessOwnerRole(filename: string, digest: string,
  businessOwner: string | undefined): string | undefined {
  const required=MAINTENANCE_PUBLISHERS.get(filename);
  if (!required) return businessOwner;
  if (digest !== required) throw new Error("Maintenance authority publisher differs from its published identity");
  return undefined;
}

/** These published steps administer PostgreSQL catalogs or isolated maintenance authority. */
export function migrationRequiresMaintenanceAuthority(filename: string): boolean {
  return MAINTENANCE_PUBLISHERS.has(filename);
}
