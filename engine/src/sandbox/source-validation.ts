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

/**
 * The promoted-sample-template registration predicate both template-source
 * branches share. Promoted templates are sandbox-kind orgs carrying the
 * sample module's own registration flag (settings.sampleTemplate.enabled,
 * the same predicate the template lookup uses) — there is no 'template'
 * env_kind.
 */
export function isSampleTemplateSource(settings: Record<string, unknown> | null | undefined): boolean {
  const marker = (settings ?? {})["sampleTemplate"];
  return !!marker && typeof marker === "object" && (marker as Record<string, unknown>)["enabled"] === true;
}

/**
 * Refuse a missing or non-template source before a sample-company shell is
 * born or refreshed. Sample provisioning/refresh is the one sanctioned
 * consumer of template sources: the production-only default (I5-platform-66)
 * stands for every other caller. A random sandbox or production org lacks
 * the flag and still refuses, which keeps the confused-deputy protection:
 * the ID passed must actually be a promoted template, never just any org.
 */
export function assertTemplateSandboxSource<
  T extends { env_kind: string; settings: Record<string, unknown> | null },
>(
  source: T | null | undefined,
  sourceOrgId: string,
): asserts source is T {
  if (!source) throw new Error(`template org not found: ${sourceOrgId}`);
  if (!isSampleTemplateSource(source.settings)) {
    throw new Error(`sample source ${sourceOrgId} must be a promoted sample template; ordinary sandbox and production organizations cannot provision a sample company`);
  }
}
