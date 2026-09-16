import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { loadItem } from "../../app/api/items/_lib";
import type { AssistantToolDef, ToolResult } from "./types";
import { dateInput, uuidInput } from "./tools-shared";

/**
 * Item master + inventory reads. The item catalog screen
 * (`web/app/(app)/items`) reads `items` (GET `api/items/[id]` reuses
 * `loadItem` below) and the inventory screens (`web/app/(app)/inventory`,
 * GET `api/inventory/advanced`) read `inventory_movements` scoped to the
 * caller's visible subsidiaries — every tool here applies the same gate
 * (`items.read`) and the same subsidiary filter.
 */

const money = (v: unknown) => normalizeMoney(v == null ? "0" : String(v));

const searchItems: AssistantToolDef = {
  name: "search_items",
  description:
    "Search the item master (goods, services, assemblies) by code, name, kind, or category, with the default rate and active flag. Returns a capped page plus the total count over ALL matches. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["items.read"] },
  inputSchema: z.object({
    query: z.string().max(100).optional().describe("Match item code or name"),
    kind: z.string().max(40).optional().describe("Item kind, e.g. goods, service, assembly"),
    category: z.string().max(100).optional().describe("Item category"),
    includeInactive: z.boolean().optional().describe("Default false (active items only)"),
    limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as {
      query?: string;
      kind?: string;
      category?: string;
      includeInactive?: boolean;
      limit?: number;
    };
    const limit = Math.min(a.limit ?? 20, 50);
    let where = sql`i.org_id = ${authz.user.orgId}`;
    if (!a.includeInactive) where = sql`${where} and i.is_active`;
    if (a.kind) where = sql`${where} and i.kind = ${a.kind}`;
    if (a.category) where = sql`${where} and i.category = ${a.category}`;
    if (a.query) {
      const like = `%${a.query}%`;
      where = sql`${where} and (i.code ilike ${like} or i.name ilike ${like})`;
    }
    const rows = (await db.execute(sql`
      select i.id, i.code, i.name, i.kind, i.category, i.unit,
             i.default_rate as "defaultRate", i.is_active as "isActive"
        from items i
       where ${where}
       order by i.name
       limit ${limit}
    `));
    const total = (await db.execute<{ n: string }>(sql`
      select count(*) as n from items i where ${where}
    `)).rows[0];
    const count = Number(total?.n ?? 0);
    return {
      ok: true,
      data: {
        total: count,
        returned: rows.rows.length,
        truncated: count > rows.rows.length,
        items: rows.rows.map((r) => ({
          ...(r as Record<string, unknown>),
          defaultRate: money((r as Record<string, unknown>).defaultRate),
        })),
        href: "/items",
      },
    };
  },
};

const getItem: AssistantToolDef = {
  name: "get_item",
  description:
    "One item master record by id: kind, category, rates, linked income/expense account and tax code names. Same payload the item catalog drawer renders. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["items.read"] },
  inputSchema: z.object({
    id: uuidInput.describe("Item id from search_items"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { id: string };
    const payload = await loadItem(a.id, authz.user.orgId);
    if (!payload) return { ok: false, error: "not found" };
    const item = payload.item as Record<string, unknown>;
    return {
      ok: true,
      data: {
        ...item,
        default_rate: money(item.default_rate),
        default_cost: money(item.default_cost),
        standalone_selling_price: money(item.standalone_selling_price),
        incomeAccountName: payload.incomeAccountName,
        expenseAccountName: payload.expenseAccountName,
        taxCodeName: payload.taxCodeName,
        href: "/items",
      },
    };
  },
};

const inventoryLevels: AssistantToolDef = {
  name: "inventory_levels",
  description:
    "On-hand stock by item and stock location from posted inventory movements: quantity and value per item/location, with zero-stock rows omitted. Filter by item or location. Returns a capped page plus totals over ALL matches. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["items.read"] },
  feature: "inventory",
  inputSchema: z.object({
    itemId: uuidInput.optional(),
    stockLocationId: uuidInput.optional().describe("Stock location id"),
    limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "inventory"))) {
      return { ok: false, error: "inventory_feature_disabled" };
    }
    const a = raw as { itemId?: string; stockLocationId?: string; limit?: number };
    const limit = Math.min(a.limit ?? 50, 200);
    const scope = subsidiaryVisibleFilter(sql`m.subsidiary_id`, authz.allowedSubsidiaryIds);
    let where = sql`m.org_id = ${authz.user.orgId} and m.status = 'posted' ${scope}`;
    if (a.itemId) where = sql`${where} and m.item_id = ${a.itemId}`;
    if (a.stockLocationId) where = sql`${where} and m.stock_location_id = ${a.stockLocationId}`;
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select i.id as item_id, i.code as item_code, i.name as item_name,
             sl.id as stock_location_id, sl.code as stock_location_code,
             coalesce(sum(m.quantity), 0) as quantity,
             coalesce(sum(m.total_value), 0) as value
        from inventory_movements m
        join items i on i.id = m.item_id and i.org_id = m.org_id
        left join stock_locations sl on sl.id = m.stock_location_id and sl.org_id = m.org_id
       where ${where}
       group by i.id, i.code, i.name, sl.id, sl.code
      having coalesce(sum(m.quantity), 0) <> 0
       order by i.name, sl.code
       limit ${limit}
    `)).rows;
    const totals = (await db.execute<{ lines: string; quantity: string; value: string }>(sql`
      select count(*)::int as lines, coalesce(sum(sub.quantity), 0) as quantity,
             coalesce(sum(sub.value), 0) as value
        from (
          select sum(m.quantity) as quantity, sum(m.total_value) as value
            from inventory_movements m
           where ${where}
           group by m.item_id, m.stock_location_id
          having coalesce(sum(m.quantity), 0) <> 0
        ) sub
    `)).rows[0];
    return {
      ok: true,
      data: {
        total: Number(totals?.lines ?? 0),
        sumQuantity: money(totals?.quantity),
        sumValue: money(totals?.value),
        returned: rows.length,
        truncated: rows.length === limit,
        rows: rows.map((r) => ({ ...r, quantity: money(r.quantity), value: money(r.value) })),
        href: "/inventory",
      },
    };
  },
};

const inventoryMovements: AssistantToolDef = {
  name: "inventory_movements",
  description:
    "Search posted inventory movements (receipts, issues, adjustments, transfers, builds, reversals) by item, location, kind, or date range, with quantity/value totals over ALL matches. Reversals carry their reason. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["items.read"] },
  feature: "inventory",
  inputSchema: z.object({
    itemId: uuidInput.optional(),
    stockLocationId: uuidInput.optional(),
    kind: z.string().max(40).optional().describe("Movement kind, e.g. receipt, issue, adjustment, transfer_in"),
    fromDate: dateInput.optional(),
    toDate: dateInput.optional(),
    limit: z.number().int().min(1).max(100).optional().describe("Default 25"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "inventory"))) {
      return { ok: false, error: "inventory_feature_disabled" };
    }
    const a = raw as {
      itemId?: string;
      stockLocationId?: string;
      kind?: string;
      fromDate?: string;
      toDate?: string;
      limit?: number;
    };
    const limit = Math.min(a.limit ?? 25, 100);
    const scope = subsidiaryVisibleFilter(sql`m.subsidiary_id`, authz.allowedSubsidiaryIds);
    let where = sql`m.org_id = ${authz.user.orgId} and m.status = 'posted' ${scope}`;
    if (a.itemId) where = sql`${where} and m.item_id = ${a.itemId}`;
    if (a.stockLocationId) where = sql`${where} and m.stock_location_id = ${a.stockLocationId}`;
    if (a.kind) where = sql`${where} and m.kind = ${a.kind}`;
    if (a.fromDate) where = sql`${where} and m.moved_at >= ${a.fromDate}::timestamptz`;
    if (a.toDate) where = sql`${where} and m.moved_at <= (${a.toDate}::date + interval '1 day')`;
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select m.id, m.kind, m.moved_at as "movedAt", m.quantity, m.unit_cost as "unitCost",
             m.total_value as "totalValue", m.status, m.memo,
             m.reversal_reason as "reversalReason",
             i.code as "itemCode", i.name as "itemName",
             sl.code as "stockLocationCode"
        from inventory_movements m
        join items i on i.id = m.item_id and i.org_id = m.org_id
        left join stock_locations sl on sl.id = m.stock_location_id and sl.org_id = m.org_id
       where ${where}
       order by m.moved_at desc, m.created_at desc
       limit ${limit}
    `)).rows;
    const totals = (await db.execute<{ n: string; quantity: string; value: string }>(sql`
      select count(*) as n, coalesce(sum(m.quantity), 0) as quantity,
             coalesce(sum(m.total_value), 0) as value
        from inventory_movements m
       where ${where}
    `)).rows[0];
    const total = Number(totals?.n ?? 0);
    return {
      ok: true,
      data: {
        total,
        sumQuantity: money(totals?.quantity),
        sumValue: money(totals?.value),
        returned: rows.length,
        truncated: total > rows.length,
        rows: rows.map((r) => ({
          ...r,
          quantity: money(r.quantity),
          unitCost: money(r.unitCost),
          totalValue: money(r.totalValue),
        })),
        href: "/inventory",
      },
    };
  },
};

const inventoryWritedowns: AssistantToolDef = {
  name: "inventory_writedowns",
  description:
    "Inventory write-downs (lower-of-cost-or-market adjustments) by item, location, or date range, with the written-down amount totaled over ALL matches. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["items.read"] },
  feature: "inventory",
  inputSchema: z.object({
    itemId: uuidInput.optional(),
    stockLocationId: uuidInput.optional(),
    fromDate: dateInput.optional(),
    toDate: dateInput.optional(),
    limit: z.number().int().min(1).max(100).optional().describe("Default 25"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "inventory"))) {
      return { ok: false, error: "inventory_feature_disabled" };
    }
    const a = raw as {
      itemId?: string;
      stockLocationId?: string;
      fromDate?: string;
      toDate?: string;
      limit?: number;
    };
    const limit = Math.min(a.limit ?? 25, 100);
    const scope = subsidiaryVisibleFilter(sql`w.subsidiary_id`, authz.allowedSubsidiaryIds);
    let where = sql`w.org_id = ${authz.user.orgId} ${scope}`;
    if (a.itemId) where = sql`${where} and w.item_id = ${a.itemId}`;
    if (a.stockLocationId) where = sql`${where} and w.stock_location_id = ${a.stockLocationId}`;
    if (a.fromDate) where = sql`${where} and w.date >= ${a.fromDate}`;
    if (a.toDate) where = sql`${where} and w.date <= ${a.toDate}`;
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select w.id, w.date, w.kind, w.framework, w.quantity, w.previous_value as "previousValue",
             w.new_value as "newValue", w.amount, w.reversed_amount as "reversedAmount", w.memo,
             i.code as "itemCode", i.name as "itemName",
             sl.code as "stockLocationCode"
        from inventory_writedowns w
        join items i on i.id = w.item_id and i.org_id = w.org_id
        left join stock_locations sl on sl.id = w.stock_location_id and sl.org_id = w.org_id
       where ${where}
       order by w.date desc, w.created_at desc
       limit ${limit}
    `)).rows;
    const totals = (await db.execute<{ n: string; amount: string }>(sql`
      select count(*) as n, coalesce(sum(w.amount), 0) as amount
        from inventory_writedowns w
       where ${where}
    `)).rows[0];
    const total = Number(totals?.n ?? 0);
    return {
      ok: true,
      data: {
        total,
        sumAmount: money(totals?.amount),
        returned: rows.length,
        truncated: total > rows.length,
        rows: rows.map((r) => ({
          ...r,
          quantity: money(r.quantity),
          previousValue: money(r.previousValue),
          newValue: money(r.newValue),
          amount: money(r.amount),
          reversedAmount: money(r.reversedAmount),
        })),
        href: "/inventory",
      },
    };
  },
};

export const INVENTORY_TOOLS: AssistantToolDef[] = [
  searchItems,
  getItem,
  inventoryLevels,
  inventoryMovements,
  inventoryWritedowns,
];
