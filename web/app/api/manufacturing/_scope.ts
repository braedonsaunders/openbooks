import { guardSubsidiaryScope, type Authz } from "@/lib/authz";
import type { RoutingSubsidiaryScope } from "@openbooks/engine/src/manufacturing/routings.ts";

export function guardRoutingSubsidiaryScope(authz: Authz, routing: RoutingSubsidiaryScope): Response | null {
  for (const operation of routing.operations ?? []) {
    const centerDenied = guardSubsidiaryScope(authz, operation.workCenterSubsidiaryId);
    if (centerDenied) return centerDenied;
  }
  for (const location of routing.locations) {
    const denied = guardSubsidiaryScope(authz, location.subsidiaryId, { orgWideNull: true });
    if (denied) return denied;
  }
  return null;
}
