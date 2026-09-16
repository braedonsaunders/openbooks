import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { loadAsset } from "../../app/api/assets/_lib";
import type { AssistantToolDef, ToolResult } from "./types";
import { uuidInput } from "./tools-shared";

/**
 * Fixed-asset reads. The register tab is an entity list over `fixed_assets`;
 * the detail drawer renders `loadAsset` from `web/app/api/assets/_lib.ts`
 * (asset + category + effective accounts + primary-book totals + schedule
 * page + lifecycle valuation); the tax-depreciation tab reads computed pool
 * periods (GET `api/assets/tax-pools`). Every tool enforces the same gate
 * (`assets.read`) and feature (`fixedAssets`) as those routes.
 */

const money = (v: unknown) => normalizeMoney(v == null ? "0" : String(v));

function assetGate(): AssistantToolDef["gate"] {
  return { mode: "anyOf", perms: ["assets.read"] };
}

/** Posted depreciation on the org's primary book — the same basis the
 *  drawer's primary-book totals use. */
const primaryAccumJoin = sql`
  left join lateral (
    select coalesce(sum(l.posted_amount), 0) as accum
      from depreciation_schedules s
      join accounting_books b on b.id = s.book_id and b.org_id = s.org_id and b.is_primary
      join depreciation_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
     where s.asset_id = f.id and s.org_id = f.org_id
  ) dep on true`;

const searchAssets: AssistantToolDef = {
  name: "search_assets",
  description:
    "Search the fixed-asset register by number, name, status, or category, with acquisition cost, posted depreciation (primary book), and net book value per asset — disposed and written-off assets read zero — plus cost/NBV totals over ALL matches. Read-only.",
  category: "search",
  gate: assetGate(),
  feature: "fixedAssets",
  inputSchema: z.object({
    query: z.string().max(100).optional().describe("Match asset number or name"),
    status: z.string().max(40).optional().describe("Asset status, e.g. in_service, disposed"),
    categoryId: uuidInput.optional(),
    limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "fixedAssets"))) {
      return { ok: false, error: "fixedAssets_feature_disabled" };
    }
    const a = raw as { query?: string; status?: string; categoryId?: string; limit?: number };
    const limit = Math.min(a.limit ?? 20, 50);
    const scope = subsidiaryVisibleFilter(sql`f.subsidiary_id`, authz.allowedSubsidiaryIds);
    let where = sql`f.org_id = ${authz.user.orgId} ${scope}`;
    if (a.status) where = sql`${where} and f.status = ${a.status}`;
    if (a.categoryId) where = sql`${where} and f.category_id = ${a.categoryId}`;
    if (a.query) {
      const like = `%${a.query}%`;
      where = sql`${where} and (f.asset_number ilike ${like} or f.name ilike ${like})`;
    }
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select f.id, f.asset_number as "assetNumber", f.name, f.status,
             f.acquired_on as "acquiredOn", f.in_service_on as "inServiceOn",
             f.acquisition_cost as "acquisitionCost", c.name as category,
             dep.accum as accumulated,
             case when f.status in ('disposed', 'written_off') then 0
                  else f.acquisition_cost - dep.accum end as "netBookValue"
        from fixed_assets f
        left join asset_categories c on c.id = f.category_id and c.org_id = f.org_id
        ${primaryAccumJoin}
       where ${where}
       order by f.asset_number nulls last, f.name
       limit ${limit}
    `)).rows;
    const totals = (await db.execute<{ n: string; cost: string; nbv: string }>(sql`
      select count(*) as n, coalesce(sum(f.acquisition_cost), 0) as cost,
             coalesce(sum(case when f.status in ('disposed', 'written_off') then 0
                               else f.acquisition_cost - dep.accum end), 0) as nbv
        from fixed_assets f
        ${primaryAccumJoin}
       where ${where}
    `)).rows[0];
    const total = Number(totals?.n ?? 0);
    return {
      ok: true,
      data: {
        total,
        sumAcquisitionCost: money(totals?.cost),
        sumNetBookValue: money(totals?.nbv),
        returned: rows.length,
        truncated: total > rows.length,
        items: rows.map((r) => ({
          ...r,
          acquisitionCost: money(r.acquisitionCost),
          accumulated: money(r.accumulated),
          netBookValue: money(r.netBookValue),
        })),
        href: "/assets",
      },
    };
  },
};

const getAsset: AssistantToolDef = {
  name: "get_asset",
  description:
    "One fixed asset by id: header, category, effective GL accounts, primary-book totals (accumulated, net book value), book methods, lifecycle events, and a page of the depreciation schedule. Same payload the asset drawer renders. Read-only.",
  category: "read",
  gate: assetGate(),
  feature: "fixedAssets",
  inputSchema: z.object({
    id: uuidInput.describe("Asset id from search_assets"),
    bookId: uuidInput.optional().describe("Restrict the schedule page to one accounting book"),
    query: z.string().max(100).optional().describe("Filter schedule lines by period, book, or source"),
    page: z.number().int().min(1).max(100).optional().describe("Schedule page, default 1"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "fixedAssets"))) {
      return { ok: false, error: "fixedAssets_feature_disabled" };
    }
    const a = raw as { id: string; bookId?: string; query?: string; page?: number };
    const payload = await loadAsset(a.id, authz.user.orgId, {
      bookId: a.bookId ?? null,
      query: a.query ?? "",
      page: a.page ?? 1,
      perPage: 25,
    });
    // The route answers 404 for an asset outside the caller's scope; so do we.
    if (!payload || (authz.allowedSubsidiaryIds && !authz.allowedSubsidiaryIds.has(String(payload.asset.subsidiary_id)))) {
      return { ok: false, error: "not found" };
    }
    return { ok: true, data: { ...payload, href: "/assets" } };
  },
};

const assetTaxPools: AssistantToolDef = {
  name: "asset_tax_pools",
  description:
    "Computed tax-depreciation pool results (Schedule 8-style) for a tax year: opening balance, additions, dispositions, allowance, closing balance, recapture, and terminal loss by pool class. Same rows the tax-depreciation tab reads. Read-only.",
  category: "read",
  gate: assetGate(),
  feature: "fixedAssets",
  inputSchema: z.object({
    taxYear: z.number().int().min(1900).max(2100).describe("Tax year, e.g. 2025"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "fixedAssets"))) {
      return { ok: false, error: "fixedAssets_feature_disabled" };
    }
    const a = raw as { taxYear: number };
    const rows = (await db.execute<Record<string, string>>(sql`
      select pp.tax_year as "taxYear", tp.class_code as "classCode", tp.regime,
             pp.opening_balance::text as "openingBalance", pp.additions::text as additions,
             pp.dispositions::text as dispositions, pp.allowance::text as allowance,
             pp.closing_balance::text as "closingBalance", pp.recapture::text as recapture,
             pp.terminal_loss::text as "terminalLoss"
        from tax_pool_periods pp
        join tax_depreciation_pools tp on tp.id = pp.pool_id and tp.org_id = pp.org_id
       where pp.org_id = ${authz.user.orgId} and pp.tax_year = ${a.taxYear}
         ${subsidiaryVisibleFilter(sql`tp.subsidiary_id`, authz.allowedSubsidiaryIds)}
       order by tp.class_code
    `)).rows;
    return {
      ok: true,
      data: {
        taxYear: a.taxYear,
        pools: rows.map((r) => ({
          ...r,
          openingBalance: money(r.openingBalance),
          additions: money(r.additions),
          dispositions: money(r.dispositions),
          allowance: money(r.allowance),
          closingBalance: money(r.closingBalance),
          recapture: money(r.recapture),
          terminalLoss: money(r.terminalLoss),
        })),
        href: "/assets/tax-pools",
      },
    };
  },
};

export const ASSETS_TOOLS: AssistantToolDef[] = [searchAssets, getAsset, assetTaxPools];
