import "server-only";
import type { InboxListContext } from "@openbooks/engine/src/inbox/index.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { can, type Authz } from "./authz";
import { isFeatureEnabled } from "./features";

/**
 * HR-15: build the server-side inbox context from the session. The union
 * scope (roles, subsidiary boundary, budget/pay-run legs) rides the
 * context so the flows leg sees exactly the gates the inbox page's union
 * table shows. Built only from the session — never from client input.
 */
export async function inboxContext(authz: Authz): Promise<InboxListContext> {
  const orgId = authz.user.orgId;
  const [asOf, budgetsOn] = await Promise.all([
    businessToday(orgId),
    isFeatureEnabled(orgId, "budgets"),
  ]);
  const payDirections: string[] = [];
  if (can(authz, "ap.approve")) payDirections.push("outbound");
  if (can(authz, "ar.approve")) payDirections.push("inbound");
  return {
    orgId,
    actorId: authz.user.id,
    asOf,
    scope: {
      roles: authz.user.roles.map((role) => role.key),
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds],
      includeBudgets: budgetsOn && can(authz, "budgets.approve"),
      includePayRuns: payDirections.length > 0,
      payDirections,
    },
  };
}

/** The doorway to decision rows: callers who cannot approve see no union. */
export function maySeeUnion(authz: Authz): boolean {
  return (
    can(authz, "flows.approve") ||
    can(authz, "ap.approve") ||
    can(authz, "ar.approve") ||
    can(authz, "budgets.approve")
  );
}
