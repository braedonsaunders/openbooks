import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import {
  gateSubsidiaryScopeAllows,
  worklistGates,
  type GateSubsidiaryScope,
  type WorklistGate,
} from "./flows/gates.ts";

/**
 * The unified approvals worklist. Flows gates are only one approval
 * mechanism: documents sitting in `pending_approval` with no pending gate
 * (migrated rows, abandoned runs, legacy direct writes), status-based
 * payment runs, and budget scenarios in `pending_approval` submitted through
 * the direct maker/checker path are invisible to worklistGates, so an
 * approver would see an empty worklist while work waits. This reader returns
 * every thing awaiting the caller — pending gates AND gateless document
 * approvals AND pending budgets AND pending pay runs — with one row per
 * actionable item:
 *
 * - a document WITH a pending gate appears only through its gate (never as
 *   a document row), so the assigned approver cannot be bypassed;
 * - void-requested documents are excluded: their pending_approval rides the
 *   void flow, and deciding them here would approve the document instead of
 *   completing the void;
 * - the caller's own submissions are excluded everywhere (separation of
 *   duties is enforced again at decide time);
 * - restricted subsidiary sets filter fail-closed, mirroring the gate path.
 */

export interface WorklistDocument {
  kind: "document";
  /** Decide handle for the document-status approval path. */
  id: string;
  documentNumber: string;
  docKind: string;
  status: string;
  total: string;
  currency: string;
  documentDate: string;
  partyName: string | null;
  memo: string | null;
  subsidiaryId: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  createdAt: string;
}

export interface WorklistPayRun {
  kind: "pay_run";
  /** Decide handle for the pay-run approval path. */
  id: string;
  runNumber: string;
  direction: string;
  purpose: string;
  currency: string | null;
  totalAmount: string;
  paymentCount: number;
  subsidiaryId: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  createdAt: string;
}

export interface WorklistBudget {
  kind: "budget";
  /** Scenario id — the inbox links to the budget drawer, where the module
   * surface (not the inbox) records the checker decision. */
  id: string;
  name: string;
  status: string;
  total: string;
  fiscalYear: number;
  submittedBy: string | null;
  submittedAt: string | null;
  createdAt: string;
}

export type UnifiedApproval =
  | { kind: "flow_gate"; id: string; gate: WorklistGate }
  | { kind: "document"; id: string; document: WorklistDocument }
  | { kind: "budget"; id: string; budget: WorklistBudget }
  | { kind: "pay_run"; id: string; payRun: WorklistPayRun };

export interface WorklistScope {
  roles?: Iterable<string>;
  allowedSubsidiaryIds?: GateSubsidiaryScope;
  /**
   * The caller holds payment approval permission (ap/ar.approve for the
   * run's direction). Pay runs stay out of the worklist without it.
   */
  includePayRuns?: boolean;
  /**
   * The caller holds the budgets.approve grant. Pending budget scenarios
   * stay out of the worklist without it.
   */
  includeBudgets?: boolean;
}

function scopeAllows(allowed: GateSubsidiaryScope, subsidiaryId: string | null): boolean {
  return gateSubsidiaryScopeAllows(allowed, subsidiaryId);
}

async function worklistDocuments(
  orgId: string,
  userId: string,
  allowedSubsidiaryIds: GateSubsidiaryScope,
): Promise<WorklistDocument[]> {
  const rows = (await db.execute<{
    id: string; documentNumber: string; docKind: string; status: string;
    total: string; currency: string; documentDate: string; partyName: string | null;
    memo: string | null; subsidiaryId: string | null; submittedBy: string | null;
    submittedAt: string | null; createdAt: string;
  }>(sql`
    select d.id, d.document_number as "documentNumber", d.kind as "docKind",
           d.status::text as status, d.total::text as total, d.currency,
           d.document_date::text as "documentDate", p.display_name as "partyName",
           d.memo, d.subsidiary_id as "subsidiaryId", d.submitted_by as "submittedBy",
           d.submitted_at::text as "submittedAt", d.created_at::text as "createdAt"
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where d.org_id = ${orgId} and d.status = 'pending_approval'
       and d.void_requested_at is null
       and (d.submitted_by is null or d.submitted_by <> ${userId})
       and not exists (
         select 1 from flow_gates g
          where g.org_id = d.org_id and g.subject_id = d.id and g.status = 'pending'
       )
     order by d.created_at`)).rows;
  return rows
    .filter((row) => scopeAllows(allowedSubsidiaryIds, row.subsidiaryId))
    .map((row) => ({ kind: "document" as const, ...row }));
}

async function worklistPayRuns(
  orgId: string,
  userId: string,
  allowedSubsidiaryIds: GateSubsidiaryScope,
): Promise<WorklistPayRun[]> {
  const rows = (await db.execute<{
    id: string; runNumber: string; direction: string; purpose: string;
    currency: string | null; totalAmount: string; paymentCount: number;
    subsidiaryId: string | null; submittedBy: string | null;
    submittedAt: string | null; createdAt: string;
  }>(sql`
    select r.id, r.run_number as "runNumber", r.direction, r.purpose, r.currency,
           r.total_amount::text as "totalAmount", r.payment_count as "paymentCount",
           r.subsidiary_id as "subsidiaryId", r.submitted_by as "submittedBy",
           r.submitted_at::text as "submittedAt", r.created_at::text as "createdAt"
      from payment_runs r
     where r.org_id = ${orgId} and r.status = 'pending_approval'
       and (r.submitted_by is null or r.submitted_by <> ${userId})
     order by r.created_at`)).rows;
  return rows
    .filter((row) => scopeAllows(allowedSubsidiaryIds, row.subsidiaryId))
    .map((row) => ({ kind: "pay_run" as const, ...row }));
}

/**
 * Gateless budget approvals: scenarios in pending_approval with no pending
 * flow gate. Deliberately unfiltered by subsidiary — the budgets module
 * itself scopes by grant, not by line subsidiary, so the inbox mirrors the
 * drawer the row links to. The submitter never sees their own submission
 * here, mirroring the document leg.
 */
async function worklistBudgets(
  orgId: string,
  userId: string,
): Promise<WorklistBudget[]> {
  const rows = (await db.execute<{
    id: string; name: string; status: string; total: string; fiscalYear: number;
    submittedBy: string | null; submittedAt: string | null; createdAt: string;
  }>(sql`
    select bs.id, bs.name, bs.status::text as status,
           coalesce(sum(bl.amount), 0)::text as total, bs.fiscal_year as "fiscalYear",
           bs.submitted_by as "submittedBy", bs.submitted_at::text as "submittedAt",
           bs.created_at::text as "createdAt"
      from budget_scenarios bs
      left join budget_lines bl on bl.scenario_id = bs.id and bl.org_id = bs.org_id
     where bs.org_id = ${orgId} and bs.status = 'pending_approval'
       and (bs.submitted_by is null or bs.submitted_by <> ${userId})
       and not exists (
         select 1 from flow_gates g
          where g.org_id = bs.org_id and g.subject_id = bs.id and g.status = 'pending'
       )
     group by bs.id
     order by bs.created_at`)).rows;
  return rows.map((row) => ({ kind: "budget" as const, ...row }));
}

export async function worklistApprovals(
  orgId: string,
  userId: string,
  scope: WorklistScope = {},
): Promise<UnifiedApproval[]> {
  const gates = await worklistGates(orgId, userId, scope.roles, scope.allowedSubsidiaryIds);
  const out: UnifiedApproval[] = gates.map((gate) => ({ kind: "flow_gate" as const, id: gate.id, gate }));
  for (const document of await worklistDocuments(orgId, userId, scope.allowedSubsidiaryIds)) {
    out.push({ kind: "document", id: document.id, document });
  }
  if (scope.includeBudgets) {
    for (const budget of await worklistBudgets(orgId, userId)) {
      out.push({ kind: "budget", id: budget.id, budget });
    }
  }
  if (scope.includePayRuns) {
    for (const payRun of await worklistPayRuns(orgId, userId, scope.allowedSubsidiaryIds)) {
      out.push({ kind: "pay_run", id: payRun.id, payRun });
    }
  }
  return out;
}

export class DocumentApprovalError extends Error {
  readonly name = "DocumentApprovalError";
}

/**
 * Decide a gateless document-status approval: a document in pending_approval
 * with no pending gate. Fails closed toward the routed path — when a gate
 * exists the caller must decide through it — and enforces separation of
 * duties and the caller's subsidiary boundary, mirroring the gate path.
 */
export async function decideDocumentApproval(
  orgId: string,
  documentId: string,
  userId: string,
  decision: "approved" | "rejected",
  comment?: string | null,
  allowedSubsidiaryIds?: GateSubsidiaryScope,
): Promise<{ status: "approved" | "draft" }> {
  if (decision === "rejected" && !comment?.trim()) {
    throw new DocumentApprovalError("a rejection comment is required");
  }
  return withOrgTransaction(orgId, async () => {
    const rows = (await db.execute<{
      id: string; status: string; subsidiaryId: string | null;
      submittedBy: string | null; voidRequested: boolean;
    }>(sql`
      select id, status::text as status, subsidiary_id as "subsidiaryId",
             submitted_by as "submittedBy", (void_requested_at is not null) as "voidRequested"
        from documents where id = ${documentId} and org_id = ${orgId} for update`)).rows;
    const doc = rows[0];
    if (!doc) throw new DocumentApprovalError("approval not found");
    if (doc.status !== "pending_approval" || doc.voidRequested) {
      throw new DocumentApprovalError("only a document pending approval can be decided");
    }
    const gated = (await db.execute<{ id: string }>(sql`
      select id from flow_gates
       where org_id = ${orgId} and subject_id = ${documentId} and status = 'pending' limit 1`)).rows[0];
    if (gated) {
      throw new DocumentApprovalError("this approval is routed: decide through the assigned approval");
    }
    if (doc.submittedBy === userId) {
      throw new DocumentApprovalError("the submitter cannot approve their own document");
    }
    if (!scopeAllows(allowedSubsidiaryIds, doc.subsidiaryId)) {
      throw new DocumentApprovalError("approval not found");
    }
    const next = decision === "approved" ? "approved" : "draft";
    await db.execute(sql`
      update documents set status = ${next}, updated_by = ${userId}, updated_at = now()
       where id = ${documentId} and org_id = ${orgId}`);
    return { status: next };
  });
}
