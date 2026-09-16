import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { loadEquipment } from "../../app/api/equipment/_lib";
import type { AssistantToolDef, ToolResult } from "./types";
import { uuidInput } from "./tools-shared";

/**
 * Equipment reads. The equipment page (`web/app/(app)/assets/equipment`)
 * renders register KPIs (active count, purchase basis, cost recovery,
 * billable) from `equipment_units` plus charge/recovery aggregates over
 * project-charge lines, and the drawer renders `loadEquipment` from
 * `web/app/api/equipment/_lib.ts` (unit + usage/recovery/billable/billed/
 * direct-cost/depreciation metrics). Both enforce `assets.read` and the
 * `equipment` feature. There is no maintenance entity — utilization is the
 * loader's metrics block.
 */

const money = (v: unknown) => normalizeMoney(v == null ? "0" : String(v));

/** Cost recovery and billable value per unit — the page KPI subqueries. */
const chargeAggregates = sql`
  left join lateral (
    select coalesce(sum(dl.cost_amount), 0) as recovery,
           coalesce(sum(dl.bill_amount), 0) as billable
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
     where dl.equipment_unit_id = e.id and dl.org_id = e.org_id
       and d.kind = 'project_charge' and d.status in ('approved', 'posted')
  ) ch on true`;

const searchEquipment: AssistantToolDef = {
  name: "search_equipment",
  description:
    "Search the equipment register by unit number or name, with status, purchase price, charge item, linked fixed asset, and per-unit cost recovery and billable value — plus register totals over ALL matches. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["assets.read"] },
  feature: "equipment",
  inputSchema: z.object({
    query: z.string().max(100).optional().describe("Match unit number or name"),
    status: z.string().max(40).optional().describe("Unit status, e.g. active"),
    limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "equipment"))) {
      return { ok: false, error: "equipment_feature_disabled" };
    }
    const a = raw as { query?: string; status?: string; limit?: number };
    const limit = Math.min(a.limit ?? 20, 50);
    const scope = subsidiaryVisibleFilter(sql`e.subsidiary_id`, authz.allowedSubsidiaryIds);
    let where = sql`e.org_id = ${authz.user.orgId} ${scope}`;
    if (a.status) where = sql`${where} and e.status = ${a.status}`;
    if (a.query) {
      const like = `%${a.query}%`;
      where = sql`${where} and (e.unit_number ilike ${like} or e.name ilike ${like})`;
    }
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select e.id, e.unit_number as "unitNumber", e.name, e.status,
             e.purchase_price as "purchasePrice", e.capacity_quantity as "capacityQuantity",
             e.capacity_unit as "capacityUnit", e.acquired_on as "acquiredOn",
             i.name as "chargeItem", b.name as "rateBook",
             f.asset_number as "fixedAssetNumber",
             ch.recovery, ch.billable
        from equipment_units e
        left join items i on i.id = e.charge_item_id and i.org_id = e.org_id
        left join item_rate_books b on b.id = e.rate_book_id and b.org_id = e.org_id
        left join fixed_assets f on f.id = e.fixed_asset_id and f.org_id = e.org_id
        ${chargeAggregates}
       where ${where}
       order by e.unit_number nulls last, e.name
       limit ${limit}
    `)).rows;
    const totals = (await db.execute<{ n: string; active: string; purchase: string; recovery: string; billable: string }>(sql`
      select count(*) as n,
             count(*) filter (where e.status = 'active') as active,
             coalesce(sum(e.purchase_price), 0) as purchase,
             coalesce(sum(ch.recovery), 0) as recovery,
             coalesce(sum(ch.billable), 0) as billable
        from equipment_units e
        ${chargeAggregates}
       where ${where}
    `)).rows[0];
    const total = Number(totals?.n ?? 0);
    return {
      ok: true,
      data: {
        total,
        active: Number(totals?.active ?? 0),
        sumPurchasePrice: money(totals?.purchase),
        sumRecovery: money(totals?.recovery),
        sumBillable: money(totals?.billable),
        returned: rows.length,
        truncated: total > rows.length,
        items: rows.map((r) => ({
          ...r,
          purchasePrice: money(r.purchasePrice),
          recovery: money(r.recovery),
          billable: money(r.billable),
        })),
        href: "/assets/equipment",
      },
    };
  },
};

const getEquipment: AssistantToolDef = {
  name: "get_equipment",
  description:
    "One equipment unit by id: header, charge item, rate book, linked fixed asset, and utilization metrics — usage quantity, cost recovery, billable value, billed revenue, direct costs, and depreciation. Same payload the equipment drawer renders. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["assets.read"] },
  feature: "equipment",
  inputSchema: z.object({
    id: uuidInput.describe("Equipment unit id from search_equipment"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "equipment"))) {
      return { ok: false, error: "equipment_feature_disabled" };
    }
    const a = raw as { id: string };
    const data = await loadEquipment(a.id, authz.user.orgId);
    // The route answers 404 for a unit outside the caller's scope; so do we.
    if (!data || (authz.allowedSubsidiaryIds && !authz.allowedSubsidiaryIds.has(String((data.unit as Record<string, unknown>).subsidiary_id)))) {
      return { ok: false, error: "not found" };
    }
    const unit = data.unit as Record<string, unknown>;
    const metrics = data.metrics as Record<string, unknown>;
    return {
      ok: true,
      data: {
        ...unit,
        purchase_price: money(unit.purchase_price),
        metrics: {
          usageQuantity: String(metrics.usage ?? "0"),
          recovery: money(metrics.recovery),
          billable: money(metrics.billable),
          billedRevenue: money(metrics.billed_revenue),
          directCosts: money(metrics.direct_costs),
          depreciation: money(metrics.depreciation),
        },
        href: "/assets/equipment",
      },
    };
  },
};

export const EQUIPMENT_TOOLS: AssistantToolDef[] = [searchEquipment, getEquipment];
