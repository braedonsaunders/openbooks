import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { listPrebills, loadPrebill, wipAnalytics } from "../wip-billing";
import type { AssistantToolDef, ToolResult } from "./types";
import { dateInput, uuidInput } from "./tools-shared";

/**
 * Subcontract + WIP-billing reads. Subcontracts are vendor-side project
 * commitments (GET `api/subcontracts`: `ap.read` plus the projects AND
 * subcontracts features; every listing scopes to the project subsidiary).
 * WIP prebills reuse the governed library `web/lib/wip-billing.ts`
 * (`listPrebills`, `loadPrebill`, `wipAnalytics`) — the exact services the
 * WIP routes call — under `projects.read` (prebills) and `reports.read`
 * (analytics) plus the wipBilling feature. Customer-side holdback already
 * exists (`retainage_balances`); subcontractor holdback is the payable side.
 */

const money = (v: unknown) => normalizeMoney(v == null ? "0" : String(v));

async function subcontractsEnabled(orgId: string): Promise<boolean> {
  const [projects, subcontracts] = await Promise.all([
    isFeatureEnabled(orgId, "projects"),
    isFeatureEnabled(orgId, "subcontracts"),
  ]);
  return projects && subcontracts;
}

async function wipBillingEnabled(orgId: string): Promise<boolean> {
  const [projects, wip] = await Promise.all([
    isFeatureEnabled(orgId, "projects"),
    isFeatureEnabled(orgId, "wipBilling"),
  ]);
  return projects && wip;
}

const searchSubcontracts: AssistantToolDef = {
  name: "search_subcontracts",
  description:
    "Search subcontracts by number, title, vendor, project, status: original/revised commitment, billed to date, retainage per contract, plus totals. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["ap.read"] },
  feature: "subcontracts",
  inputSchema: z.object({
    query: z.string().max(100).optional().describe("Match contract number or title"),
    vendorQuery: z.string().max(100).optional().describe("Match the vendor name"),
    projectId: uuidInput.optional(),
    status: z.string().max(40).optional().describe("Contract status, e.g. active, draft"),
    limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await subcontractsEnabled(authz.user.orgId))) {
      return { ok: false, error: "subcontracts_feature_disabled" };
    }
    const a = raw as {
      query?: string;
      vendorQuery?: string;
      projectId?: string;
      status?: string;
      limit?: number;
    };
    const limit = Math.min(a.limit ?? 20, 50);
    const orgId = authz.user.orgId;
    const scope = subsidiaryVisibleFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds);
    let where = sql`s.org_id = ${orgId} ${scope}`;
    if (a.status) where = sql`${where} and s.status = ${a.status}`;
    if (a.projectId) where = sql`${where} and s.project_id = ${a.projectId}`;
    if (a.query) {
      const like = `%${a.query}%`;
      where = sql`${where} and (s.number ilike ${like} or s.title ilike ${like})`;
    }
    if (a.vendorQuery) where = sql`${where} and v.display_name ilike ${`%${a.vendorQuery}%`}`;
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select s.id, s.number, s.title, s.status, s.currency,
             s.original_commitment as "originalCommitment",
             (s.original_commitment + coalesce(changes.approved, 0))::text as "revisedCommitment",
             coalesce(apps.billed, 0)::text as "billedToDate",
             coalesce(apps.retained, 0)::text as "retainageWithheld",
             p.name as "projectName", p.id as "projectId",
             v.display_name as "vendorName", v.id as "vendorId"
        from subcontracts s
        join projects p on p.id = s.project_id and p.org_id = s.org_id
        join parties v on v.id = s.vendor_id and v.org_id = s.org_id
        left join lateral (
          select sum(amount) filter (where status = 'approved') as approved
            from subcontract_change_orders where org_id = s.org_id and subcontract_id = s.id
        ) changes on true
        left join lateral (
          select sum(gross_this_period) filter (where status = 'billed') as billed,
                 sum(retainage_this_period) filter (where status = 'billed') as retained
            from vendor_pay_applications where org_id = s.org_id and subcontract_id = s.id
        ) apps on true
       where ${where}
       order by case s.status when 'active' then 0 when 'pending_approval' then 1 when 'draft' then 2 else 3 end,
                s.number
       limit ${limit}
    `)).rows;
    const totals = (await db.execute<{ n: string; revised: string; billed: string; retained: string }>(sql`
      select count(*) as n,
             coalesce(sum(s.original_commitment + coalesce(changes.approved, 0)), 0) as revised,
             coalesce(sum(coalesce(apps.billed, 0)), 0) as billed,
             coalesce(sum(coalesce(apps.retained, 0)), 0) as retained
        from subcontracts s
        join projects p on p.id = s.project_id and p.org_id = s.org_id
        join parties v on v.id = s.vendor_id and v.org_id = s.org_id
        left join lateral (
          select sum(amount) filter (where status = 'approved') as approved
            from subcontract_change_orders where org_id = s.org_id and subcontract_id = s.id
        ) changes on true
        left join lateral (
          select sum(gross_this_period) filter (where status = 'billed') as billed,
                 sum(retainage_this_period) filter (where status = 'billed') as retained
            from vendor_pay_applications where org_id = s.org_id and subcontract_id = s.id
        ) apps on true
       where ${where}
    `)).rows[0];
    const total = Number(totals?.n ?? 0);
    return {
      ok: true,
      data: {
        total,
        sumRevisedCommitment: money(totals?.revised),
        sumBilledToDate: money(totals?.billed),
        sumRetainageWithheld: money(totals?.retained),
        returned: rows.length,
        truncated: total > rows.length,
        items: rows.map((r) => ({
          ...r,
          originalCommitment: money(r.originalCommitment),
          revisedCommitment: money(r.revisedCommitment),
          billedToDate: money(r.billedToDate),
          retainageWithheld: money(r.retainageWithheld),
        })),
        href: "/subcontracts",
      },
    };
  },
};

const getSubcontract: AssistantToolDef = {
  name: "get_subcontract",
  description:
    "One subcontract: header, schedule-of-values lines, change orders, pay applications with bill links, payment controls, retainage releases. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ap.read"] },
  feature: "subcontracts",
  inputSchema: z.object({
    id: uuidInput.describe("Subcontract id from search_subcontracts"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await subcontractsEnabled(authz.user.orgId))) {
      return { ok: false, error: "subcontracts_feature_disabled" };
    }
    const a = raw as { id: string };
    const orgId = authz.user.orgId;
    const id = a.id;
    const contract = (await db.execute<Record<string, unknown>>(sql`
      select s.id, s.number, s.title, s.description, s.status, s.currency, p.subsidiary_id as "projectSubsidiaryId",
             s.project_id as "projectId", p.name as "projectName", s.vendor_id as "vendorId", v.display_name as "vendorName",
             s.original_commitment as "originalCommitment", s.default_retainage_percent as "defaultRetainagePercent",
             s.purchase_order_id as "purchaseOrderId", s.starts_on as "startsOn", s.ends_on as "endsOn",
             s.payment_hold_reason as "paymentHoldReason", s.submitted_at as "submittedAt", s.approved_at as "approvedAt",
             (s.original_commitment + coalesce(ch.approved, 0))::text as "revisedCommitment"
        from subcontracts s join projects p on p.id = s.project_id and p.org_id = s.org_id
        join parties v on v.id = s.vendor_id and v.org_id = s.org_id
        left join lateral (select sum(amount) filter (where status = 'approved') as approved
          from subcontract_change_orders where org_id = s.org_id and subcontract_id = s.id) ch on true
       where s.org_id = ${orgId} and s.id = ${id}
    `));
    if (!contract.rows[0]) return { ok: false, error: "not found" };
    const { projectSubsidiaryId, ...subcontract } = contract.rows[0] as Record<string, unknown> & { projectSubsidiaryId: string | null };
    // A subcontract on a project outside the caller's scope is a missing one.
    if (authz.allowedSubsidiaryIds && !authz.allowedSubsidiaryIds.has(String(projectSubsidiaryId))) {
      return { ok: false, error: "not found" };
    }
    const [sov, changes, applications, lines, controls, releases] = await Promise.all([
      db.execute(sql`
        select l.id, l.item_no as "itemNo", l.description, l.scheduled_value as "scheduledValue",
               l.retainage_percent as "retainagePercent", l.expense_account_id as "expenseAccountId",
               l.change_order_id as "changeOrderId", l.sort_order as "sortOrder",
               coalesce(earned.earned, 0)::text as "earnedToDate"
          from subcontract_sov_lines l
          left join lateral (
            select vpal.previous_earned + vpal.work_completed_this_period + vpal.materials_stored_current - vpal.previous_materials_stored as earned
              from vendor_pay_application_lines vpal join vendor_pay_applications vpa on vpa.id = vpal.pay_application_id and vpa.org_id = vpal.org_id
             where vpal.org_id = l.org_id and vpal.sov_line_id = l.id and vpa.status = 'billed'
             order by vpa.application_number desc limit 1
          ) earned on true
         where l.org_id = ${orgId} and l.subcontract_id = ${id} order by l.sort_order, l.item_no
      `),
      db.execute(sql`
        select id, number, description, status, amount, target_sov_line_id as "targetSovLineId",
               approved_on as "approvedOn"
          from subcontract_change_orders where org_id = ${orgId} and subcontract_id = ${id} order by created_at desc
      `),
      db.execute(sql`
        select a.id, a.application_number as "applicationNumber", a.period_end as "periodEnd",
               a.vendor_invoice_number as "vendorInvoiceNumber", a.status,
               a.gross_this_period as "grossThisPeriod", a.retainage_this_period as "retainageThisPeriod", a.net_due as "netDue",
               a.vendor_bill_document_id as "vendorBillDocumentId", d.document_number as "vendorBillNumber", d.status as "vendorBillStatus"
          from vendor_pay_applications a left join documents d on d.id = a.vendor_bill_document_id and d.org_id = a.org_id
         where a.org_id = ${orgId} and a.subcontract_id = ${id} order by a.application_number desc
      `),
      db.execute(sql`
        select l.pay_application_id as "payApplicationId", l.sov_line_id as "sovLineId", sov.item_no as "itemNo", sov.description,
               sov.scheduled_value as "scheduledValue", l.previous_earned as "previousEarned",
               l.previous_materials_stored as "previousMaterialsStored", l.work_completed_this_period as "workCompletedThisPeriod",
               l.materials_stored_current as "materialsStoredCurrent", l.retainage_percent as "retainagePercent"
          from vendor_pay_application_lines l join vendor_pay_applications app on app.id = l.pay_application_id and app.org_id = l.org_id
          join subcontract_sov_lines sov on sov.id = l.sov_line_id and sov.org_id = l.org_id
         where l.org_id = ${orgId} and app.subcontract_id = ${id} order by app.application_number desc, sov.sort_order
      `),
      db.execute(sql`
        select c.id, c.control_type as "controlType", c.status, c.pay_application_id as "payApplicationId",
               c.vendor_bill_document_id as "vendorBillDocumentId", c.joint_payee_party_id as "jointPayeePartyId",
               p.display_name as "jointPayeeName", c.amount_limit as "amountLimit", c.reason,
               c.effective_on as "effectiveOn", c.expires_on as "expiresOn", c.release_reason as "releaseReason"
          from subcontract_payment_controls c left join parties p on p.id = c.joint_payee_party_id and p.org_id = c.org_id
         where c.org_id = ${orgId} and c.subcontract_id = ${id} order by c.created_at desc
      `),
      db.execute(sql`
        select r.id, r.period_end as "periodEnd", r.amount, r.vendor_bill_document_id as "vendorBillDocumentId",
               d.document_number as "vendorBillNumber", d.status as "vendorBillStatus", r.memo
          from vendor_retainage_releases r join documents d on d.id = r.vendor_bill_document_id and d.org_id = r.org_id
         where r.org_id = ${orgId} and r.subcontract_id = ${id} order by r.period_end desc
      `),
    ]);
    const moneyKeys = new Set([
      "originalCommitment", "revisedCommitment", "scheduledValue", "earnedToDate", "amount",
      "grossThisPeriod", "retainageThisPeriod", "netDue", "previousEarned", "previousMaterialsStored",
      "workCompletedThisPeriod", "materialsStoredCurrent", "amountLimit",
    ]);
    const monetize = (row: Record<string, unknown>) => {
      const out: Record<string, unknown> = { ...row };
      for (const key of moneyKeys) if (key in out) out[key] = money(out[key]);
      return out;
    };
    return {
      ok: true,
      data: {
        subcontract: monetize(subcontract as Record<string, unknown>),
        sovLines: sov.rows.map((r) => monetize(r as Record<string, unknown>)),
        changeOrders: changes.rows.map((r) => monetize(r as Record<string, unknown>)),
        payApplications: applications.rows.map((r) => monetize(r as Record<string, unknown>)),
        payApplicationLines: lines.rows.map((r) => monetize(r as Record<string, unknown>)),
        paymentControls: controls.rows.map((r) => monetize(r as Record<string, unknown>)),
        retainageReleases: releases.rows.map((r) => monetize(r as Record<string, unknown>)),
        href: "/subcontracts",
      },
    };
  },
};

const listWipPrebills: AssistantToolDef = {
  name: "list_wip_prebills",
  description:
    "WIP and prebilling worksheets by project: status, original/proposed/adjustment bill amounts, cost, and the converted invoice link. Same rows the WIP workspace lists. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["projects.read"] },
  feature: "wipBilling",
  inputSchema: z.object({
    projectId: uuidInput.optional().describe("Restrict to one project"),
    limit: z.number().int().min(1).max(100).optional().describe("Default 25"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await wipBillingEnabled(authz.user.orgId))) {
      return { ok: false, error: "wipBilling_feature_disabled" };
    }
    const a = raw as { projectId?: string; limit?: number };
    const limit = Math.min(a.limit ?? 25, 100);
    const rows = await listPrebills(authz.user.orgId, a.projectId, authz.allowedSubsidiaryIds);
    const monetize = (r: Record<string, unknown>) => ({
      ...r,
      originalBillAmount: money(r.originalBillAmount),
      proposedBillAmount: money(r.proposedBillAmount),
      costAmount: money(r.costAmount),
      adjustmentAmount: money(r.adjustmentAmount),
    });
    return {
      ok: true,
      data: {
        total: rows.length,
        returned: Math.min(rows.length, limit),
        truncated: rows.length > limit,
        items: rows.slice(0, limit).map((r) => monetize(r as unknown as Record<string, unknown>)),
        href: "/projects/wip-billing",
      },
    };
  },
};

const getWipPrebill: AssistantToolDef = {
  name: "get_wip_prebill",
  description:
    "One WIP worksheet by id: header, cost/billing lines with holds and adjustments, lifecycle events, and submission/approval/conversion state. Same payload the WIP drawer renders. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["projects.read"] },
  feature: "wipBilling",
  inputSchema: z.object({
    id: uuidInput.describe("Worksheet id from list_wip_prebills"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await wipBillingEnabled(authz.user.orgId))) {
      return { ok: false, error: "wipBilling_feature_disabled" };
    }
    const a = raw as { id: string };
    const detail = await loadPrebill(authz.user.orgId, a.id, authz.allowedSubsidiaryIds);
    if (!detail) return { ok: false, error: "not found" };
    const d = detail as unknown as Record<string, unknown>;
    return {
      ok: true,
      data: {
        ...d,
        originalBillAmount: money(d.originalBillAmount),
        proposedBillAmount: money(d.proposedBillAmount),
        costAmount: money(d.costAmount),
        adjustmentAmount: money(d.adjustmentAmount),
        lines: ((d.lines ?? []) as Record<string, unknown>[]).map((l) => ({
          ...l,
          costAmount: money(l.costAmount),
          originalBillAmount: money(l.originalBillAmount),
          proposedBillAmount: money(l.proposedBillAmount),
          adjustmentAmount: money(l.adjustmentAmount),
        })),
        href: "/projects/wip-billing",
      },
    };
  },
};

const wipAnalyticsTool: AssistantToolDef = {
  name: "wip_analytics",
  description:
    "WIP health analytics as of a date: unbilled aging buckets, held amounts, billed-vs-original realization, write-downs, and long-held WIP. Same figures the WIP analytics route returns. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  feature: "wipBilling",
  inputSchema: z.object({
    asOf: dateInput.optional().describe("Default today"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await wipBillingEnabled(authz.user.orgId))) {
      return { ok: false, error: "wipBilling_feature_disabled" };
    }
    const a = raw as { asOf?: string };
    try {
      const analytics = await wipAnalytics(authz.user.orgId, a.asOf, authz.allowedSubsidiaryIds);
      return { ok: true, data: { ...analytics, href: "/projects/wip-billing" } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "tool_failed" };
    }
  },
};

export const SUBCONTRACTS_TOOLS: AssistantToolDef[] = [
  searchSubcontracts,
  getSubcontract,
  listWipPrebills,
  getWipPrebill,
  wipAnalyticsTool,
];
