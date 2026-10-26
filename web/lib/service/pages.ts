import "server-only";
import { getAuthz, type Authz } from "../authz";
import { requireFeatureEnabled } from "../feature-gates";
import { accessDeniedHref } from "../gate-targets";
import {
  canAny,
  SERVICE_STAFF_PERMISSIONS,
  serviceCapabilities,
  type ServiceCapabilities,
} from "./authority";

/**
 * Page boundary for the service area: signed in, Service dispatch on (the
 * feature page explains how to turn it on), and a service staff grant.
 * Technicians reach their own work through My visits instead.
 */
export async function requireServiceArea(): Promise<{
  authz: Authz;
  capabilities: ServiceCapabilities;
}> {
  const { redirect } = await import("next/navigation");
  const authz = await getAuthz();
  if (!authz) return redirect("/login");
  await requireFeatureEnabled(authz.user.orgId, "serviceDispatch");
  if (!canAny(authz, SERVICE_STAFF_PERMISSIONS)) {
    if (canAny(authz, ["service.self"])) return redirect("/me/visits");
    return redirect(accessDeniedHref({ permission: "service.read" }));
  }
  return { authz, capabilities: serviceCapabilities(authz) };
}
