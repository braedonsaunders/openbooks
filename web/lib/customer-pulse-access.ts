import "server-only";

import { isFeatureEnabled } from "./features";
import {
  pulseSectionsForEnabledFeatures,
  type CustomerPulseSections,
} from "./customer-pulse-sections";

/** Return only the permission sections whose organization features are enabled. */
export async function enabledCustomerPulseSections(
  orgId: string,
  sections: CustomerPulseSections | undefined,
): Promise<CustomerPulseSections | null> {
  if (!sections || (!sections.ar && !sections.crm && !sections.projects)) return null;
  const [crm, projects] = await Promise.all([
    sections.crm ? isFeatureEnabled(orgId, "crm") : Promise.resolve(false),
    sections.projects ? isFeatureEnabled(orgId, "projects") : Promise.resolve(false),
  ]);
  return pulseSectionsForEnabledFeatures(sections, { crm, projects });
}
