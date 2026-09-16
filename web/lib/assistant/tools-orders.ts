import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { loadOrder } from "../../app/api/_order/lib";
import {
  billableRemainderQuantityUnits,
  fromQuantityUnits,
  toQuantityUnits,
} from "../order-cycle-math";
import type { AssistantToolDef, ToolResult } from "./types";
import { dateInput, uuidInput } from "./tools-shared";

/**
 * Quote / sales-order / purchase-order reads. Orders are non-posting
 * commitment documents (`documents` with kind quote/sales_order/purchase_order;
 * `web/lib/order-cycle.ts`). The drawer payload comes from `loadOrder` in
 * `web/app/api/_order/lib.ts` — the exact service the order screens render —
 * and quantity math reuses `web/lib/order-cycle-math.ts` so remainders never
 * cross the floating-point boundary. Generic kind/status search already exists
 * (`find_documents`); these tools add fulfilment/billing state, line-level
 * remainders, the document-links graph, and backlog totals.
 */

const money = (v: unknown) => normalizeMoney(v == null ? "0" : String(v));

const ORDER_KINDS = ["quote", "sales_order", "purchase_order"] as const;
type OrderKind = (typeof ORDER_KINDS)[number];

/** Sales-side orders need ar.read; purchase orders need ap.read — same split
 *  the _order handlers enforce (readPerm ar.read vs ap.read). */
function kindPerm(kind: OrderKind): string {
  return kind === "purchase_order" ? "ap.read" : "ar.read";
}

function fulfilmentStatus(ordered: bigint, fulfilled: bigint): string {
  if (fulfilled <= 0n) return "unfulfilled";
  if (fulfilled < ordered) return "partially_fulfilled";
  return "fulfilled";
}

function billingStatus(ordered: bigint, billed: bigint): string {
  if (billed <= 0n) return "unbilled";
  if (billed < ordered) return "partially_billed";
  return "billed";
}

const searchOrders: AssistantToolDef = {
  name: "search_orders",
  description:
    "Search quotes, sales orders, and purchase orders by kind, status, party, or date, with per-order fulfilment and billing state (unfulfilled/partial/fulfilled, unbilled/partial/billed) plus backlog totals over ALL matches. For generic document search use find_documents. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["ar.read", "ap.read"] },
  feature: "orders",
  inputSchema: z.object({
    kind: z.enum(ORDER_KINDS).optional().describe("Default all kinds the caller may see"),
    status: z.enum(["draft", "pending_approval", "approved", "posted", "voided"]).optional(),
    partyQuery: z.string().max(100).optional().describe("Match the customer/vendor name"),
    query: z.string().max(100).optional().describe("Match document number or memo"),
    fromDate: dateInput.optional(),
    toDate: dateInput.optional(),
    fulfilment: z.enum(["unfulfilled", "partially_fulfilled", "fulfilled"]).optional(),
    billing: z.enum(["unbilled", "partially_billed", "billed"]).optional(),
    limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "orders"))) {
      return { ok: false, error: "orders_feature_disabled" };
    }
    const a = raw as {
      kind?: OrderKind;
      status?: string;
      partyQuery?: string;
      query?: string;
      fromDate?: string;
      toDate?: string;
      fulfilment?: string;
      billing?: string;
      limit?: number;
    };
    const visibleKinds = ORDER_KINDS.filter((k) => can(authz, kindPerm(k)));
    if (visibleKinds.length === 0) return { ok: false, error: "forbidden" };
    const kinds = a.kind ? [a.kind] : visibleKinds;
    if (a.kind && !can(authz, kindPerm(a.kind))) return { ok: false, error: "forbidden" };
    const limit = Math.min(a.limit ?? 20, 50);
    const scope = subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds);
    let where = sql`d.org_id = ${authz.user.orgId} and d.kind in ${kinds} ${scope}`;
    if (a.status) where = sql`${where} and d.status = ${a.status}`;
    if (a.query) {
      const like = `%${a.query}%`;
      where = sql`${where} and (d.document_number ilike ${like} or d.memo ilike ${like})`;
    }
    if (a.partyQuery) where = sql`${where} and p.display_name ilike ${`%${a.partyQuery}%`}`;
    if (a.fromDate) where = sql`${where} and d.document_date >= ${a.fromDate}`;
    if (a.toDate) where = sql`${where} and d.document_date <= ${a.toDate}`;
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select d.id, d.kind, d.document_number, d.document_date, d.status, d.currency,
             d.total, d.memo, p.display_name as party,
             coalesce(sum(l.quantity), 0) as ordered,
             coalesce(sum(l.quantity_fulfilled), 0) as fulfilled,
             coalesce(sum(l.quantity_billed), 0) as billed
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
        left join document_lines l on l.document_id = d.id and l.org_id = d.org_id
       where ${where}
       group by d.id, d.kind, d.document_number, d.document_date, d.status,
                d.currency, d.total, d.memo, p.display_name
       order by d.document_date desc, d.document_number desc
       limit ${limit}
    `)).rows;
    const totals = (await db.execute<{ n: string; sum_total: string; backlog: string }>(sql`
      select count(*) as n, coalesce(sum(d.total), 0) as sum_total,
             coalesce(sum(case when d.status = 'approved' then d.total else 0 end), 0) as backlog
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
       where ${where}
    `)).rows[0];
    const total = Number(totals?.n ?? 0);
    let items = rows.map((r) => {
      const ordered = toQuantityUnits(String(r.ordered ?? "0"));
      const fulfilled = toQuantityUnits(String(r.fulfilled ?? "0"));
      const billed = toQuantityUnits(String(r.billed ?? "0"));
      return {
        id: r.id,
        kind: r.kind,
        documentNumber: r.document_number,
        documentDate: r.document_date,
        status: r.status,
        currency: r.currency,
        total: money(r.total),
        party: r.party,
        fulfilment: fulfilmentStatus(ordered, fulfilled),
        billing: billingStatus(ordered, billed),
        memo: typeof r.memo === "string" && r.memo.length > 160 ? `${r.memo.slice(0, 160)}…[truncated]` : (r.memo as string | null),
        href: r.kind === "purchase_order" ? "/purchase-orders" : "/sales-orders",
      };
    });
    if (a.fulfilment) items = items.filter((i) => i.fulfilment === a.fulfilment);
    if (a.billing) items = items.filter((i) => i.billing === a.billing);
    return {
      ok: true,
      data: {
        total,
        sumTotal: money(totals?.sum_total),
        backlogTotal: money(totals?.backlog),
        backlogNote: "Sum of document totals over ALL matches still in approved (committed, not yet invoiced) status.",
        returned: items.length,
        truncated: total > rows.length,
        items,
      },
    };
  },
};

const getOrder: AssistantToolDef = {
  name: "get_order",
  description:
    "One quote, sales order, or purchase order by id: header, lines with ordered/fulfilled/billed/remaining quantities, and the links graph (created-from, converted-into, fulfilments, receipts, invoices). Same payload the order drawer renders. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read", "ap.read"] },
  feature: "orders",
  inputSchema: z.object({
    kind: z.enum(ORDER_KINDS).describe("quote, sales_order, or purchase_order"),
    id: uuidInput.describe("Order id from search_orders"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "orders"))) {
      return { ok: false, error: "orders_feature_disabled" };
    }
    const a = raw as { kind: OrderKind; id: string };
    if (!can(authz, kindPerm(a.kind))) return { ok: false, error: "forbidden" };
    const payload = await loadOrder(a.id, authz.user.orgId, a.kind, authz.allowedSubsidiaryIds);
    if (!payload) return { ok: false, error: "not found" };
    const fulfil = (await db.execute<{ id: string; quantity: string; quantity_fulfilled: string; quantity_billed: string }>(sql`
      select l.id, l.quantity::text as quantity,
             coalesce(l.quantity_fulfilled, 0)::text as quantity_fulfilled,
             coalesce(l.quantity_billed, 0)::text as quantity_billed
        from document_lines l
       where l.document_id = ${a.id} and l.org_id = ${authz.user.orgId}
    `)).rows;
    const fulfilById = new Map(fulfil.map((f) => [f.id, f]));
    const doc = payload.doc as Record<string, unknown>;
    const lines = (payload.lines as Record<string, unknown>[]).map((l) => {
      const f = fulfilById.get(l.id as string);
      const ordered = String(f?.quantity ?? l.quantity ?? "0");
      const fulfilled = String(f?.quantity_fulfilled ?? "0");
      const billed = String(f?.quantity_billed ?? l.quantity_billed ?? "0");
      const remaining = billableRemainderQuantityUnits({
        orderedQuantity: ordered,
        billedQuantity: billed,
        fulfilledQuantity: fulfilled,
        requiresReceipt: a.kind === "purchase_order",
      });
      return {
        ...l,
        amount: money(l.amount),
        unit_price: money(l.unit_price),
        tax_amount: money(l.tax_amount),
        quantityFulfilled: fromQuantityUnits(toQuantityUnits(fulfilled)),
        quantityBilled: fromQuantityUnits(toQuantityUnits(billed)),
        remainingBillable: fromQuantityUnits(remaining),
        fulfilment: fulfilmentStatus(toQuantityUnits(ordered), toQuantityUnits(fulfilled)),
      };
    });
    return {
      ok: true,
      data: {
        header: { ...doc, subtotal: money(doc.subtotal), tax_total: money(doc.tax_total), total: money(doc.total), open_balance: money(doc.open_balance) },
        lines,
        links: payload.links,
        href: a.kind === "purchase_order" ? "/purchase-orders" : "/sales-orders",
      },
    };
  },
};

export const ORDERS_TOOLS: AssistantToolDef[] = [searchOrders, getOrder];
