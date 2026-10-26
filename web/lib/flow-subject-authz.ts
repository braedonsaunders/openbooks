import "server-only";

import type { AutomationPlan } from "@openbooks/forms-core";
import { getFlowAdapter } from "@openbooks/engine/flows/registry";
import {
  documentRouteEditPermission,
  documentRouteReadPermission,
} from "@openbooks/engine/records/document-kind-permissions";
import type { FlowSubjectPermissions } from "@openbooks/engine/flows/types";
import { can, type Authz } from "./authz";
import { createPermission } from "./document-kinds";
import { expenseReportReachable } from "./expense-access";

/**
 * Domain permissions for generic flow/document endpoints.
 *
 * A generic endpoint (documents/[id], flows record-state, flows manual)
 * must enforce the SUBJECT's kind-specific domain permission — read for
 * reads, edit/post authority for mutations. Each flow subject adapter
 * declares its grants (FlowSubjectAdapter.permissions), document kinds
 * through the engine's document permission catalog, so registering a kind
 * is what gives it a grant: there is no second map here to forget.
 */

export type { FlowSubjectPermissions };

/**
 * Resolve a flow subject kind to its domain permissions. Returns null for
 * unknown kinds and for kinds with no single domain grant (financial_change
 * authorizes per change type). Callers fail closed on null.
 */
export function flowSubjectPermissions(subjectKind: string): FlowSubjectPermissions | null {
  return getFlowAdapter(subjectKind)?.permissions ?? null;
}

/** True when the caller holds the kind's domain read grant. */
export function canReadFlowSubject(authz: Authz, subjectKind: string): boolean {
  const perms = flowSubjectPermissions(subjectKind);
  return perms !== null && can(authz, perms.read);
}

/**
 * A kind's domain grant on one record: the grant itself, or the self-service
 * grant that confers it over the caller's own records (`expenses.self` on
 * the caller's own expense report). Record-level endpoints use this so a
 * self-service holder reaches exactly their own record and nothing else.
 */
export async function holdsSubjectGrant(
  authz: Authz,
  subjectKind: string,
  subjectId: string,
  permission: string,
): Promise<boolean> {
  if (can(authz, permission)) return true;
  if (subjectKind !== "expense_report") return false;
  const authority =
    permission === "expenses.read" ? "read" : permission === "expenses.create" ? "edit" : null;
  return authority !== null && expenseReportReachable(authz, authority, subjectId);
}

/** True when the caller may read this record of the kind (see holdsSubjectGrant). */
export async function canReadSubjectRecord(
  authz: Authz,
  subjectKind: string,
  subjectId: string,
): Promise<boolean> {
  const adapter = getFlowAdapter(subjectKind);
  const permission = adapter?.readPermission
    ? await adapter.readPermission(subjectId, authz.user.id)
    : adapter?.permissions?.read;
  return (
    typeof permission === "string" && holdsSubjectGrant(authz, subjectKind, subjectId, permission)
  );
}

/**
 * The domain grant a manual flow button's planned effects require —
 * the effect's own permission, independent of the trigger's optional
 * requirePermission:
 * - post_document, or change_status into approved, needs post/approve
 *   authority (the same grant the Post / Approve action requires);
 * - any other subject write (set_field, other status transitions,
 *   lock/unlock) or raising an approval gate needs edit authority;
 * - notify/send-email-only buttons need read authority.
 * Returns null when the kind has no known domain map (fail closed).
 */
export function manualButtonPermission(subjectKind: string, plan: AutomationPlan): string | null {
  const perms = flowSubjectPermissions(subjectKind);
  if (!perms) return null;
  let effect: "read" | "edit" | "approve" = "read";
  for (const action of plan.actions) {
    if (action.action === "post_document") {
      effect = "approve";
      break;
    }
    if (action.action === "change_status") {
      effect = action.to === "approved" ? "approve" : "edit";
      if (effect === "approve") break;
      continue;
    }
    if (
      action.action === "distribute_schedule" ||
      action.action === "set_field" ||
      action.action === "lock_record" ||
      action.action === "unlock_record"
    ) {
      effect = "edit";
    }
  }
  // Raising an approval gate starts a consequential workflow on someone
  // else's record — that is a write even when the branch mutates nothing
  // itself.
  if (effect === "read" && plan.gates.length > 0) effect = "edit";
  return effect === "approve" ? perms.approve : effect === "edit" ? perms.edit : perms.read;
}

// Generic documents endpoints resolve their read/edit grants through the
// engine's document permission catalog.
export { documentRouteEditPermission, documentRouteReadPermission };

/** True when the caller holds the generic-documents read grant for a kind. */
export function canReadDocumentKind(authz: Authz, kind: string): boolean {
  const perm = documentRouteReadPermission(kind);
  return perm !== null && can(authz, perm);
}

// Re-exported so generic endpoints can name the create grant without
// importing the registry twice (createPermission throws for unknown kinds;
// prefer documentRouteEditPermission when the kind may be void-only).
export { createPermission };
