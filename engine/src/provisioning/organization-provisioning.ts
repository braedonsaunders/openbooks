import { ensureCloseDefaults } from "../close/defaults.ts";
import { ensureCrmDefaults } from "../crm/crm.ts";
import { ensureAccountGroupDefaults } from "./account-group-defaults.ts";
import { ensureCustomizationDefaults } from "./customization-defaults.ts";
import { ensureBuiltInPaymentFormats } from "../payments/operations.ts";
import { seedProjectTypes } from "../projects/seed-project-types.ts";

export type ProvisionedFeature =
  | "crm"
  | "projects"
  | "advancedClose"
  | "customization";

/**
 * Install the editable baseline records a company needs. This is an explicit
 * installation/setup command; pages and GET handlers must remain read-only.
 */
export async function provisionOrganizationDefaults(
  orgId: string,
  actorId: string | null = null,
): Promise<void> {
  // Sequential, never fanned out: organization creation runs this inside
  // its own transaction, and one pinned connection cannot execute
  // statements concurrently.
  await ensureCloseDefaults(orgId, actorId ?? undefined);
  await ensureAccountGroupDefaults(orgId, actorId);
  await ensureCrmDefaults(orgId, actorId);
  await ensureBuiltInPaymentFormats(orgId, actorId);
  await seedProjectTypes(orgId, actorId);
  await ensureCustomizationDefaults({ orgId, actorId });
}

/** Provision only the defaults owned by an explicitly enabled feature. */
export async function provisionFeatureDefaults(
  orgId: string,
  actorId: string,
  feature: string,
): Promise<void> {
  switch (feature as ProvisionedFeature) {
    case "crm":
      await ensureCrmDefaults(orgId, actorId);
      return;
    case "projects":
      await seedProjectTypes(orgId, actorId);
      return;
    case "advancedClose":
      await ensureCloseDefaults(orgId, actorId);
      return;
    case "customization":
      await ensureCustomizationDefaults({ orgId, actorId });
      return;
    default:
      return;
  }
}
