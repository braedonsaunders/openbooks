import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  gateDecisionCapability,
  gateSubsidiaryScopeAllows,
  sodBlockedIds,
  worklistGateKindCounts,
  worklistGates,
  type GateSubsidiaryScope,
  type WorklistGate,
} from "./gates.ts";

/**
 * The unified approvals worklist. Flows gates are only one approval
 * mechanism: documents sitting in `pending_approval` with no pending gate
 * (migrated rows, abandoned runs, legacy direct writes) and budget scenarios
 * in `pending_approval` submitted through the direct maker/checker path are
 * invisible to worklistGates, so an approver would see an empty worklist while
 * work waits. This reader returns every thing awaiting the caller — pending
 * gates AND gateless document approvals AND pending budgets — with one row
 * per actionable item. Payment runs approve through their Flows gates and
 * arrive on the gate leg like any other subject:
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
  | { kind: "budget"; id: string; budget: WorklistBudget };

export interface WorklistScope {
  roles?: Iterable<string>;
  allowedSubsidiaryIds?: GateSubsidiaryScope;
  /**
   * The caller holds the budgets.approve grant. Pending budget scenarios
   * stay out of the worklist without it.
   */
  includeBudgets?: boolean;
}

function scopeAllows(allowed: GateSubsidiaryScope, subsidiaryId: string | null): boolean {
  return gateSubsidiaryScopeAllows(allowed, subsidiaryId);
}

/**
 * A server-side window over the approvals union. `limit`/`offset` are the
 * global page; every leg fetches its leading offset+limit rows in merge
 * order (legs are disjoint, so the union slices the page from per-leg
 * prefixes). `kind` filters all legs on the kind the row mapper reports.
 */
export interface WorklistPage {
  limit: number;
  offset: number;
  kind?: string;
  query?: string;
  overdue?: boolean;
}

/** SQL pre-filter reproducing scopeAllows exactly (a null entity fails closed). */
function subsidiaryScopeSql(alias: string, allowed: GateSubsidiaryScope): SQL {
  if (allowed == null) return sql``;
  const ids = JSON.stringify([...allowed]);
  return sql`and ${sql.raw(alias)}.subsidiary_id in (select jsonb_array_elements_text(${ids}::jsonb)::uuid)`;
}

interface LegOpts {
  prefix?: number;
  kind?: string;
  query?: string;
}

function worklistDocumentWhere(
  orgId: string,
  userId: string,
  allowedSubsidiaryIds: GateSubsidiaryScope,
  kind?: string,
  query?: string,
): SQL {
  const needle = query?.trim().toLowerCase()
  return sql`d.org_id = ${orgId} and d.status = 'pending_approval'
    and d.void_requested_at is null
    and (d.submitted_by is null or d.submitted_by <> ${userId})
    and (d.created_by is null or d.created_by <> ${userId})
    and not exists (
      select 1 from flow_gates g
       where g.org_id = d.org_id and g.subject_id = d.id and g.status = 'pending'
    )
    ${subsidiaryScopeSql("d", allowedSubsidiaryIds)}
    ${kind ? sql`and d.kind = ${kind}` : sql``}
    ${needle ? sql`and position(${needle} in lower(concat_ws(' ', d.document_number, d.kind, d.memo,
      (select p.display_name from parties p where p.id=d.party_id and p.org_id=d.org_id)))) > 0` : sql``}`;
}

async function worklistDocuments(
  orgId: string,
  userId: string,
  allowedSubsidiaryIds: GateSubsidiaryScope,
  opts?: LegOpts,
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
     where ${worklistDocumentWhere(orgId, userId, allowedSubsidiaryIds, opts?.kind, opts?.query)}
     order by coalesce(d.submitted_at, d.created_at), d.id
     ${opts?.prefix != null ? sql`limit ${opts.prefix}` : sql``}`)).rows;
  return rows
    .filter((row) => scopeAllows(allowedSubsidiaryIds, row.subsidiaryId))
    .map((row) => ({ kind: "document" as const, ...row }));
}

async function worklistDocumentKindCounts(
  orgId: string,
  userId: string,
  allowedSubsidiaryIds: GateSubsidiaryScope,
  kind?: string,
  query?: string,
): Promise<Map<string, number>> {
  const rows = (await db.execute<{ kind: string; n: string }>(sql`
    select d.kind as kind, count(*) as n
      from documents d
     where ${worklistDocumentWhere(orgId, userId, allowedSubsidiaryIds, kind, query)}
     group by d.kind`)).rows;
  return new Map(rows.map((row) => [row.kind, Number(row.n)]));
}

/**
 * Gateless budget approvals: scenarios in pending_approval with no pending
 * flow gate. Deliberately unfiltered by subsidiary — the budgets module
 * itself scopes by grant, not by line subsidiary, so the inbox mirrors the
 * drawer the row links to. The submitter never sees their own submission
 * here, mirroring the document leg.
 */
function worklistBudgetWhere(orgId: string, userId: string, kind?: string, query?: string): SQL {
  const needle = query?.trim().toLowerCase()
  return sql`bs.org_id = ${orgId} and bs.status = 'pending_approval'
    and (bs.submitted_by is null or bs.submitted_by <> ${userId})
    and not exists (
      select 1 from flow_gates g
       where g.org_id = bs.org_id and g.subject_id = bs.id and g.status = 'pending'
    )
    ${kind && kind !== "budget_scenario" ? sql`and false` : sql``}
    ${needle ? sql`and position(${needle} in lower(concat_ws(' ', bs.name, bs.fiscal_year::text))) > 0` : sql``}`;
}

async function worklistBudgets(
  orgId: string,
  userId: string,
  opts?: LegOpts,
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
     where ${worklistBudgetWhere(orgId, userId, opts?.kind, opts?.query)}
     group by bs.id
     order by coalesce(bs.submitted_at, bs.created_at), bs.id
     ${opts?.prefix != null ? sql`limit ${opts.prefix}` : sql``}`)).rows;
  return rows.map((row) => ({ kind: "budget" as const, ...row }));
}

async function worklistBudgetCount(orgId: string, userId: string, kind?: string, query?: string): Promise<number> {
  const rows = (await db.execute<{ n: string }>(sql`
    select count(*) as n from (
      select bs.id
        from budget_scenarios bs
       where ${worklistBudgetWhere(orgId, userId, kind, query)}
       group by bs.id
    ) s`)).rows;
  return Number(rows[0]?.n ?? 0);
}

export interface WorklistPageScope extends WorklistScope {
  /** Gate + gateless-document legs ride the flows approval grant. */
  includeFlows?: boolean;
}

export interface WorklistPageResult {
  /** The requested global page in merge order. */
  items: UnifiedApproval[];
  /** Exact filtered total across all legs (drives pagination). */
  total: number;
  /** Exact UNFILTERED per-kind counts (drives kind chips). */
  kindCounts: Map<string, number>;
}

/** Merge order key: requested-at, matching the worklist page display sort. */
function worklistMergeMs(item: UnifiedApproval): number {
  if (item.kind === "flow_gate") return +new Date(item.gate.createdAt);
  const row = item.kind === "document" ? item.document : item.budget;
  return +new Date(row.submittedAt ?? row.createdAt);
}

function sumKindCounts(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

function worklistCounts(
  orgId: string,
  userId: string,
  scope: WorklistPageScope,
  { kind, query, overdue }: Pick<WorklistPage, "kind" | "query" | "overdue"> = {},
): Promise<[Map<string, number>, Map<string, number>, number]> {
  return Promise.all([
    scope.includeFlows !== false
      ? worklistGateKindCounts(orgId, userId, scope.roles, scope.allowedSubsidiaryIds, kind, query, overdue)
      : Promise.resolve(new Map<string, number>()),
    scope.includeFlows !== false && !overdue
      ? worklistDocumentKindCounts(orgId, userId, scope.allowedSubsidiaryIds, kind, query)
      : Promise.resolve(new Map<string, number>()),
    scope.includeBudgets === true && (kind == null || kind === "budget_scenario") && !overdue
      ? worklistBudgetCount(orgId, userId, kind, query)
      : Promise.resolve(0),
  ]);
}

/**
 * Gate ids in the caller's worklist that await ANOTHER approver: the gate
 * reaches this viewer (direct, role, or delegation assignment) but the
 * native gate check blocks them as submitter/maker under prevent-self-
 * approval. Resolved through gateDecisionCapability — the same check the
 * decide path enforces — so the "awaiting another approver" rendering and
 * its separate count can never disagree with the act-time verdict. Only
 * the gate leg qualifies: gateless document and budget legs already
 * exclude the caller's own submissions from the worklist entirely.
 */
export async function worklistGatesAwaitingAnotherApprover(
  orgId: string,
  userId: string,
  roles?: Iterable<string>,
  allowedSubsidiaryIds?: GateSubsidiaryScope,
): Promise<string[]> {
  const gates = await worklistGates(orgId, userId, roles, allowedSubsidiaryIds);
  const out: string[] = [];
  for (const gate of gates) {
    if ((await gateDecisionCapability(gate.id, userId)).sodBlocked) out.push(gate.id);
  }
  return out;
}

/** Exact badge totals through the page's native predicates, without fetching rows. */
export async function worklistApprovalsCount(
  orgId: string,
  userId: string,
  scope: WorklistPageScope = {},
): Promise<number> {
  const [gates, documents, budgets] = await worklistCounts(orgId, userId, scope);
  return sumKindCounts(gates) + sumKindCounts(documents) + budgets;
}

/**
 * One server-side page over the approvals union. Every leg fetches its
 * leading offset+limit rows in merge order with SQL LIMIT (plus GROUP BY
 * aggregates for totals); the union merge slices the page from the bounded
 * prefixes, so no request ever scans a whole leg. Predicates are the same
 * builders the full read uses — the window and the counts cannot disagree.
 */
export async function worklistApprovalsPage(
  orgId: string,
  userId: string,
  scope: WorklistPageScope = {},
  page: WorklistPage,
): Promise<WorklistPageResult> {
  const prefix = page.offset + page.limit;
  const kind = page.kind;
  const query = page.query;
  const overdue = page.overdue === true;
  const filtered = kind != null;
  const includeFlows = scope.includeFlows !== false;
  const includeBudgets = scope.includeBudgets === true;
  const skipBudgets = filtered && kind !== "budget_scenario";

  const [gateRows, documentRows, budgetRows] = await Promise.all([
    includeFlows
      ? worklistGates(orgId, userId, scope.roles, scope.allowedSubsidiaryIds, { prefix, kind, query, overdue })
      : Promise.resolve([]),
    includeFlows && !overdue
      ? worklistDocuments(orgId, userId, scope.allowedSubsidiaryIds, { prefix, kind, query })
      : Promise.resolve([]),
    includeBudgets && !skipBudgets && !overdue
      ? worklistBudgets(orgId, userId, { prefix, kind, query })
      : Promise.resolve([]),
  ]);
  const [gateCounts, documentCounts, budgetCount] = await worklistCounts(orgId, userId, scope, { kind, query, overdue });
  // Kind chips ignore the kind filter (same as the unpaged page), so a
  // filtered read re-runs the aggregates unpredicated for the chips.
  const [chipGateCounts, chipDocumentCounts, chipBudgetCount] = filtered
    ? await Promise.all([
        includeFlows
          ? worklistGateKindCounts(orgId, userId, scope.roles, scope.allowedSubsidiaryIds, undefined, query, overdue)
          : Promise.resolve(new Map<string, number>()),
        includeFlows && !overdue
          ? worklistDocumentKindCounts(orgId, userId, scope.allowedSubsidiaryIds, undefined, query)
          : Promise.resolve(new Map<string, number>()),
        includeBudgets && !overdue ? worklistBudgetCount(orgId, userId, undefined, query) : Promise.resolve(0),
      ])
    : [gateCounts, documentCounts, budgetCount];

  const merged: UnifiedApproval[] = [
    ...gateRows.map((gate) => ({ kind: "flow_gate" as const, id: gate.id, gate })),
    ...documentRows.map((document) => ({ kind: "document" as const, id: document.id, document })),
    ...budgetRows.map((budget) => ({ kind: "budget" as const, id: budget.id, budget })),
  ].sort(
    (a, b) =>
      worklistMergeMs(a) - worklistMergeMs(b) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const kindCounts = new Map<string, number>();
  for (const counts of [chipGateCounts, chipDocumentCounts]) {
    for (const [k, v] of counts) kindCounts.set(k, (kindCounts.get(k) ?? 0) + v);
  }
  if (includeBudgets && chipBudgetCount > 0) {
    kindCounts.set("budget_scenario", (kindCounts.get("budget_scenario") ?? 0) + chipBudgetCount);
  }
  return {
    items: merged.slice(page.offset, page.offset + page.limit),
    total: sumKindCounts(gateCounts) + sumKindCounts(documentCounts) + budgetCount,
    kindCounts,
  };
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
      submittedBy: string | null; createdBy: string | null; voidRequested: boolean;
    }>(sql`
      select id, status::text as status, subsidiary_id as "subsidiaryId",
             submitted_by as "submittedBy", created_by as "createdBy",
             (void_requested_at is not null) as "voidRequested"
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
    // The maker stays excluded even when someone else submitted: authorship
    // never rebinds, so a third-party submit can never launder the maker's
    // approval on the direct path either. Same centralized identity set the
    // routed gate path enforces — one predicate, no maker/submitter drift.
    if (sodBlockedIds({ submitterUserId: doc.submittedBy, makerUserId: doc.createdBy }).has(userId)) {
      throw new DocumentApprovalError(
        "the submitter or author cannot approve their own document — route it to another approver",
      );
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
