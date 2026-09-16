import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeMoneyValue } from "../cash/core";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { AssistantToolDef, ToolResult } from "./types";
import { closeScopeDenied } from "./tools-close";
import { dateInput, uuidInput } from "./tools-shared";

/**
 * Foreign-exchange read tools for the agentic assistant. Rates come from the
 * same `fx_rates` table the revaluation engine and settlement flows read;
 * revaluation history is the posted `fx_revaluation`-origin journal entries;
 * the consolidation view reads the derived `consolidated_fx_rates` sets and
 * ownership runs the Period Close consolidation actions write. Exact decimal
 * strings throughout — never floats.
 */

/** Preserve ledger/rate decimals as canonical strings at the tool boundary. */
function money(v: unknown): string {
  return normalizeMoneyValue(String(v ?? "0"));
}

const listCurrencies: AssistantToolDef = {
  name: "list_currencies",
  description:
    "The ISO currency registry (code, name, minor units) plus this org's base currency. Reference data for resolving currency codes before calling the FX tools. Read-only.",
  category: "read",
  gate: { mode: "public" },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    const [currencies, org] = await Promise.all([
      db.execute<{ code: string; name: string; minor_units: number }>(
        sql`select code, name, minor_units from currencies order by code`,
      ),
      db.execute<{ base_currency: string }>(
        sql`select base_currency from orgs where id = ${authz.user.orgId}`,
      ),
    ]);
    return {
      ok: true,
      data: {
        baseCurrency: org.rows[0]?.base_currency ?? null,
        total: currencies.rows.length,
        currencies: currencies.rows.map((c) => ({
          code: c.code,
          name: c.name,
          minorUnits: c.minor_units,
        })),
      },
    };
  },
};

const listFxRates: AssistantToolDef = {
  name: "list_fx_rates",
  description:
    "Dated FX rates for a pair (newest first): type, exact rate, source, import time. Revaluation and settlement read these; past rates are history. Read-only.",
  category: "search",
  // The rates table has no single-entity viewer page: it feeds revaluation
  // (close/gl) and settlement, so the read gate admits exactly those two.
  gate: { mode: "anyOf", perms: ["gl.read", "close.read"] },
  feature: "multiCurrency",
  inputSchema: z.object({
    fromCurrency: z.string().regex(/^[A-Z]{3}$/, "ISO code").describe("Source currency ISO code, e.g. USD"),
    toCurrency: z.string().regex(/^[A-Z]{3}$/, "ISO code").describe("Target currency ISO code, e.g. CAD"),
    asOf: dateInput.optional().describe("Latest date to include; defaults to today"),
    rateType: z.string().max(20).optional().describe("Rate type, e.g. spot; omit for all types"),
    limit: z.number().int().min(1).max(100).optional().describe("Max rows, default 20"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "multiCurrency"))) {
      return { ok: false, error: "multi_currency_feature_disabled" };
    }
    const a = raw as { fromCurrency: string; toCurrency: string; asOf?: string; rateType?: string; limit?: number };
    const limit = Math.min(a.limit ?? 20, 100);
    let where = sql`org_id = ${authz.user.orgId} and from_currency = ${a.fromCurrency} and to_currency = ${a.toCurrency}`;
    if (a.asOf) where = sql`${where} and as_of <= ${a.asOf}`;
    if (a.rateType) where = sql`${where} and rate_type = ${a.rateType}`;
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select from_currency, to_currency, as_of, rate_type, rate::text as rate, source, imported_at, created_at
        from fx_rates
       where ${where}
       order by as_of desc, created_at desc
       limit ${limit}
    `));
    return {
      ok: true,
      data: {
        fromCurrency: a.fromCurrency,
        toCurrency: a.toCurrency,
        returned: rows.rows.length,
        truncated: rows.rows.length >= limit,
        rates: rows.rows.map((r) => ({
          asOf: r.as_of,
          rateType: r.rate_type,
          rate: r.rate,
          source: r.source,
          importedAt: r.imported_at,
        })),
        href: "/close",
      },
    };
  },
};

const listFxRevaluations: AssistantToolDef = {
  name: "list_fx_revaluations",
  description:
    "Posted period-end unrealized FX revaluations and their next-period mirrors. Reruns book incremental corrections only. For ad-hoc search use find_journal_entries. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["gl.read"] },
  feature: "multiCurrency",
  inputSchema: z.object({
    periodId: uuidInput.optional().describe("Only revaluations of this accounting period"),
    limit: z.number().int().min(1).max(50).optional().describe("Max rows, default 20"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "multiCurrency"))) {
      return { ok: false, error: "multi_currency_feature_disabled" };
    }
    const a = raw as { periodId?: string; limit?: number };
    const limit = Math.min(a.limit ?? 20, 50);
    const scope = subsidiaryVisibleFilter(sql`e.subsidiary_id`, authz.allowedSubsidiaryIds);
    let where = sql`e.org_id = ${authz.user.orgId} and e.origin = 'fx_revaluation' and e.status = 'posted'${scope}`;
    if (a.periodId) where = sql`${where} and e.period_id = ${a.periodId}`;
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select e.id, e.entry_number, e.posting_date, e.memo,
             p.name as period_name, b.name as book_name, b.code as book_code,
             s.name as subsidiary_name,
             m.entry_number as mirror_number,
             count(l.id) as line_count,
             sum(case when l.amount > 0 then l.amount else 0 end) as total_debits
        from journal_entries e
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
        left join accounting_periods p on p.id = e.period_id and p.org_id = e.org_id
        left join accounting_books b on b.id = e.book_id and b.org_id = e.org_id
        left join subsidiaries s on s.id = e.subsidiary_id and s.org_id = e.org_id
        -- The next-period mirror (-R entry) points back at the adjustment via
        -- reverses_entry_id, so the mirror resolves from the adjustment side.
        left join journal_entries m on m.reverses_entry_id = e.id and m.org_id = e.org_id
       where ${where}
       group by e.id, p.name, b.name, b.code, s.name, m.entry_number
       order by e.posting_date desc, e.entry_number desc
       limit ${limit}
    `));
    const c = (await db.execute<{ n: string; sum_debits: string }>(sql`
      select count(distinct e.id) as n,
             coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0) as sum_debits
        from journal_entries e
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
       where ${where}
    `));
    const total = Number(c.rows[0]?.n ?? 0);
    return {
      ok: true,
      data: {
        total,
        sumDebits: money(c.rows[0]?.sum_debits),
        returned: rows.rows.length,
        truncated: total > rows.rows.length,
        items: rows.rows.map((r) => ({
          id: r.id,
          entryNumber: r.entry_number,
          postingDate: r.posting_date,
          memo: r.memo,
          period: r.period_name,
          book: r.book_name,
          bookCode: r.book_code,
          subsidiary: r.subsidiary_name,
          mirrorEntryNumber: r.mirror_number,
          lineCount: Number(r.line_count),
          totalDebits: money(r.total_debits),
        })),
        href: "/journal",
      },
    };
  },
};

const getConsolidationView: AssistantToolDef = {
  name: "get_consolidation_view",
  description:
    "One period's consolidation state: rate sets per pair, ownership runs, elimination entries. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["close.read"] },
  feature: "multiSubsidiary",
  inputSchema: z.object({
    periodId: uuidInput.describe("Accounting period to inspect"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const denied = closeScopeDenied(authz);
    if (denied) return denied;
    const a = raw as { periodId: string };
    const period = (await db.execute<Record<string, unknown>>(sql`
      select id, name, starts_on, ends_on, fiscal_year
        from accounting_periods
       where id = ${a.periodId} and org_id = ${authz.user.orgId}
    `)).rows[0];
    if (!period) return { ok: false, error: "period_not_found" };
    const [rates, runs, entries] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select from_currency, to_currency, current_rate::text as current_rate,
               average_rate::text as average_rate, historical_rate::text as historical_rate,
               source, updated_at
          from consolidated_fx_rates
         where org_id = ${authz.user.orgId} and period_id = ${a.periodId}
         order by from_currency, to_currency
         limit 200
      `),
      db.execute<Record<string, unknown>>(sql`
        select id, status, error, started_at, finished_at
          from ownership_consolidation_runs
         where org_id = ${authz.user.orgId} and period_id = ${a.periodId}
         order by started_at desc
         limit 20
      `),
      db.execute<Record<string, unknown>>(sql`
        select e.kind, j.entry_number, j.posting_date, j.status
          from ownership_consolidation_entries e
          join journal_entries j on j.id = e.journal_entry_id and j.org_id = e.org_id
          join ownership_consolidation_runs r on r.id = e.run_id and r.org_id = e.org_id
         where e.org_id = ${authz.user.orgId} and r.period_id = ${a.periodId}
         order by j.posting_date desc, j.entry_number desc
         limit 100
      `),
    ]);
    return {
      ok: true,
      data: {
        period: { id: period.id, name: period.name, startsOn: period.starts_on, endsOn: period.ends_on, fiscalYear: period.fiscal_year },
        rates: rates.rows.map((r) => ({
          fromCurrency: r.from_currency,
          toCurrency: r.to_currency,
          currentRate: r.current_rate,
          averageRate: r.average_rate,
          historicalRate: r.historical_rate,
          source: r.source,
          updatedAt: r.updated_at,
        })),
        runs: runs.rows.map((r) => ({
          id: r.id,
          status: r.status,
          error: r.error,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
        })),
        entries: entries.rows.map((e) => ({
          kind: e.kind,
          entryNumber: e.entry_number,
          postingDate: e.posting_date,
          status: e.status,
        })),
        href: "/close",
      },
    };
  },
};

export const FX_TOOLS: AssistantToolDef[] = [
  listCurrencies,
  listFxRates,
  listFxRevaluations,
  getConsolidationView,
];
