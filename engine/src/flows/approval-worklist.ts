import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  gateDecisionCapability,
  gateSubsidiaryScopeAllows,
  sodBlockedIds,
  worklistGateKindCounts,
  worklistGates,
  type GateSubsidiaryScope,
  type WorklistAudience,
  type WorklistGate,
} from "./gates.ts";
import {
  DIRECT_TIMESHEET_UNION_KIND,
  worklistDirectTimesheetCount,
  worklistDirectTimesheets,
  type DirectTimesheetWeek,
} from "./timesheet-direct.ts";

export type { WorklistAudience } from "./gates.ts";

/**
 * The unified approvals worklist. Flows gates are only one approval
 * mechanism: documents sitting in `pending_approval` with no pending gate
 * (migrated rows, abandoned runs, legacy direct writes), budget scenarios
 * in `pending_approval` submitted through the direct maker/checker path, and
 * gateless submitted timesheet weeks are invisible to worklistGates, so an
 * approver would see an empty worklist while work waits. This reader returns
 * every thing awaiting the caller — pending gates AND gateless document
 * approvals AND pending budgets AND direct timesheet approvals — with one
 * row per actionable item. Payment runs approve through their Flows gates and
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
 *
 * The paged reader also serves the organization audience — the oversight
 * view of every pending, live item in the organization, whoever it is
 * assigned to or submitted by. It reads the same legs through the same
 * liveness, legal-entity, kind, search and overdue predicates; only the
 * assignee condition and the own-submission exclusions are dropped. Whether
 * the viewer may decide a given row is resolved per row by the caller, never
 * implied by its presence in that view.
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

export interface WorklistTimesheet {
  kind: "timesheet";
  /** Week id — the inbox decides it through the native direct-approval path
   * and opens it in the week drawer. */
  id: string;
  employeePartyId: string;
  personName: string | null;
  weekStart: string;
  submittedAt: string | null;
  createdAt: string;
  /** False when separation of duties bars the reader as the week's timekeeper. */
  actorMayApprove: boolean;
}

export type UnifiedApproval =
  | { kind: "flow_gate"; id: string; gate: WorklistGate }
  | { kind: "document"; id: string; document: WorklistDocument }
  | { kind: "budget"; id: string; budget: WorklistBudget }
  | { kind: "timesheet"; id: string; timesheet: WorklistTimesheet };

export interface WorklistScope {
  roles?: Iterable<string>;
  allowedSubsidiaryIds?: GateSubsidiaryScope;
  /**
   * The caller holds the budgets.approve grant. Pending budget scenarios
   * stay out of the worklist without it.
   */
  includeBudgets?: boolean;
  /**
   * The caller holds time.approve with Time Tracking on. Gateless submitted
   * weeks stay out of the worklist without it.
   */
  includeTimesheets?: boolean;
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
  documentId?: string;
  kind?: string;
  query?: string;
  audience?: WorklistAudience;
}

function worklistDocumentWhere(
  orgId: string,
  userId: string,
  allowedSubsidiaryIds: GateSubsidiaryScope,
  kind?: string,
  query?: string,
  audience?: WorklistAudience,
  documentId?: string,
): SQL {
  const needle = query?.trim().toLowerCase()
  return sql`d.org_id = ${orgId} and d.status = 'pending_approval'
    and d.void_requested_at is null
    ${audience === "organization" ? sql`` : sql`and (d.submitted_by is null or d.submitted_by <> ${userId})
    and (d.created_by is null or d.created_by <> ${userId})`}
    and not exists (
      select 1 from flow_gates g
       where g.org_id = d.org_id and g.subject_id = d.id and g.status = 'pending'
    )
    ${subsidiaryScopeSql("d", allowedSubsidiaryIds)}
    ${documentId ? sql`and d.id = ${documentId}::uuid` : sql``}
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
     where ${worklistDocumentWhere(orgId, userId, allowedSubsidiaryIds, opts?.kind, opts?.query, opts?.audience, opts?.documentId)}
     order by coalesce(d.submitted_at, d.created_at), d.id
     ${opts?.prefix != null ? sql`limit ${opts.prefix}` : sql``}`)).rows;
  return rows
    .filter((row) => scopeAllows(allowedSubsidiaryIds, row.subsidiaryId))
    .map((row) => ({ kind: "document" as const, ...row }));
}

export async function worklistDocumentKindCounts(
  orgId: string,
  userId: string,
  allowedSubsidiaryIds: GateSubsidiaryScope,
  kind?: string,
  query?: string,
  audience?: WorklistAudience,
): Promise<Map<string, number>> {
  const rows = (await db.execute<{ kind: string; n: string }>(sql`
    select d.kind as kind, count(*) as n
      from documents d
     where ${worklistDocumentWhere(orgId, userId, allowedSubsidiaryIds, kind, query, audience)}
     group by d.kind`)).rows;
  return new Map(rows.map((row) => [row.kind, Number(row.n)]));
}

/**
 * Gateless budget approvals: scenarios in pending_approval with no pending
 * flow gate. Deliberately unfiltered by subsidiary — the budgets module
 * itself scopes by grant, not by line subsidiary, so the inbox mirrors the
 * drawer the row links to. The submitter never sees their own submission
 * in their own worklist, mirroring the document leg.
 */
function worklistBudgetWhere(orgId: string, userId: string, kind?: string, query?: string, audience?: WorklistAudience): SQL {
  const needle = query?.trim().toLowerCase()
  return sql`bs.org_id = ${orgId} and bs.status = 'pending_approval'
    ${audience === "organization" ? sql`` : sql`and (bs.submitted_by is null or bs.submitted_by <> ${userId})`}
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
     where ${worklistBudgetWhere(orgId, userId, opts?.kind, opts?.query, opts?.audience)}
     group by bs.id
     order by coalesce(bs.submitted_at, bs.created_at), bs.id
     ${opts?.prefix != null ? sql`limit ${opts.prefix}` : sql``}`)).rows;
  return rows.map((row) => ({ kind: "budget" as const, ...row }));
}

async function worklistBudgetCount(orgId: string, userId: string, kind?: string, query?: string, audience?: WorklistAudience): Promise<number> {
  const rows = (await db.execute<{ n: string }>(sql`
    select count(*) as n from (
      select bs.id
        from budget_scenarios bs
       where ${worklistBudgetWhere(orgId, userId, kind, query, audience)}
       group by bs.id
    ) s`)).rows;
  return Number(rows[0]?.n ?? 0);
}

export interface WorklistPageScope extends WorklistScope {
  /** Gate + gateless-document legs ride the flows approval grant. */
  includeFlows?: boolean;
  /**
   * `caller` (the default): the caller's own worklist. `organization`: every
   * pending, live item in the organization inside the caller's legal-entity
   * boundary, whatever its assignee and whoever submitted it.
   */
  audience?: WorklistAudience;
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
  if (item.kind === "timesheet") return +new Date(item.timesheet.submittedAt ?? item.timesheet.createdAt);
  const row = item.kind === "document" ? item.document : item.budget;
  return +new Date(row.submittedAt ?? row.createdAt);
}

function toWorklistTimesheet(week: DirectTimesheetWeek): WorklistTimesheet {
  return {
    kind: "timesheet",
    id: week.id,
    employeePartyId: week.employee_party_id,
    personName: week.person_name,
    weekStart: week.week_start,
    submittedAt: week.submitted_at,
    createdAt: week.created_at,
    actorMayApprove: week.actor_may_approve,
  };
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
): Promise<[Map<string, number>, Map<string, number>, number, number]> {
  const audience = scope.audience ?? "caller";
  return Promise.all([
    scope.includeFlows !== false
      ? worklistGateKindCounts(orgId, userId, scope.roles, scope.allowedSubsidiaryIds, kind, query, overdue, audience)
      : Promise.resolve(new Map<string, number>()),
    scope.includeFlows !== false && !overdue
      ? worklistDocumentKindCounts(orgId, userId, scope.allowedSubsidiaryIds, kind, query, audience)
      : Promise.resolve(new Map<string, number>()),
    scope.includeBudgets === true && (kind == null || kind === "budget_scenario") && !overdue
      ? worklistBudgetCount(orgId, userId, kind, query, audience)
      : Promise.resolve(0),
    scope.includeTimesheets === true && !overdue
      ? worklistDirectTimesheetCount(db, orgId, userId, scope.allowedSubsidiaryIds, kind, query, audience)
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
  const [gates, documents, budgets, timesheets] = await worklistCounts(orgId, userId, scope);
  return sumKindCounts(gates) + sumKindCounts(documents) + budgets + timesheets;
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
  const includeTimesheets = scope.includeTimesheets === true;
  const audience = scope.audience ?? "caller";
  const skipBudgets = filtered && kind !== "budget_scenario";
  const skipTimesheets = filtered && kind !== DIRECT_TIMESHEET_UNION_KIND;

  const [gateRows, documentRows, budgetRows, timesheetRows] = await Promise.all([
    includeFlows
      ? worklistGates(orgId, userId, scope.roles, scope.allowedSubsidiaryIds, { prefix, kind, query, overdue, audience })
      : Promise.resolve([]),
    includeFlows && !overdue
      ? worklistDocuments(orgId, userId, scope.allowedSubsidiaryIds, { prefix, kind, query, audience })
      : Promise.resolve([]),
    includeBudgets && !skipBudgets && !overdue
      ? worklistBudgets(orgId, userId, { prefix, kind, query, audience })
      : Promise.resolve([]),
    includeTimesheets && !skipTimesheets && !overdue
      ? worklistDirectTimesheets(db, orgId, userId, scope.allowedSubsidiaryIds, { prefix, kind, query, audience })
      : Promise.resolve([]),
  ]);
  const [gateCounts, documentCounts, budgetCount, timesheetCount] = await worklistCounts(orgId, userId, scope, { kind, query, overdue });
  // Kind chips ignore the kind filter (same as the unpaged page), so a
  // filtered read re-runs the aggregates unpredicated for the chips.
  const [chipGateCounts, chipDocumentCounts, chipBudgetCount, chipTimesheetCount] = filtered
    ? await Promise.all([
        includeFlows
          ? worklistGateKindCounts(orgId, userId, scope.roles, scope.allowedSubsidiaryIds, undefined, query, overdue, audience)
          : Promise.resolve(new Map<string, number>()),
        includeFlows && !overdue
          ? worklistDocumentKindCounts(orgId, userId, scope.allowedSubsidiaryIds, undefined, query, audience)
          : Promise.resolve(new Map<string, number>()),
        includeBudgets && !overdue ? worklistBudgetCount(orgId, userId, undefined, query, audience) : Promise.resolve(0),
        includeTimesheets && !overdue
          ? worklistDirectTimesheetCount(db, orgId, userId, scope.allowedSubsidiaryIds, undefined, query, audience)
          : Promise.resolve(0),
      ])
    : [gateCounts, documentCounts, budgetCount, timesheetCount];

  const merged: UnifiedApproval[] = [
    ...gateRows.map((gate) => ({ kind: "flow_gate" as const, id: gate.id, gate })),
    ...documentRows.map((document) => ({ kind: "document" as const, id: document.id, document })),
    ...budgetRows.map((budget) => ({ kind: "budget" as const, id: budget.id, budget })),
    ...timesheetRows.map((week) => ({ kind: "timesheet" as const, id: week.id, timesheet: toWorklistTimesheet(week) })),
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
  if (includeTimesheets && chipTimesheetCount > 0) {
    kindCounts.set(DIRECT_TIMESHEET_UNION_KIND, (kindCounts.get(DIRECT_TIMESHEET_UNION_KIND) ?? 0) + chipTimesheetCount);
  }
  return {
    items: merged.slice(page.offset, page.offset + page.limit),
    total: sumKindCounts(gateCounts) + sumKindCounts(documentCounts) + budgetCount + timesheetCount,
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
  if (scope.includeTimesheets) {
    for (const week of await worklistDirectTimesheets(db, orgId, userId, scope.allowedSubsidiaryIds)) {
      out.push({ kind: "timesheet", id: week.id, timesheet: toWorklistTimesheet(week) });
    }
  }
  return out;
}

/** Resolve one gate or gateless document through the approval worklist predicates. */
export async function worklistApprovalById(
  orgId: string,
  userId: string,
  scope: WorklistScope,
  leg: "gate" | "document",
  sourceId: string,
): Promise<UnifiedApproval | null> {
  if (leg === "gate") {
    const gate = (await worklistGates(orgId, userId, scope.roles, scope.allowedSubsidiaryIds, {
      prefix: 1,
      gateId: sourceId,
    }))[0];
    return gate ? { kind: "flow_gate", id: gate.id, gate } : null;
  }
  const document = (await worklistDocuments(orgId, userId, scope.allowedSubsidiaryIds, {
    prefix: 1,
    documentId: sourceId,
  }))[0];
  return document ? { kind: "document", id: document.id, document } : null;
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
