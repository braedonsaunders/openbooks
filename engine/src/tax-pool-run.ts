import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, formatMoney, fromUnits, normalizeMoney, toUnits } from "./money.ts";
import { computeMacrsYear, computePoolYear, type PoolClassDef, TAX_DEPRECIATION_REGIMES } from "./tax-depreciation-pool.ts";

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
  defaultFraction: string | number,
): Promise<{ firstYearFraction: string | number; enhancedMultiplier?: string }> {
  const r = (await db.execute(sql`
    select first_year_fraction::text as fraction, enhanced_multiplier::text as mult
      from tax_first_year_rules
     where org_id = ${orgId} and regime = ${regime}
       and (class_code = ${classCode} or class_code is null)
       and (acquired_from is null or acquired_from <= ${onDate})
       and (acquired_to is null or acquired_to >= ${onDate})
     order by class_code nulls last, acquired_from desc nulls last
     limit 1`)) as unknown as { rows: { fraction: string; mult: string | null }[] };
  const row = r.rows[0];
  if (!row) return { firstYearFraction: defaultFraction };
  return { firstYearFraction: row.fraction, enhancedMultiplier: row.mult ?? undefined };
}

/** The asset-category tax_attributes key that carries a class code for a regime.
 *  An org regime row can override it; Canada's legacy data uses "ca_cca_class". */
async function regimeClassAttribute(orgId: string, regime: string): Promise<string> {
  const r = (await db.execute(sql`
    select class_attribute from tax_regimes where org_id = ${orgId} and code = ${regime} and is_active limit 1`)) as unknown as {
    rows: { class_attribute: string }[];
  };
  return r.rows[0]?.class_attribute ?? TAX_DEPRECIATION_REGIMES[regime]?.classAttribute ?? "tax_pool_class";
}

async function regimeModel(orgId: string, regime: string): Promise<"pool" | "macrs"> {
  const r = (await db.execute(sql`
    select calculation_model from tax_regimes where org_id = ${orgId} and code = ${regime} and is_active limit 1`)) as unknown as {
    rows: { calculation_model: "pool" | "macrs" }[];
  };
  return r.rows[0]?.calculation_model ?? TAX_DEPRECIATION_REGIMES[regime]?.calculationModel ?? "pool";
}

/** Effective class definitions for a regime: built-in defaults with org
 *  tax_pool_classes rows merged on top (org wins). */
async function effectiveClasses(orgId: string, regime: string): Promise<Map<string, PoolClassDef>> {
  const map = new Map<string, PoolClassDef>();
  for (const [code, def] of Object.entries(TAX_DEPRECIATION_REGIMES[regime]?.classes ?? {})) map.set(code, def);
  const rows = (await db.execute(sql`
    select class_code, name, rate::text as rate, method, first_year_fraction::text as fyf,
           allow_recapture, allow_terminal_loss, cost_cap::text as cost_cap,
           depreciation_system, macrs_method, recovery_period_years::text as recovery_period_years, convention
      from tax_pool_classes where org_id = ${orgId} and regime = ${regime} and is_active`)) as unknown as {
    rows: { class_code: string; name: string; rate: string; method: "declining" | "straight_line"; fyf: string; allow_recapture: boolean; allow_terminal_loss: boolean; cost_cap: string | null; depreciation_system: "gds" | "ads" | null; macrs_method: "200_db" | "150_db" | "straight_line" | null; recovery_period_years: string | null; convention: "half_year" | "mid_quarter" | "mid_month" | null }[];
  };
  for (const r of rows.rows) {
    map.set(r.class_code, {
      code: r.class_code, rate: r.rate, method: r.method, firstYearFraction: r.fyf,
      allowRecapture: r.allow_recapture, allowTerminalLoss: r.allow_terminal_loss,
      costCap: r.cost_cap ?? undefined, name: r.name,
      depreciationSystem: r.depreciation_system ?? undefined,
      macrsMethod: r.macrs_method ?? undefined,
      recoveryPeriodYears: r.recovery_period_years ?? undefined,
      convention: r.convention ?? undefined,
    });
  }
  return map;
}

/** Regimes available for a run/picker: company-country built-ins plus matching
 * tenant-defined regimes. An inactive tenant row can explicitly hide a built-in. */
export async function listTaxRegimes(orgId: string): Promise<{ code: string; name: string; countryCode: string | null; calculationModel: "pool" | "macrs" }[]> {
  const org = (await db.execute(sql`select upper(country) as country from orgs where id = ${orgId}`)) as unknown as { rows: { country: string }[] };
  const country = org.rows[0]?.country ?? "";
  const byCode = new Map<string, { code: string; name: string; countryCode: string | null; calculationModel: "pool" | "macrs" }>();
  for (const r of Object.values(TAX_DEPRECIATION_REGIMES)) {
    if (r.countryCode === country) byCode.set(r.code, { code: r.code, name: r.name, countryCode: r.countryCode, calculationModel: r.calculationModel });
  }
  const rows = (await db.execute(sql`
    select code, name, upper(country_code) as country_code, calculation_model, is_active
      from tax_regimes where org_id = ${orgId}`)) as unknown as { rows: { code: string; name: string; country_code: string | null; calculation_model: "pool" | "macrs"; is_active: boolean }[] };
  for (const r of rows.rows) {
    if (!r.is_active) { byCode.delete(r.code); continue; }
    // Explicitly installed tenant regimes remain available even when they are
    // for a country other than the company default (multi-jurisdiction groups).
    byCode.set(r.code, { code: r.code, name: r.name, countryCode: r.country_code, calculationModel: r.calculation_model });
  }
  return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function runTaxPool(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  regime: string,
  taxYear: number,
  opts: { yearStart: string; yearEnd: string; shortYearFactor?: string | number; actorId: string | null },
): Promise<TaxPoolRunResult> {
  const classes = await effectiveClasses(orgId, regime);
  if (classes.size === 0) throw new TaxPoolError(`unknown tax depreciation regime "${regime}"`);
  const attr = await regimeClassAttribute(orgId, regime);
  if (await regimeModel(orgId, regime) === "macrs") {
    return runMacrs(orgId, bookId, subsidiaryId, regime, taxYear, opts, attr, classes);
  }

  // Additions this year + whether the class still holds assets at year-end.
  const classRows = (await db.execute(sql`
    select c.tax_attributes->>${attr} as class_code,
           coalesce(sum(case when coalesce(a.in_service_on, a.acquired_on) between ${opts.yearStart} and ${opts.yearEnd}
                             then a.acquisition_cost else 0 end), 0)::text as additions,
           bool_or(a.status not in ('disposed', 'written_off')) as has_assets
      from fixed_assets a
      join asset_categories c on c.id = a.category_id
     where a.org_id = ${orgId} and a.subsidiary_id = ${subsidiaryId}
       and coalesce(c.tax_attributes->>${attr}, '') <> ''
     group by c.tax_attributes->>${attr}`)) as unknown as {
    rows: { class_code: string; additions: string; has_assets: boolean }[];
  };

  // Dispositions this year: Σ least(proceeds, capital cost) per class.
  const dispRows = (await db.execute(sql`
    select c.tax_attributes->>${attr} as class_code,
           coalesce(sum(least(e.amount, a.acquisition_cost)), 0)::text as dispositions
      from asset_events e
      join fixed_assets a on a.id = e.asset_id
      join asset_categories c on c.id = a.category_id
     where e.org_id = ${orgId} and a.subsidiary_id = ${subsidiaryId}
       and e.kind in ('disposed', 'written_off') and e.occurred_on between ${opts.yearStart} and ${opts.yearEnd}
       and coalesce(c.tax_attributes->>${attr}, '') <> ''
     group by c.tax_attributes->>${attr}`)) as unknown as {
    rows: { class_code: string; dispositions: string }[];
  };
  const dispByClass = new Map(dispRows.rows.map((r) => [r.class_code, r.dispositions]));

  const lines: TaxPoolLine[] = [];
  let totAllow = "0", totRecap = "0", totTerm = "0";

  for (const row of classRows.rows) {
    const classCode = row.class_code;
    const classDef = classes.get(classCode);
    if (!classDef) continue; // unknown class code — skip rather than guess
    const dispositions = dispByClass.get(classCode) ?? "0";

    const pool = await ensurePool(orgId, bookId, subsidiaryId, regime, classDef, opts.actorId);
    const openingBalance = await openingForTaxYear(orgId, pool.id, taxYear, pool.openingBalance);
    const rule = await firstYearRule(orgId, regime, classCode, opts.yearEnd, classDef.firstYearFraction);

    const result = computePoolYear({
      openingBalance,
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

type MacrsAssetRow = {
  id: string;
  class_code: string;
  acquisition_cost: string;
  placed_on: string;
  disposed_on: string | null;
  disposition_amount: string | null;
  custom: Record<string, unknown> | null;
};

async function runMacrs(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  regime: string,
  taxYear: number,
  opts: { yearStart: string; yearEnd: string; shortYearFactor?: string | number; actorId: string | null },
  attr: string,
  classes: Map<string, PoolClassDef>,
): Promise<TaxPoolRunResult> {
  const assets = (await db.execute(sql`
    select a.id,
           coalesce(a.custom->'taxDepreciation'->${regime}->>'classCode', c.tax_attributes->>${attr}) as class_code,
           a.acquisition_cost::text, coalesce(a.in_service_on, a.acquired_on)::text as placed_on,
           d.occurred_on::text as disposed_on, d.amount::text as disposition_amount, a.custom
      from fixed_assets a
      join asset_categories c on c.id = a.category_id
      left join lateral (
        select e.occurred_on, e.amount from asset_events e
         where e.asset_id = a.id and e.kind in ('disposed', 'written_off')
         order by e.occurred_on limit 1
      ) d on true
     where a.org_id = ${orgId} and a.subsidiary_id = ${subsidiaryId}
       and coalesce(a.in_service_on, a.acquired_on) is not null
       and coalesce(a.custom->'taxDepreciation'->${regime}->>'classCode', c.tax_attributes->>${attr}, '') <> ''`)) as unknown as { rows: MacrsAssetRow[] };

  // The mid-quarter test is made per placed-in-service vintage. If more than
  // 40% of eligible basis was placed in service in the final three months,
  // that vintage uses mid-quarter instead of half-year for its full schedule.
  const vintageBasis = new Map<number, { total: bigint; q4: bigint }>();
  for (const asset of assets.rows) {
    const def = classes.get(asset.class_code);
    if (!def || def.convention !== "half_year" || asset.disposed_on?.slice(0, 4) === asset.placed_on.slice(0, 4)) continue;
    const year = Number(asset.placed_on.slice(0, 4));
    const amount = toUnits(asset.acquisition_cost);
    const v = vintageBasis.get(year) ?? { total: 0n, q4: 0n };
    v.total += amount;
    if (Number(asset.placed_on.slice(5, 7)) >= 10) v.q4 += amount;
    vintageBasis.set(year, v);
  }

  const grouped = new Map<string, { def: PoolClassDef; assets: MacrsAssetRow[] }>();
  for (const asset of assets.rows) {
    const def = classes.get(asset.class_code);
    if (!def?.recoveryPeriodYears || !def.macrsMethod || !def.convention) continue;
    const group = grouped.get(asset.class_code) ?? { def, assets: [] };
    group.assets.push(asset);
    grouped.set(asset.class_code, group);
  }

  const lines: TaxPoolLine[] = [];
  let totalAllowance = "0";
  for (const [classCode, group] of grouped) {
    let opening = 0n, additions = 0n, dispositions = 0n, allowance = 0n, closing = 0n;
    for (const asset of group.assets) {
      const config = taxAssetConfig(asset.custom, regime);
      const placedYear = Number(asset.placed_on.slice(0, 4));
      const vintage = vintageBasis.get(placedYear);
      const convention = group.def.convention === "half_year" && vintage && vintage.total > 0n && vintage.q4 * 100n > vintage.total * 40n
        ? "mid_quarter"
        : group.def.convention!;
      const input = {
        basis: asset.acquisition_cost,
        placedInServiceOn: asset.placed_on,
        recoveryPeriodYears: group.def.recoveryPeriodYears!,
        method: group.def.macrsMethod!,
        convention,
        disposedOn: asset.disposed_on,
        section179: String(config.section179 ?? "0"),
        bonusPercent: decimalOr(config.bonusPercent, "0"),
        businessUsePercent: decimalOr(config.businessUsePercent, "100"),
      } as const;
      const current = computeMacrsYear({ ...input, taxYear });
      const prior = computeMacrsYear({ ...input, taxYear: taxYear - 1 });
      if (placedYear < taxYear) opening += toUnits(prior.remainingBasis);
      if (placedYear === taxYear) additions += toUnits(asset.acquisition_cost);
      if (asset.disposed_on?.slice(0, 4) === String(taxYear)) dispositions += toUnits(asset.disposition_amount ?? "0");
      allowance += toUnits(current.allowance);
      closing += toUnits(current.remainingBasis);
    }

    const pool = await ensurePool(orgId, bookId, subsidiaryId, regime, group.def, opts.actorId);
    const values = {
      openingBalance: formatMoney(fromUnits(opening), 2), additions: formatMoney(fromUnits(additions), 2), dispositions: formatMoney(fromUnits(dispositions), 2),
      netAdditions: formatMoney(fromUnits(additions > dispositions ? additions - dispositions : 0n), 2), immediateExpense: "0.00",
      base: formatMoney(fromUnits(opening + additions), 2), allowance: formatMoney(fromUnits(allowance), 2), closingBalance: formatMoney(fromUnits(closing), 2),
      recapture: "0.00", terminalLoss: "0.00",
    };
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into tax_pool_periods
          (org_id, pool_id, tax_year, opening_balance, additions, dispositions, net_additions,
           immediate_expense, base, allowance, closing_balance, recapture, terminal_loss,
           short_year_factor, created_by, updated_by)
        values (${orgId}, ${pool.id}, ${taxYear}, ${values.openingBalance}, ${values.additions},
                ${values.dispositions}, ${values.netAdditions}, ${values.immediateExpense}, ${values.base},
                ${values.allowance}, ${values.closingBalance}, 0, 0, ${opts.shortYearFactor ?? 1}, ${opts.actorId}, ${opts.actorId})
        on conflict (org_id, pool_id, tax_year) do update set
          opening_balance=excluded.opening_balance, additions=excluded.additions, dispositions=excluded.dispositions,
          net_additions=excluded.net_additions, immediate_expense=excluded.immediate_expense, base=excluded.base,
          allowance=excluded.allowance, closing_balance=excluded.closing_balance, recapture=0, terminal_loss=0,
          short_year_factor=excluded.short_year_factor, updated_at=now(), updated_by=${opts.actorId}`);
      await tx.execute(sql`update tax_depreciation_pools set opening_balance=${values.closingBalance}, updated_at=now(), updated_by=${opts.actorId} where id=${pool.id}`);
    });
    lines.push({ classCode, className: group.def.name, openingBalance: values.openingBalance, additions: values.additions, dispositions: values.dispositions, allowance: values.allowance, closingBalance: values.closingBalance, recapture: "0.00", terminalLoss: "0.00" });
    totalAllowance = addStr(totalAllowance, values.allowance);
  }
  return { regime, taxYear, lines, totals: { allowance: totalAllowance, recapture: "0.00", terminalLoss: "0.00" } };
}

function taxAssetConfig(custom: Record<string, unknown> | null, regime: string): Record<string, unknown> {
  const root = custom?.taxDepreciation;
  if (!root || typeof root !== "object" || Array.isArray(root)) return {};
  const value = (root as Record<string, unknown>)[regime];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function decimalOr(value: unknown, fallback: string): string {
  try {
    return normalizeMoney(String(value ?? fallback));
  } catch {
    return fallback;
  }
}

const addStr = (a: string, b: string) => formatMoney(add(a, b), 2);

/** Re-running a year must use that year's original opening, not the mutable
 * pool carry-forward balance. A new year opens from the latest prior close. */
async function openingForTaxYear(orgId: string, poolId: string, taxYear: number, fallback: string): Promise<string> {
  const rows = (await db.execute(sql`
    select opening_balance::text as opening, tax_year
      from tax_pool_periods
     where org_id=${orgId} and pool_id=${poolId} and tax_year <= ${taxYear}
     order by tax_year desc limit 1`)) as unknown as { rows: { opening: string; tax_year: number }[] };
  const latest = rows.rows[0];
  if (latest?.tax_year === taxYear) return latest.opening;
  if (latest) {
    const prior = (await db.execute(sql`
      select closing_balance::text as closing from tax_pool_periods
       where org_id=${orgId} and pool_id=${poolId} and tax_year < ${taxYear}
       order by tax_year desc limit 1`)) as unknown as { rows: { closing: string }[] };
    return prior.rows[0]?.closing ?? fallback;
  }
  return fallback;
}

async function ensurePool(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  regime: string,
  classDef: { code: string; rate: string | number; method: "declining" | "straight_line" },
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
