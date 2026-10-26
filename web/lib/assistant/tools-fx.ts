import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { canonicalPeriodLabelSql } from "@openbooks/engine/periods/period-policy";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { AssistantToolDef, ToolResult } from "./types";
import { closeScopeDenied } from "./tools-close";
import { assistantListPage, dateInput, money, uuidInput } from "./tools-shared";

/**
 * Foreign-exchange read tools for the agentic assistant. Rates come from the
 * same `fx_rates` table the revaluation engine and settlement flows read;
 * revaluation history is the posted `fx_revaluation`-origin journal entries;
 * the consolidation view reads the derived `consolidated_fx_rates` sets and
 * ownership runs the Period Close consolidation actions write. Exact decimal
 * strings throughout — never floats.
 */

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
        "objects",
      ),
      db.execute<{ base_currency: string }>(
        sql`select base_currency from orgs where id = ${authz.user.orgId}`,
        "objects",
      ),
    ]);
    return {
      ok: true,
      data: {
        baseCurrency: org[0]?.base_currency ?? null,
        total: currencies.length,
        currencies: currencies.map((c) => ({
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
    fromCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/, "ISO code")
      .describe("Source currency ISO code, e.g. USD"),
    toCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/, "ISO code")
      .describe("Target currency ISO code, e.g. CAD"),
    asOf: dateInput.optional().describe("Latest date to include; defaults to today"),
    rateType: z.string().max(20).optional().describe("Rate type, e.g. spot; omit for all types"),
    limit: z.number().int().min(1).max(100).optional().describe("Max rows, default 20"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "multiCurrency"))) {
      return { ok: false, error: "multi_currency_feature_disabled" };
    }
    const a = raw as {
      fromCurrency: string;
      toCurrency: string;
      asOf?: string;
      rateType?: string;
      limit?: number;
    };
    const limit = Math.min(a.limit ?? 20, 100);
    let where = sql`org_id = ${authz.user.orgId} and from_currency = ${a.fromCurrency} and to_currency = ${a.toCurrency}`;
    if (a.asOf) where = sql`${where} and as_of <= ${a.asOf}`;
    if (a.rateType) where = sql`${where} and rate_type = ${a.rateType}`;
    // Fetch one row past the limit plus an authoritative count so `total`
    // and `truncated` never mistake an exactly-full page for truncation.
    const rows = await db.execute<Record<string, unknown>>(
      sql`
      select from_currency, to_currency, as_of, rate_type, rate::text as rate, source, imported_at, created_at
        from fx_rates
       where ${where}
       order by as_of desc, created_at desc
       limit ${limit + 1}
    `,
      "objects",
    );
    const count = (
      await db.execute<{ total: number }>(
        sql`
      select count(*)::int as total from fx_rates where ${where}
    `,
        "objects",
      )
    )[0];
    const page = assistantListPage(rows, limit, Number(count?.total ?? 0));
    return {
      ok: true,
      data: {
        fromCurrency: a.fromCurrency,
        toCurrency: a.toCurrency,
        total: page.total,
        returned: page.returned,
        truncated: page.truncated,
        dropped: page.dropped,
        rates: page.items.map((r) => ({
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
    let where = sql`e.org_id = ${authz.user.orgId} and e.origin = 'fx_revaluation' and e.status in ('posted', 'reversed')${scope}`;
    if (a.periodId) where = sql`${where} and e.period_id = ${a.periodId}`;
    const rows = await db.execute<Record<string, unknown>>(
      sql`
      select e.id, e.entry_number, e.posting_date, e.memo,
             ${canonicalPeriodLabelSql("p")} as period_name, b.name as book_name, b.code as book_code,
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
       group by e.id, p.id, b.name, b.code, s.name, m.entry_number
       order by e.posting_date desc, e.entry_number desc
       limit ${limit}
    `,
      "objects",
    );
    const c = await db.execute<{ n: string; sum_debits: string }>(
      sql`
      select count(distinct e.id) as n,
             coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0) as sum_debits
        from journal_entries e
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
       where ${where}
    `,
      "objects",
    );
    const total = Number(c[0]?.n ?? 0);
    return {
      ok: true,
      data: {
        total,
        sumDebits: money(c[0]?.sum_debits),
        returned: rows.length,
        truncated: total > rows.length,
        items: rows.map((r) => ({
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
    const period = (
      await db.execute<Record<string, unknown>>(
        sql`
      select p.id, ${canonicalPeriodLabelSql("p")} as name, p.starts_on, p.ends_on, p.fiscal_year
        from accounting_periods p
       where p.id = ${a.periodId} and p.org_id = ${authz.user.orgId}
    `,
        "objects",
      )
    )[0];
    if (!period) return { ok: false, error: "period_not_found" };
    const [rates, runs, entries] = await Promise.all([
      db.execute<Record<string, unknown>>(
        sql`
        select count(*) over() as total_count, from_currency, to_currency, current_rate::text as current_rate,
               average_rate::text as average_rate, historical_rate::text as historical_rate,
               source, updated_at
          from consolidated_fx_rates
         where org_id = ${authz.user.orgId} and period_id = ${a.periodId}
         order by from_currency, to_currency
         limit 201
      `,
        "objects",
      ),
      db.execute<Record<string, unknown>>(
        sql`
        select count(*) over() as total_count, id, status, error, started_at, finished_at
          from ownership_consolidation_runs
         where org_id = ${authz.user.orgId} and period_id = ${a.periodId}
         order by started_at desc
         limit 21
      `,
        "objects",
      ),
      db.execute<Record<string, unknown>>(
        sql`
        select count(*) over() as total_count, e.kind, j.entry_number, j.posting_date, j.status
          from ownership_consolidation_entries e
          join journal_entries j on j.id = e.journal_entry_id and j.org_id = e.org_id
          join ownership_consolidation_runs r on r.id = e.run_id and r.org_id = e.org_id
         where e.org_id = ${authz.user.orgId} and r.period_id = ${a.periodId}
         order by j.posting_date desc, j.entry_number desc
         limit 101
      `,
        "objects",
      ),
    ]);
    const ratesMapped = rates.map((r) => ({
      fromCurrency: r.from_currency,
      toCurrency: r.to_currency,
      currentRate: r.current_rate,
      averageRate: r.average_rate,
      historicalRate: r.historical_rate,
      source: r.source,
      updatedAt: r.updated_at,
    }));
    const runsMapped = runs.map((r) => ({
      id: r.id,
      status: r.status,
      error: r.error,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
    const entriesMapped = entries.map((e) => ({
      kind: e.kind,
      entryNumber: e.entry_number,
      postingDate: e.posting_date,
      status: e.status,
    }));
    const ratesPage = assistantListPage(ratesMapped, 200, Number(rates[0]?.total_count ?? 0));
    const runsPage = assistantListPage(runsMapped, 20, Number(runs[0]?.total_count ?? 0));
    const entriesPage = assistantListPage(entriesMapped, 100, Number(entries[0]?.total_count ?? 0));
    return {
      ok: true,
      data: {
        period: {
          id: period.id,
          name: period.name,
          startsOn: period.starts_on,
          endsOn: period.ends_on,
          fiscalYear: period.fiscal_year,
        },
        rates: ratesPage.items,
        ratesPage: {
          total: ratesPage.total,
          returned: ratesPage.returned,
          truncated: ratesPage.truncated,
          dropped: ratesPage.dropped,
        },
        runs: runsPage.items,
        runsPage: {
          total: runsPage.total,
          returned: runsPage.returned,
          truncated: runsPage.truncated,
          dropped: runsPage.dropped,
        },
        entries: entriesPage.items,
        entriesPage: {
          total: entriesPage.total,
          returned: entriesPage.returned,
          truncated: entriesPage.truncated,
          dropped: entriesPage.dropped,
        },
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
