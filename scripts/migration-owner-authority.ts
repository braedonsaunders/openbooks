const PRIVATE_AUTHORITY_PUBLISHER = "generated/0626_tenant_retirement.sql";
const PRIVATE_AUTHORITY_DIGEST = "4da9e2c44bff6ed85de4fa5eebf94075070e86f0308f65e243bb5c3a22352988";

/** Private authority is created by the maintenance login, not the business
 * owner. Subsequent public migrations retain the provisioned business owner. */
export function migrationBusinessOwnerRole(filename: string, digest: string,
  businessOwner: string | undefined): string | undefined {
  if (filename !== PRIVATE_AUTHORITY_PUBLISHER) return businessOwner;
  if (digest !== PRIVATE_AUTHORITY_DIGEST) throw new Error("Private authority publisher differs from its published identity");
  return undefined;
}
