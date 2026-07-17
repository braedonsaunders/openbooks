import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { computePoolYear, resolvePoolClass, TAX_DEPRECIATION_REGIMES } from "./tax-depreciation-pool.ts";

/**
 * Run a jurisdiction's tax depreciation pools for a tax year on a book. Groups
 * the org's assets by their regime class (from the asset category's
 * tax_attributes), derives additions (assets placed in service in the year) and
 * dispositions (asset events, capped at capital cost), then runs the pure
 * per-pool waterfall (computePoolYear), persisting each result and rolling the
 * pool's balance forward. Canada CCA is the first regime; the engine is generic.
 */

export interface TaxPoolLine {
  classCode: string;
  className: string;
  openingBalance: string;
  additions: string;
  dispositions: string;
  allowance: string;
  closingBalance: string;
  recapture: string;
  terminalLoss: string;
}

export interface TaxPoolRunResult {
  regime: string;
  taxYear: number;
  lines: TaxPoolLine[];
  totals: { allowance: string; recapture: string; terminalLoss: string };
}

export class TaxPoolError extends Error {
  readonly name = "TaxPoolError";
}

/** Effective first-year rule (fraction + enhanced multiplier) for a class on a
 *  date — a tenant config row if one matches, else the regime class default. */
async function firstYearRule(
  orgId: string,
  regime: string,
  classCode: string,
  onDate: string,
  defaultFraction: number,
): Promise<{ firstYearFraction: number; enhancedMultiplier?: number }> {
  const r = (await db.execute(sql`
    select first_year_fraction::float8 as fraction, enhanced_multiplier::float8 as mult
      from tax_first_year_rules
     where org_id = ${orgId} and regime = ${regime}
       and (class_code = ${classCode} or class_code is null)
       and (acquired_from is null or acquired_from <= ${onDate})
       and (acquired_to is null or acquired_to >= ${onDate})
     order by class_code nulls last, acquired_from desc nulls last
     limit 1`)) as unknown as { rows: { fraction: number; mult: number | null }[] };
  const row = r.rows[0];
  if (!row) return { firstYearFraction: defaultFraction };
  return { firstYearFraction: row.fraction, enhancedMultiplier: row.mult ?? undefined };
}

export async function runTaxPool(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  regime: string,
  taxYear: number,
  opts: { yearStart: string; yearEnd: string; shortYearFactor?: number; actorId: string | null },
): Promise<TaxPoolRunResult> {
  const regimeDef = TAX_DEPRECIATION_REGIMES[regime];
  if (!regimeDef) throw new TaxPoolError(`unknown tax depreciation regime "${regime}"`);

  // Additions this year + whether the class still holds assets at year-end.
  const classRows = (await db.execute(sql`
    select c.tax_attributes->>'ca_cca_class' as class_code,
           coalesce(sum(case when coalesce(a.in_service_on, a.acquired_on) between ${opts.yearStart} and ${opts.yearEnd}
                             then a.acquisition_cost else 0 end), 0)::text as additions,
           bool_or(a.status not in ('disposed', 'written_off')) as has_assets
      from fixed_assets a
      join asset_categories c on c.id = a.category_id
     where a.org_id = ${orgId} and a.subsidiary_id = ${subsidiaryId}
       and coalesce(c.tax_attributes->>'ca_cca_class', '') <> ''
     group by c.tax_attributes->>'ca_cca_class'`)) as unknown as {
    rows: { class_code: string; additions: string; has_assets: boolean }[];
  };

  // Dispositions this year: Σ least(proceeds, capital cost) per class.
  const dispRows = (await db.execute(sql`
    select c.tax_attributes->>'ca_cca_class' as class_code,
           coalesce(sum(least(e.amount, a.acquisition_cost)), 0)::text as dispositions
      from asset_events e
      join fixed_assets a on a.id = e.asset_id
      join asset_categories c on c.id = a.category_id
     where e.org_id = ${orgId} and a.subsidiary_id = ${subsidiaryId}
       and e.kind in ('disposed', 'written_off') and e.occurred_on between ${opts.yearStart} and ${opts.yearEnd}
       and coalesce(c.tax_attributes->>'ca_cca_class', '') <> ''
     group by c.tax_attributes->>'ca_cca_class'`)) as unknown as {
    rows: { class_code: string; dispositions: string }[];
  };
  const dispByClass = new Map(dispRows.rows.map((r) => [r.class_code, r.dispositions]));

  const lines: TaxPoolLine[] = [];
  let totAllow = "0", totRecap = "0", totTerm = "0";

  for (const row of classRows.rows) {
    const classCode = row.class_code;
    const classDef = resolvePoolClass(regime, classCode) ?? regimeDef.classes[classCode];
    if (!classDef) continue; // unknown class code — skip rather than guess
    const dispositions = dispByClass.get(classCode) ?? "0";

    const pool = await ensurePool(orgId, bookId, subsidiaryId, regime, classDef, opts.actorId);
    const rule = await firstYearRule(orgId, regime, classCode, opts.yearEnd, classDef.firstYearFraction);

    const result = computePoolYear({
      openingBalance: pool.openingBalance,
      additions: row.additions,
      dispositions,
      rate: classDef.rate,
      firstYearFraction: rule.firstYearFraction,
      enhancedFirstYearMultiplier: rule.enhancedMultiplier,
      shortYearFactor: opts.shortYearFactor,
      poolHasAssetsAtYearEnd: row.has_assets,
      allowRecapture: classDef.allowRecapture,
      allowTerminalLoss: classDef.allowTerminalLoss,
    });

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into tax_pool_periods
          (org_id, pool_id, tax_year, opening_balance, additions, dispositions, net_additions,
           immediate_expense, base, allowance, closing_balance, recapture, terminal_loss,
           short_year_factor, enhanced_multiplier, created_by, updated_by)
        values (${orgId}, ${pool.id}, ${taxYear}, ${result.openingBalance}, ${result.additions},
                ${result.dispositions}, ${result.netAdditions}, ${result.immediateExpense}, ${result.base},
                ${result.allowance}, ${result.closingBalance}, ${result.recapture}, ${result.terminalLoss},
                ${opts.shortYearFactor ?? 1}, ${rule.enhancedMultiplier ?? null}, ${opts.actorId}, ${opts.actorId})
        on conflict (org_id, pool_id, tax_year) do update set
          opening_balance = excluded.opening_balance, additions = excluded.additions,
          dispositions = excluded.dispositions, net_additions = excluded.net_additions,
          immediate_expense = excluded.immediate_expense, base = excluded.base,
          allowance = excluded.allowance, closing_balance = excluded.closing_balance,
          recapture = excluded.recapture, terminal_loss = excluded.terminal_loss,
          short_year_factor = excluded.short_year_factor, enhanced_multiplier = excluded.enhanced_multiplier,
          updated_at = now(), updated_by = ${opts.actorId}`);
      await tx.execute(sql`
        update tax_depreciation_pools set opening_balance = ${result.closingBalance}, updated_at = now(), updated_by = ${opts.actorId}
         where id = ${pool.id}`);
    });

    lines.push({
      classCode, className: classDef.name,
      openingBalance: result.openingBalance, additions: result.additions, dispositions: result.dispositions,
      allowance: result.allowance, closingBalance: result.closingBalance,
      recapture: result.recapture, terminalLoss: result.terminalLoss,
    });
    totAllow = addStr(totAllow, result.allowance);
    totRecap = addStr(totRecap, result.recapture);
    totTerm = addStr(totTerm, result.terminalLoss);
  }

  return { regime, taxYear, lines, totals: { allowance: totAllow, recapture: totRecap, terminalLoss: totTerm } };
}

const addStr = (a: string, b: string) => (Math.round((Number(a) + Number(b)) * 100) / 100).toFixed(2);

async function ensurePool(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  regime: string,
  classDef: { code: string; rate: number; method: "declining" | "straight_line" },
  actorId: string | null,
): Promise<{ id: string; openingBalance: string }> {
  const existing = (await db.execute(sql`
    select id, opening_balance::text as opening from tax_depreciation_pools
     where org_id = ${orgId} and book_id = ${bookId} and subsidiary_id = ${subsidiaryId}
       and regime = ${regime} and class_code = ${classDef.code} and is_separate_class = false
     limit 1`)) as unknown as { rows: { id: string; opening: string }[] };
  if (existing.rows[0]) return { id: existing.rows[0].id, openingBalance: existing.rows[0].opening };
  const ins = (await db.execute(sql`
    insert into tax_depreciation_pools (org_id, book_id, subsidiary_id, regime, class_code, rate, method, created_by, updated_by)
    values (${orgId}, ${bookId}, ${subsidiaryId}, ${regime}, ${classDef.code}, ${classDef.rate}, ${classDef.method}, ${actorId}, ${actorId})
    returning id`)) as unknown as { rows: { id: string }[] };
  return { id: ins.rows[0].id, openingBalance: "0" };
}
