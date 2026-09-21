import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isFeatureEnabled } from "../features";
import { can } from "../authz";
import { approvalWorklistForAuthz } from "../application/approvals";
import { expensesDashboard } from "../expenses-dashboard";
import { loadExpenseReport } from "../expenses";
import type { AssistantToolDef, ToolResult } from "./types";
import { truncateText } from "./types";
import { dateInput, uuidInput, num, capList } from "./tools-shared";

/**
 * Expense-report read/search tools for the agentic assistant. Every tool
 * carries the same `expenses.read` gate and `expenses` feature flag as the
 * expense routes, with the strict subsidiary boundary the detail route
 * enforces (a report outside the caller's legal-entity scope — including one
 * with no subsidiary assigned — reads as missing for restricted callers).
 *
 * Detail reads reuse the exact loader the drawer and routes call
 * (`loadExpenseReport`); the hub readout reuses `expensesDashboard`; the
 * approvals queue reuses the application worklist filtered to expense
 * reports. A caller with no approval doorway sees an empty queue, exactly
 * like the approvals hub. Reimbursement state is read from the report's
 * status and open balance — the same open-item facts the ledger shows.
 */

const FEATURE_ERROR = "expenses_feature_disabled";

async function featureOff(orgId: string): Promise<boolean> {
  return !(await isFeatureEnabled(orgId, "expenses"));
}

/** Strict document boundary mirroring GET /api/expenses/[id]. */
function reportScope(allowed: ReadonlySet<string> | null): ReturnType<typeof sql> {
  if (allowed === null) return sql``;
  if (allowed.size === 0) return sql` and false`;
  return sql` and d.subsidiary_id = any(${`{${[...allowed].join(",")}}`}::uuid[])`;
}

const listExpenseReportsSchema = z.object({
  query: z.string().max(100).optional().describe("Substring over report number or employee name"),
  employeePartyId: uuidInput.optional().describe("Employee party id; omit for every employee"),
  status: z.enum(["draft", "pending_approval", "approved", "posted"]).optional().describe("Report status; omit for every status"),
  dateFrom: dateInput.optional().describe("Report date on/after; omit for no lower bound"),
  dateTo: dateInput.optional().describe("Report date on/before; omit for no upper bound"),
  includeVoided: z.boolean().optional().describe("True = include voided reports (default false)"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50); aggregates always cover ALL matches"),
});

const listExpenseReports: AssistantToolDef = {
  name: "list_expense_reports",
  description:
    "List expense reports: number, employee, date, status, totals, and open (unreimbursed) balance. Returns a capped page plus counts and totals by status over ALL matches. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["expenses.read"] },
  feature: "expenses",
  inputSchema: listExpenseReportsSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as z.infer<typeof listExpenseReportsSchema>;
    const limit = Math.min(a.limit ?? 50, 200);
    const like = a.query ? `%${a.query}%` : null;
    const filters = sql.join(
      [
        like ? sql` and (d.document_number ilike ${like} or p.display_name ilike ${like})` : sql``,
        a.employeePartyId ? sql` and d.party_id = ${a.employeePartyId}` : sql``,
        a.status ? sql` and d.status = ${a.status}` : sql``,
        a.dateFrom ? sql` and d.document_date >= ${a.dateFrom}::date` : sql``,
        a.dateTo ? sql` and d.document_date <= ${a.dateTo}::date` : sql``,
        a.includeVoided ? sql`` : sql` and d.voided_at is null`,
      ],
      sql``,
    );
    const scope = reportScope(authz.allowedSubsidiaryIds);
    const [page, byStatus] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select d.id, d.document_number, d.document_date::text as document_date, d.status,
               d.currency, d.total, d.open_balance as open_balance,
               d.posting_date::text as posting_date, d.voided_at,
               p.display_name as employee_name
          from documents d
          left join parties p on p.id = d.party_id and p.org_id = d.org_id
         where d.org_id = ${authz.user.orgId} and d.kind = 'expense_report'${filters}${scope}
         order by d.document_date desc, d.created_at desc
         limit ${limit}
      `),
      db.execute<Record<string, unknown>>(sql`
        select d.status, d.currency, count(*)::int as count,
               coalesce(sum(d.total), 0)::text as total,
               coalesce(sum(d.open_balance), 0)::text as open_balance
          from documents d
          left join parties p on p.id = d.party_id and p.org_id = d.org_id
         where d.org_id = ${authz.user.orgId} and d.kind = 'expense_report'${filters}${scope}
         group by d.status, d.currency order by d.status, d.currency
      `),
    ]);
    const capped = capList(
      page.rows.map((r) => ({
        reportId: r.id,
        documentNumber: r.document_number,
        documentDate: r.document_date,
        status: r.status,
        employeeName: r.employee_name,
        currency: r.currency,
        total: num(r.total),
        openBalance: num(r.open_balance),
        reimbursed: r.status === "posted" && Number(r.open_balance ?? 0) === 0,
        postingDate: r.posting_date,
        voided: r.voided_at != null,
      })),
      limit,
    );
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        total: byStatus.rows.reduce((n, r) => n + Number(r.count ?? 0), 0),
        truncated: capped.truncated,
        reports: capped.items,
        byStatus: byStatus.rows.map((r) => ({
          status: r.status,
          currency: r.currency,
          count: Number(r.count ?? 0),
          total: num(r.total),
          openBalance: num(r.open_balance),
        })),
        href: "/expenses/reports",
      },
    };
  },
};

const getExpenseReport: AssistantToolDef = {
  name: "get_expense_report",
  description:
    "One expense report's full detail: header facts, approval and reimbursement state, and every line with account, tax, project, and custom dimensions — the same record the report drawer shows. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["expenses.read"] },
  feature: "expenses",
  inputSchema: z.object({ reportId: uuidInput.describe("Report id from list_expense_reports") }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as { reportId: string };
    // loadExpenseReport is the drawer/route loader; the route's strict
    // subsidiary guard is applied here so an out-of-scope report reads as
    // missing, exactly like the route.
    const loaded = await loadExpenseReport(a.reportId, authz.user.orgId);
    const doc = loaded?.doc as Record<string, unknown> | undefined;
    if (!doc || (authz.allowedSubsidiaryIds !== null
      && (doc.subsidiary_id == null || !authz.allowedSubsidiaryIds.has(String(doc.subsidiary_id))))) {
      return { ok: false, error: "expense_report_not_found" };
    }
    const lines = capList(
      (loaded!.lines as Record<string, unknown>[]).map((l) => ({
        lineNumber: l.line_number,
        accountId: l.account_id,
        description: l.description == null ? null : truncateText(String(l.description), 200),
        amount: num(l.amount),
        // Who fronted the money (0171); null = settlement not recorded (history).
        settlementType: (l.settlement_type as string | null) ?? null,
        taxCodeId: l.tax_code_id,
        taxGroupId: l.tax_group_id,
        taxAmount: l.tax_amount == null ? null : num(l.tax_amount),
        departmentId: l.department_id,
        projectId: l.project_id,
        locationId: l.location_id,
        classId: l.class_id,
      })),
      100,
    );
    return {
      ok: true,
      data: {
        report: {
          reportId: doc.id,
          documentNumber: doc.document_number,
          documentDate: doc.document_date,
          status: doc.status,
          employeePartyId: doc.party_id,
          employeeName: doc.employee_name,
          currency: doc.currency,
          subtotal: num(doc.subtotal),
          taxTotal: num(doc.tax_total),
          total: num(doc.total),
          openBalance: num(doc.open_balance),
          reimbursed: doc.status === "posted" && Number(doc.open_balance ?? 0) === 0,
          postingDate: doc.posting_date,
          postedEntryId: doc.posted_entry_id,
          memo: doc.memo == null ? null : truncateText(String(doc.memo), 500),
        },
        lines: lines.items,
        linesTruncated: lines.truncated,
        href: `/expenses/reports?expense=${a.reportId}`,
      },
    };
  },
};

const expenseOverview: AssistantToolDef = {
  name: "expense_overview",
  description:
    "Expense hub readout: approval pipeline, spend summary, top spenders, category movement, trends, oldest queue. Same dashboard as expenses home. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["expenses.read"] },
  feature: "expenses",
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    // expensesDashboard is the expenses home loader: same queries, same
    // org-wide population, same expenses.read gate as the screen.
    const dashboard = await expensesDashboard(authz.user.orgId);
    return { ok: true, data: { ...dashboard, href: "/expenses" } };
  },
};

const expenseApprovals: AssistantToolDef = {
  name: "expense_approvals",
  description:
    "Expense reports awaiting the caller's decision: amounts, submitters, flow gates. No doorway sees an empty queue. Decisions stay human. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["expenses.read"] },
  feature: "expenses",
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    // The approvals hub doorway: without any approve permission the worklist
    // is empty rather than forbidden.
    if (!can(authz, "flows.approve") && !can(authz, "ap.approve") && !can(authz, "ar.approve")) {
      return { ok: true, data: { returned: 0, total: 0, approvals: [], href: "/inbox" } };
    }
    let items: Awaited<ReturnType<typeof approvalWorklistForAuthz>> = [];
    try {
      items = await approvalWorklistForAuthz(authz);
    } catch {
      return { ok: true, data: { returned: 0, total: 0, approvals: [], href: "/inbox" } };
    }
    const approvals: Record<string, unknown>[] = [];
    for (const item of items) {
      if (item.kind === "flow_gate") {
        if (item.subjectKind !== "expense_report") continue;
        approvals.push({
          kind: "flow_gate",
          gateId: item.id,
          title: item.title,
          quorum: item.quorum,
          assigneeUserId: item.assigneeUserId,
          assigneeRole: item.assigneeRole,
          signatureRequired: item.signatureRequired,
        });
      } else if (item.kind === "document") {
        if (item.docKind !== "expense_report") continue;
        approvals.push({
          kind: "document",
          documentId: item.id,
          documentNumber: item.documentNumber,
          status: item.status,
          currency: item.currency,
          total: num(item.total),
          documentDate: item.documentDate,
          employeeName: item.partyName,
          submittedBy: item.submittedBy,
          submittedAt: item.submittedAt,
        });
      }
    }
    const capped = capList(approvals, 50);
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        total: approvals.length,
        truncated: capped.truncated,
        approvals: capped.items,
        href: "/inbox",
      },
    };
  },
};

export const EXPENSE_TOOLS: AssistantToolDef[] = [
  listExpenseReports,
  getExpenseReport,
  expenseOverview,
  expenseApprovals,
];
