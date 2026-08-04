import { ensureCloseDefaults } from "./close.ts";
import { ensureCrmDefaults } from "./crm.ts";
import { ensureCustomizationDefaults } from "./customization-defaults.ts";
import { ensureBuiltInPaymentFormats } from "./payment-operations.ts";
import { seedProjectTypes } from "./seed-project-types.ts";

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
  await ensureCloseDefaults(orgId, actorId ?? undefined);
  await Promise.all([
    ensureCrmDefaults(orgId, actorId),
    ensureBuiltInPaymentFormats(orgId, actorId),
    seedProjectTypes(orgId, actorId),
    ensureCustomizationDefaults({ orgId, actorId }),
  ]);
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
