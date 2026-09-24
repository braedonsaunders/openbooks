import 'server-only'

import type { AutomationPlan } from '@openbooks/forms-core'
import { can, type Authz } from './authz'
import {
  createPermission,
  documentEditPermission,
  documentReadPermission,
  postPermission,
} from './document-kinds'

/**
 * Domain permission map for generic flow/document endpoints.
 *
 * A generic endpoint (documents/[id], flows record-state, flows manual)
 * must enforce the SUBJECT's kind-specific domain permission — read for
 * reads, edit/post authority for mutations — derived from the same per-kind
 * map the kind-specific routes use. This module is that single map: every
 * generic endpoint resolves permissions here, so no second map can drift.
 *
 * Document kinds served by web/lib/document-kinds.ts DOC_KINDS resolve
 * through that registry (no second map — documentReadPermission /
 * documentEditPermission). Kinds outside the drawer registry resolve to the
 * grant their dedicated route checks (cited per entry). Non-document flow
 * subjects resolve to their domain's read/manage grant (cited per entry).
 * Unknown kinds return null and callers fail closed.
 */

export interface FlowSubjectPermissions {
  /** Read the subject (record-state, notify-only buttons, drawer reads). */
  read: string
  /** Mutate the subject short of a post/approve decision (field sets, locks). */
  edit: string
  /** Post or approve the subject (post_document, change_status to approved). */
  approve: string
}

/**
 * Document kinds outside the DOC_KINDS drawer registry, with the grant
 * their kind-specific surface checks:
 * - journal: /journal requires gl.read; void requires gl.post.
 * - vendor_payment: /payments requires ap.pay; void requires ap.pay.
 * - customer_payment: /receipts requires ar.pay; void requires ar.pay.
 * - expense_report: /expenses requires expenses.read; writes expenses.create.
 * - sales_order / quote: estimates require ar.read; void requires ar.create.
 * - purchase_order: void requires ap.create (reads ride the AP surface).
 * - field_ticket: /field-tickets requires time.read; writes time.manage.
 */
const NON_REGISTRY_DOCUMENT_PERMISSIONS: Record<string, FlowSubjectPermissions> = {
  journal: { read: 'gl.read', edit: 'gl.post', approve: 'gl.post' },
  vendor_payment: { read: 'ap.pay', edit: 'ap.pay', approve: 'ap.pay' },
  customer_payment: { read: 'ar.pay', edit: 'ar.pay', approve: 'ar.pay' },
  expense_report: { read: 'expenses.read', edit: 'expenses.create', approve: 'ap.post' },
  sales_order: { read: 'ar.read', edit: 'ar.create', approve: 'ar.create' },
  quote: { read: 'ar.read', edit: 'ar.create', approve: 'ar.create' },
  purchase_order: { read: 'ap.read', edit: 'ap.create', approve: 'ap.create' },
  field_ticket: { read: 'time.read', edit: 'time.manage', approve: 'time.manage' },
}

/**
 * Non-document flow subjects, with the grant their kind-specific route
 * checks (reads first, writes second):
 * - party_bank_account: party bank accounts manage through parties.manage;
 *   reads ride the parties surface (parties.read).
 * - timesheet_week: /timesheets requires time.read; writes time.manage.
 * - budget_scenario: budgets routes require budgets.read; writes
 *   budgets.manage; checker decisions require budgets.approve.
 * - close_run: /close/runs requires close.run; reads ride close.read.
 * - allocation_run: allocation runs require allocations.read; writes
 *   allocations.manage.
 * - pay_run: payroll runs require payroll.read; the run workspace manages
 *   through payroll.manage. (Pay runs are documents, but their
 *   kind-specific surface is payroll — not the GL namespace their posting
 *   rule lives under.)
 * - hrm_change_request: hrm.employment.read / hrm.employment.manage.
 * - hrm_leave_request: hrm.leave.read / hrm.leave.manage.
 * - hrm_comp_cycle: hrm.compensation.read / hrm.compensation.manage.
 * - crew_time_batch: crew batches read through time.read; entry writes
 *   through time.crew.enter.
 */
const NON_DOCUMENT_PERMISSIONS: Record<string, FlowSubjectPermissions> = {
  party_bank_account: { read: 'parties.read', edit: 'parties.manage', approve: 'parties.manage' },
  timesheet_week: { read: 'time.read', edit: 'time.manage', approve: 'time.manage' },
  budget_scenario: { read: 'budgets.read', edit: 'budgets.manage', approve: 'budgets.approve' },
  close_run: { read: 'close.read', edit: 'close.run', approve: 'close.approve' },
  allocation_run: { read: 'allocations.read', edit: 'allocations.manage', approve: 'allocations.approve' },
  pay_run: { read: 'payroll.read', edit: 'payroll.manage', approve: 'payroll.manage' },
  hrm_change_request: { read: 'hrm.employment.read', edit: 'hrm.employment.manage', approve: 'hrm.employment.manage' },
  hrm_leave_request: { read: 'hrm.leave.read', edit: 'hrm.leave.manage', approve: 'hrm.leave.manage' },
  hrm_comp_cycle: { read: 'hrm.compensation.read', edit: 'hrm.compensation.manage', approve: 'hrm.compensation.manage' },
  crew_time_batch: { read: 'time.read', edit: 'time.crew.enter', approve: 'time.manage' },
}

/**
 * Resolve a flow subject kind to its domain permissions. Document kinds in
 * the DOC_KINDS registry resolve through document-kinds.ts (the map the
 * documents routes use); every other kind resolves through the tables
 * above. Returns null for kinds with no known domain map — including
 * financial_change, whose kind-specific authorization is polymorphic per
 * change type (assets.manage / ar.post / close.run) and has no single
 * domain grant. Callers fail closed on null.
 */
export function flowSubjectPermissions(subjectKind: string): FlowSubjectPermissions | null {
  const nonDocument = NON_DOCUMENT_PERMISSIONS[subjectKind]
  if (nonDocument) return nonDocument
  // project_charge is registry-special (Projects domain, not its GL
  // namespace): approve rides projects.manage with edit.
  if (subjectKind === 'project_charge') {
    return { read: 'projects.read', edit: 'projects.manage', approve: 'projects.manage' }
  }
  try {
    return {
      read: documentReadPermission(subjectKind),
      edit: documentEditPermission(subjectKind),
      approve: postPermission(subjectKind),
    }
  } catch {
    // Not in the drawer registry — fall through to the explicit table.
  }
  return NON_REGISTRY_DOCUMENT_PERMISSIONS[subjectKind] ?? null
}

/** True when the caller holds the kind's domain read grant. */
export function canReadFlowSubject(authz: Authz, subjectKind: string): boolean {
  const perms = flowSubjectPermissions(subjectKind)
  return perms !== null && can(authz, perms.read)
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
  const perms = flowSubjectPermissions(subjectKind)
  if (!perms) return null
  let effect: 'read' | 'edit' | 'approve' = 'read'
  for (const action of plan.actions) {
    if (action.action === 'post_document') {
      effect = 'approve'
      break
    }
    if (action.action === 'change_status') {
      effect = action.to === 'approved' ? 'approve' : 'edit'
      if (effect === 'approve') break
      continue
    }
    if (
      action.action === 'set_field' ||
      action.action === 'lock_record' ||
      action.action === 'unlock_record'
    ) {
      effect = 'edit'
    }
  }
  // Raising an approval gate starts a consequential workflow on someone
  // else's record — that is a write even when the branch mutates nothing
  // itself.
  if (effect === 'read' && plan.gates.length > 0) effect = 'edit'
  return effect === 'approve' ? perms.approve : effect === 'edit' ? perms.edit : perms.read
}

/**
 * Read permission for a document kind through the GENERIC documents
 * endpoints (documents/[id], actions, correct, void) — the exact grant
 * those routes enforce today, so adopting this helper changes no grant,
 * only the denial shape. Registry kinds resolve through document-kinds.ts;
 * the void-only kinds (journal, payments, expenses, orders, field tickets)
 * resolve through the same table the flows helper uses. Null when the kind
 * is not served here at all (callers 422 before consulting this).
 */
export function documentRouteReadPermission(kind: string): string | null {
  if (kind === 'project_charge') return 'projects.read'
  try {
    return documentReadPermission(kind)
  } catch {
    // Not in the drawer registry — fall through to the explicit table.
  }
  return NON_REGISTRY_DOCUMENT_PERMISSIONS[kind]?.read ?? null
}

/** Edit permission for a document kind through the generic documents endpoints. */
export function documentRouteEditPermission(kind: string): string | null {
  if (kind === 'project_charge') return 'projects.manage'
  try {
    return documentEditPermission(kind)
  } catch {
    return null
  }
}

/** True when the caller holds the generic-documents read grant for a kind. */
export function canReadDocumentKind(authz: Authz, kind: string): boolean {
  const perm = documentRouteReadPermission(kind)
  return perm !== null && can(authz, perm)
}

// Re-exported so generic endpoints can name the create grant without
// importing the registry twice (createPermission throws for unknown kinds;
// prefer documentRouteEditPermission when the kind may be void-only).
export { createPermission }
