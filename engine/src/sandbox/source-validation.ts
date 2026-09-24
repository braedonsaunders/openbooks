/** Refuse a missing or non-production source before a sandbox org is born. */
export function assertProductionSandboxSource<T extends { env_kind: string }>(
  source: T | null | undefined,
  sourceOrgId: string,
): asserts source is T {
  if (!source) throw new Error(`production org not found: ${sourceOrgId}`);
  if (source.env_kind !== "production") {
    throw new Error(`sandbox source ${sourceOrgId} must be a production organization; sandbox and template organizations cannot be cloned`);
  }
}
