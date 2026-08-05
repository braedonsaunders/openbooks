/**
 * Raw SQL cannot reliably apply an arbitrary subsidiary allowlist across every
 * reporting relation and join. Until the governed catalog has database-level
 * subsidiary lineage, only an organization-unrestricted grant may enter it.
 */
export function hasUnrestrictedQueryScope(allowedSubsidiaryIds: Set<string> | null): boolean {
  return allowedSubsidiaryIds === null
}
