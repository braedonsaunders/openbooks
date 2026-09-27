import { guardSubsidiaryScope, type Authz } from "@/lib/authz";
import type { RoutingSubsidiaryScope } from "@openbooks/engine/src/manufacturing/routings.ts";

export function guardRoutingSubsidiaryScope(authz: Authz, routing: RoutingSubsidiaryScope): Response | null {
  const itemDenied = guardSubsidiaryScope(authz, routing.producedItemSubsidiaryId);
  if (itemDenied) return itemDenied;
  for (const operation of routing.operations ?? []) {
    const centerDenied = guardSubsidiaryScope(authz, operation.workCenterSubsidiaryId);
    if (centerDenied) return centerDenied;
  }
  return null;
}
