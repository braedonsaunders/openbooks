import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import { loadAsset } from "../../app/api/assets/_lib";
import { loadLease } from "../../app/(app)/assets/leases/_lib";
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

/** Same primary-book carrying view used by the native register/report. */
const primaryAccumJoin = sql`
  left join asset_book_carrying_values dep on dep.org_id=f.org_id and dep.asset_id=f.id
    and dep.book_id=(select id from accounting_books where org_id=f.org_id and is_primary)`;

const searchAssets: AssistantToolDef = {
  name: "search_assets",
  description:
    "Search the fixed-asset register by number, name, status, category: cost, posted depreciation, NBV per asset (disposed read zero), plus totals over ALL matches. Read-only.",
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
             dep.accumulated as accumulated, dep.cost as "remainingCost",
             dep.carrying_value as "netBookValue"
        from fixed_assets f
        left join asset_categories c on c.id = f.category_id and c.org_id = f.org_id
        ${primaryAccumJoin}
       where ${where}
       order by f.asset_number nulls last, f.name
       limit ${limit}
    `)).rows;
    const totals = (await db.execute<{ n: string; cost: string; nbv: string }>(sql`
      select count(*) as n, coalesce(sum(f.acquisition_cost), 0) as cost,
             coalesce(sum(dep.carrying_value), 0) as nbv
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
          remainingCost: money(r.remainingCost),
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
    "One fixed asset: header, category, GL accounts, book totals, methods, lifecycle events, a depreciation-schedule page. Same payload as the asset drawer. Read-only.",
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
    "Tax-depreciation pool results for a filing-year label, including each registered window id, dates, legal entity and book. Multiple short years can share a label. Opening, additions, dispositions, allowance, closing, recapture and terminal loss by class. Read-only.",
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
      select tw.filing_year as "taxYear", pp.tax_year_window_id as "taxYearWindowId",
             pp.year_start::text as "yearStart", pp.year_end::text as "yearEnd",
             tp.subsidiary_id as "subsidiaryId", tp.book_id as "bookId",
             tp.class_code as "classCode", tp.regime,
             pp.opening_balance::text as "openingBalance", pp.additions::text as additions,
             pp.dispositions::text as dispositions, pp.allowance::text as allowance,
             pp.closing_balance::text as "closingBalance", pp.recapture::text as recapture,
             pp.terminal_loss::text as "terminalLoss"
        from tax_pool_periods pp
        join tax_depreciation_pools tp on tp.id = pp.pool_id and tp.org_id = pp.org_id
        join tax_year_windows tw on tw.id = pp.tax_year_window_id and tw.org_id = pp.org_id
       where pp.org_id = ${authz.user.orgId} and tw.filing_year = ${a.taxYear}
         ${subsidiaryVisibleFilter(sql`tp.subsidiary_id`, authz.allowedSubsidiaryIds)}
       order by pp.year_start, tp.subsidiary_id, tp.book_id, tp.class_code
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

const searchLeaseAgreements: AssistantToolDef = {
  name: "search_lease_agreements",
  description: "Find lessee lease agreements by number or description, with contractual timing, currency and status. Read-only; returns links to the native lease workpaper.",
  category: "search",
  gate: assetGate(),
  feature: "fixedAssets",
  inputSchema: z.object({
    query: z.string().max(100).optional().describe("Optional text to match against the lease number or description"),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum number of lease agreements to return, from 1 to 50; defaults to 20"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "fixedAssets")))
      return { ok: false, error: "fixedAssets_feature_disabled" };
    const input = raw as { query?: string; limit?: number };
    const limit = input.limit ?? 20;
    let predicate = sql`la.org_id=${authz.user.orgId} ${subsidiaryVisibleFilter(sql`la.subsidiary_id`, authz.allowedSubsidiaryIds)}`;
    if (input.query) {
      const query = `%${input.query}%`;
      predicate = sql`${predicate} and (la.lease_number ilike ${query} or la.description ilike ${query})`;
    }
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select la.id,la.lease_number,la.description,la.status,la.subsidiary_id,
        la.commencement_on::text,la.currency,la.payment_amount::text,
        la.payment_timing,la.payment_frequency,la.term_periods,la.revision
      from lease_agreements la where ${predicate}
      order by la.lease_number,la.id limit ${limit + 1}`)).rows;
    return { ok: true, data: {
      items: rows.slice(0, limit).map((row) => ({ ...row, href: `/assets/leases?lease=${row.id}` })),
      truncated: rows.length > limit,
      href: "/assets/leases",
    } };
  },
};

const getLeaseAgreement: AssistantToolDef = {
  name: "get_lease_agreement",
  description: "Read a lessee lease agreement, its versioned payment/accrual schedule, and approval changes. Reuses the native lease drawer; read-only.",
  category: "read",
  gate: assetGate(),
  feature: "fixedAssets",
  inputSchema: z.object({ id: uuidInput.describe("Lease agreement id from search_lease_agreements") }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "fixedAssets")))
      return { ok: false, error: "fixedAssets_feature_disabled" };
    const input = raw as { id: string };
    const payload = await loadLease(authz.user.orgId, input.id, authz.allowedSubsidiaryIds);
    if (!payload) return { ok: false, error: "not found" };
    return { ok: true, data: { ...payload, href: `/assets/leases?lease=${input.id}` } };
  },
};

export const ASSETS_TOOLS: AssistantToolDef[] = [searchAssets, getAsset, assetTaxPools, searchLeaseAgreements, getLeaseAgreement];
