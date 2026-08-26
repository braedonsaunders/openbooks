import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "./db.ts";
import { canonicalDecimal } from "./exact-decimal.ts";
import { add, formatMoney, fromUnits, normalizeDecimal, normalizeMoney, toUnits } from "./money.ts";
import { computeMacrsYear, computePoolYear, type PoolClassDef, type PoolYearResult, TAX_DEPRECIATION_REGIMES } from "./tax-depreciation-pool.ts";

/**
 * Run a jurisdiction's tax depreciation pools for a tax year on a book. Groups
 * the org's assets by their regime class (from the asset category's
 * tax_attributes), derives additions (assets placed in service in the year) and
 * dispositions (asset events, capped at capital cost), then runs the pure
 * per-pool waterfall (computePoolYear), persisting each result and rolling the
 * pool's balance forward. Canada CCA is the first regime; the engine is generic.
 *
 * A run is ONE atomic unit fenced against concurrent runs on the same scope:
 *   - every read, computation and write happens inside a single transaction,
 *     so a failure mid-year persists nothing — never some classes' periods
 *     with the roll-forward missing (a partial year);
 *   - a transaction-scoped advisory lock keyed per (org, book, subsidiary,
 *     regime) serializes runs of that scope, and an ordering guard only lets
 *     a run through when it re-runs the latest computed year or appends its
 *     immediate successor. Two concurrent runs of adjacent years therefore end
 *     deterministically — chained in order, or the earlier year refused — and
 *     can no longer interleave openings/closings across each other.
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

/** Everything one annual run needs; fixed by runTaxPool before dispatch. */
interface TaxPoolRun {
  orgId: string;
  bookId: string;
  subsidiaryId: string;
  regime: string;
  taxYear: number;
  yearStart: string;
  yearEnd: string;
  shortYearFactor: string;
  actorId: string | null;
}

/** Transaction-scoped fence key: one annual run per (org, book, subsidiary,
 *  regime) scope at a time. Different scopes never contend. */
export function taxPoolRunLockKey(orgId: string, bookId: string, subsidiaryId: string, regime: string): string {
  return `tax-pool-run:${orgId}:${bookId}:${subsidiaryId}:${regime}`;
}

/** Effective first-year rule (fraction + enhanced multiplier) for a class on a
 *  date — a tenant config row if one matches, else the regime class default. */
async function firstYearRule(
  tx: SqlExecutor,
  orgId: string,
  regime: string,
  classCode: string,
  onDate: string,
  defaultFraction: string | number,
): Promise<{ firstYearFraction: string | number; enhancedMultiplier?: string }> {
  const r = (await tx.execute<{ fraction: string; mult: string | null }>(sql`
    select first_year_fraction::text as fraction, enhanced_multiplier::text as mult
      from tax_first_year_rules
     where org_id = ${orgId} and regime = ${regime}
       and (class_code = ${classCode} or class_code is null)
       and (acquired_from is null or acquired_from <= ${onDate})
       and (acquired_to is null or acquired_to >= ${onDate})
     order by class_code nulls last, acquired_from desc nulls last
     limit 1`));
  const row = r.rows[0];
  if (!row) return { firstYearFraction: defaultFraction };
  return { firstYearFraction: row.fraction, enhancedMultiplier: row.mult ?? undefined };
}

/** The asset-category tax_attributes key that carries a class code for a regime.
 *  An org regime row can override it; Canadian configurations use "ca_cca_class". */
async function regimeClassAttribute(tx: SqlExecutor, orgId: string, regime: string): Promise<string> {
  const r = (await tx.execute<{ class_attribute: string }>(sql`
    select class_attribute from tax_regimes where org_id = ${orgId} and code = ${regime} and is_active limit 1`));
  return r.rows[0]?.class_attribute ?? TAX_DEPRECIATION_REGIMES[regime]?.classAttribute ?? "tax_pool_class";
}

async function regimeModel(tx: SqlExecutor, orgId: string, regime: string): Promise<"pool" | "macrs"> {
  const r = (await tx.execute<{ calculation_model: "pool" | "macrs" }>(sql`
    select calculation_model from tax_regimes where org_id = ${orgId} and code = ${regime} and is_active limit 1`));
  return r.rows[0]?.calculation_model ?? TAX_DEPRECIATION_REGIMES[regime]?.calculationModel ?? "pool";
}

/** Effective class definitions for a regime: built-in defaults with org
 *  tax_pool_classes rows merged on top (org wins). */
async function effectiveClasses(tx: SqlExecutor, orgId: string, regime: string): Promise<Map<string, PoolClassDef>> {
  const map = new Map<string, PoolClassDef>();
  for (const [code, def] of Object.entries(TAX_DEPRECIATION_REGIMES[regime]?.classes ?? {})) map.set(code, def);
  const rows = (await tx.execute<{ class_code: string; name: string; rate: string; method: "declining" | "straight_line"; fyf: string; allow_recapture: boolean; allow_terminal_loss: boolean; cost_cap: string | null; depreciation_system: "gds" | "ads" | null; macrs_method: "200_db" | "150_db" | "straight_line" | null; recovery_period_years: string | null; convention: "half_year" | "mid_quarter" | "mid_month" | null }>(sql`
    select class_code, name, rate::text as rate, method, first_year_fraction::text as fyf,
           allow_recapture, allow_terminal_loss, cost_cap::text as cost_cap,
           depreciation_system, macrs_method, recovery_period_years::text as recovery_period_years, convention
      from tax_pool_classes where org_id = ${orgId} and regime = ${regime} and is_active`));
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
  const org = (await db.execute<{ country: string }>(sql`select upper(country) as country from orgs where id = ${orgId}`));
  const country = org.rows[0]?.country ?? "";
  const byCode = new Map<string, { code: string; name: string; countryCode: string | null; calculationModel: "pool" | "macrs" }>();
  for (const r of Object.values(TAX_DEPRECIATION_REGIMES)) {
    if (r.countryCode === country) byCode.set(r.code, { code: r.code, name: r.name, countryCode: r.countryCode, calculationModel: r.calculationModel });
  }
  const rows = (await db.execute<{ code: string; name: string; country_code: string | null; calculation_model: "pool" | "macrs"; is_active: boolean }>(sql`
    select code, name, upper(country_code) as country_code, calculation_model, is_active
      from tax_regimes where org_id = ${orgId}`));
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
  // Pure input validation before any database work: a rejected run must not
  // open (or wait on) the scope fence.
  const shortYearFactor = normalizeDecimal(opts.shortYearFactor ?? 1, 10);

  // One transaction for the whole year. The advisory lock is taken inside it
  // BEFORE any state is read, so two runs of this scope — same or adjacent
  // years — fully serialize, and a mid-year failure rolls back everything.
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${taxPoolRunLockKey(orgId, bookId, subsidiaryId, regime)}, 0))`);

    const classes = await effectiveClasses(tx, orgId, regime);
    if (classes.size === 0) throw new TaxPoolError(`unknown tax depreciation regime "${regime}"`);
    const attr = await regimeClassAttribute(tx, orgId, regime);
    const model = await regimeModel(tx, orgId, regime);

    await fenceRunOrdering(tx, orgId, bookId, subsidiaryId, regime, taxYear);

    const run: TaxPoolRun = { orgId, bookId, subsidiaryId, regime, taxYear, yearStart: opts.yearStart, yearEnd: opts.yearEnd, shortYearFactor, actorId: opts.actorId };
    return model === "macrs"
      ? runMacrs(tx, run, attr, classes)
      : runPools(tx, run, attr, classes);
  });
}

/**
 * Adjacent-year fencing, evaluated under the scope's advisory lock: only an
 * idempotent re-run of the latest computed year, or its immediate successor,
 * may proceed. Anything else would silently misstate the carry-forward chain —
 * restating an early year invalidates the later closings already on file, and
 * skipping a year would claim no allowance on the carried balance while still
 * opening from it. Concurrent adjacent-year races lose safely: whichever run
 * commits first sets the ordering, and the other gets this refusal instead of
 * corrupting balances.
 */
async function fenceRunOrdering(
  tx: SqlExecutor,
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  regime: string,
  taxYear: number,
): Promise<void> {
  const latest = await latestComputedTaxYear(tx, orgId, bookId, subsidiaryId, regime);
  if (latest === null || taxYear === latest || taxYear === latest + 1) return;
  if (taxYear < latest) {
    throw new TaxPoolError(
      `tax year ${taxYear} cannot be run because tax year ${latest} is already computed for this regime; ` +
      `years are computed forward in order, so a closed year can only be restated by removing the later years that build on it and re-running them`,
    );
  }
  throw new TaxPoolError(
    `tax year ${taxYear} cannot be computed before tax year ${latest + 1}; ` +
    `each pool year opens from the previous year's closing balance, so years must be run consecutively`,
  );
}

/** The latest tax year already computed anywhere in a run scope (null before
 *  the first run). Periods exist only for pools this module created, so this
 *  spans every pool of the (org, book, subsidiary, regime) scope. */
async function latestComputedTaxYear(
  tx: SqlExecutor,
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  regime: string,
): Promise<number | null> {
  const r = (await tx.execute<{ latest: number | null }>(sql`
    select max(pp.tax_year)::int as latest
      from tax_pool_periods pp
      join tax_depreciation_pools tp on tp.id = pp.pool_id and tp.org_id = pp.org_id
     where tp.org_id = ${orgId} and tp.book_id = ${bookId}
       and tp.subsidiary_id = ${subsidiaryId} and tp.regime = ${regime}`));
  return r.rows[0]?.latest ?? null;
}

async function runPools(
  tx: SqlExecutor,
  run: TaxPoolRun,
  attr: string,
  classes: Map<string, PoolClassDef>,
): Promise<TaxPoolRunResult> {
  const { orgId, taxYear } = run;

  // Additions this year + whether the class still holds assets at year-end.
  // Classes are resolved in an inner select so GROUP BY/ORDER BY reference the
  // plain `class_code` column instead of re-binding the attribute key (distinct
  // placeholders make otherwise identical JSON-key expressions incomparable).
  const classRows = (await tx.execute<{ class_code: string; additions: string; has_assets: boolean }>(sql`
    select class_code,
           coalesce(sum(case when placed_on between ${run.yearStart} and ${run.yearEnd}
                             then acquisition_cost else 0 end), 0)::text as additions,
           bool_or(status not in ('disposed', 'written_off')) as has_assets
      from (
        select a.acquisition_cost, a.status,
               coalesce(a.in_service_on, a.acquired_on) as placed_on,
               c.tax_attributes->>${attr} as class_code
          from fixed_assets a
          join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
         where a.org_id = ${orgId} and a.subsidiary_id = ${run.subsidiaryId}
           and coalesce(c.tax_attributes->>${attr}, '') <> ''
      ) classified
     group by class_code
     order by class_code`));

  // Dispositions this year: Σ least(proceeds, capital cost) per class.
  const dispRows = (await tx.execute<{ class_code: string; dispositions: string }>(sql`
    select class_code,
           coalesce(sum(least(amount, capital_cost)), 0)::text as dispositions
      from (
        select e.amount, a.acquisition_cost as capital_cost,
               c.tax_attributes->>${attr} as class_code
          from asset_events e
          join fixed_assets a on a.id = e.asset_id and a.org_id = e.org_id
          join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
         where e.org_id = ${orgId} and a.subsidiary_id = ${run.subsidiaryId}
           and e.kind in ('disposed', 'written_off')
           and e.occurred_on between ${run.yearStart} and ${run.yearEnd}
           and coalesce(c.tax_attributes->>${attr}, '') <> ''
      ) classified
     group by class_code`));
  const dispByClass = new Map(dispRows.rows.map((r) => [r.class_code, r.dispositions]));

  // Compute every class FIRST (reads only once pools exist), then persist all
  // results below in this same transaction — the year lands whole or not at all.
  const prepared: { poolId: string; classCode: string; def: PoolClassDef; result: PoolYearResult; enhancedMultiplier: string | null }[] = [];
  for (const row of classRows.rows) {
    const classCode = row.class_code;
    const classDef = classes.get(classCode);
    if (!classDef) continue; // unknown class code — skip rather than guess
    const dispositions = dispByClass.get(classCode) ?? "0";

    const pool = await ensurePool(tx, run, classDef);
    const openingBalance = await openingForTaxYear(tx, orgId, pool.id, taxYear, pool.openingBalance);
    const rule = await firstYearRule(tx, orgId, run.regime, classCode, run.yearEnd, classDef.firstYearFraction);

    const result = computePoolYear({
      openingBalance,
      additions: row.additions,
      dispositions,
      rate: classDef.rate,
      firstYearFraction: rule.firstYearFraction,
      enhancedFirstYearMultiplier: rule.enhancedMultiplier,
      shortYearFactor: run.shortYearFactor,
      poolHasAssetsAtYearEnd: row.has_assets,
      allowRecapture: classDef.allowRecapture,
      allowTerminalLoss: classDef.allowTerminalLoss,
    });

    prepared.push({ poolId: pool.id, classCode, def: classDef, result, enhancedMultiplier: rule.enhancedMultiplier ?? null });
  }

  const lines: TaxPoolLine[] = [];
  let totAllow = "0", totRecap = "0", totTerm = "0";

  for (const p of prepared) {
    await tx.execute(sql`
      insert into tax_pool_periods
        (org_id, pool_id, tax_year, opening_balance, additions, dispositions, net_additions,
         immediate_expense, base, allowance, closing_balance, recapture, terminal_loss,
         short_year_factor, enhanced_multiplier, created_by, updated_by)
      values (${orgId}, ${p.poolId}, ${taxYear}, ${p.result.openingBalance}, ${p.result.additions},
              ${p.result.dispositions}, ${p.result.netAdditions}, ${p.result.immediateExpense}, ${p.result.base},
              ${p.result.allowance}, ${p.result.closingBalance}, ${p.result.recapture}, ${p.result.terminalLoss},
              ${run.shortYearFactor}, ${p.enhancedMultiplier}, ${run.actorId}, ${run.actorId})
      on conflict (org_id, pool_id, tax_year) do update set
        opening_balance = excluded.opening_balance, additions = excluded.additions,
        dispositions = excluded.dispositions, net_additions = excluded.net_additions,
        immediate_expense = excluded.immediate_expense, base = excluded.base,
        allowance = excluded.allowance, closing_balance = excluded.closing_balance,
        recapture = excluded.recapture, terminal_loss = excluded.terminal_loss,
        short_year_factor = excluded.short_year_factor, enhanced_multiplier = excluded.enhanced_multiplier,
        updated_at = now(), updated_by = ${run.actorId}
      where tax_pool_periods.org_id = ${orgId}`);
    await tx.execute(sql`
      update tax_depreciation_pools set opening_balance = ${p.result.closingBalance}, updated_at = now(), updated_by = ${run.actorId}
       where id = ${p.poolId} and org_id = ${orgId}`);

    lines.push({
      classCode: p.classCode, className: p.def.name,
      openingBalance: p.result.openingBalance, additions: p.result.additions, dispositions: p.result.dispositions,
      allowance: p.result.allowance, closingBalance: p.result.closingBalance,
      recapture: p.result.recapture, terminalLoss: p.result.terminalLoss,
    });
    totAllow = addStr(totAllow, p.result.allowance);
    totRecap = addStr(totRecap, p.result.recapture);
    totTerm = addStr(totTerm, p.result.terminalLoss);
  }

  return { regime: run.regime, taxYear, lines, totals: { allowance: totAllow, recapture: totRecap, terminalLoss: totTerm } };
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
  tx: SqlExecutor,
  run: TaxPoolRun,
  attr: string,
  classes: Map<string, PoolClassDef>,
): Promise<TaxPoolRunResult> {
  const { orgId, taxYear } = run;
  const assets = (await tx.execute<MacrsAssetRow>(sql`
    select a.id,
           coalesce(a.custom->'taxDepreciation'->${run.regime}->>'classCode', c.tax_attributes->>${attr}) as class_code,
           a.acquisition_cost::text, coalesce(a.in_service_on, a.acquired_on)::text as placed_on,
           d.occurred_on::text as disposed_on, d.amount::text as disposition_amount, a.custom
      from fixed_assets a
      join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
      left join lateral (
        select e.occurred_on, e.amount from asset_events e
         where e.asset_id = a.id and e.org_id = a.org_id and e.org_id = ${orgId}
           and e.kind in ('disposed', 'written_off')
         order by e.occurred_on limit 1
      ) d on true
     where a.org_id = ${orgId} and a.subsidiary_id = ${run.subsidiaryId}
       and coalesce(a.in_service_on, a.acquired_on) is not null
       and coalesce(a.custom->'taxDepreciation'->${run.regime}->>'classCode', c.tax_attributes->>${attr}, '') <> ''`));

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

  // Compute every class first, then persist all periods and roll-forwards in
  // this one transaction — identical atomicity contract to the pooled model.
  const prepared: { poolId: string; classCode: string; def: PoolClassDef; values: ReturnType<typeof macrsValues> }[] = [];
  let totalAllowance = "0";
  for (const [classCode, group] of grouped) {
    let opening = 0n, additions = 0n, dispositions = 0n, allowance = 0n, closing = 0n;
    for (const asset of group.assets) {
      const config = taxAssetConfig(asset.custom, run.regime);
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

    const pool = await ensurePool(tx, run, group.def);
    prepared.push({ poolId: pool.id, classCode, def: group.def, values: macrsValues(opening, additions, dispositions, allowance, closing) });
  }

  const lines: TaxPoolLine[] = [];
  for (const p of prepared) {
    await tx.execute(sql`
      insert into tax_pool_periods
        (org_id, pool_id, tax_year, opening_balance, additions, dispositions, net_additions,
         immediate_expense, base, allowance, closing_balance, recapture, terminal_loss,
         short_year_factor, created_by, updated_by)
      values (${orgId}, ${p.poolId}, ${taxYear}, ${p.values.openingBalance}, ${p.values.additions},
              ${p.values.dispositions}, ${p.values.netAdditions}, ${p.values.immediateExpense}, ${p.values.base},
              ${p.values.allowance}, ${p.values.closingBalance}, 0, 0, ${run.shortYearFactor}, ${run.actorId}, ${run.actorId})
      on conflict (org_id, pool_id, tax_year) do update set
        opening_balance=excluded.opening_balance, additions=excluded.additions, dispositions=excluded.dispositions,
        net_additions=excluded.net_additions, immediate_expense=excluded.immediate_expense, base=excluded.base,
        allowance=excluded.allowance, closing_balance=excluded.closing_balance, recapture=0, terminal_loss=0,
        short_year_factor=excluded.short_year_factor, updated_at=now(), updated_by=${run.actorId}
      where tax_pool_periods.org_id = ${orgId}`);
    await tx.execute(sql`update tax_depreciation_pools set opening_balance=${p.values.closingBalance}, updated_at=now(), updated_by=${run.actorId} where id=${p.poolId} and org_id=${orgId}`);
    lines.push({ classCode: p.classCode, className: p.def.name, openingBalance: p.values.openingBalance, additions: p.values.additions, dispositions: p.values.dispositions, allowance: p.values.allowance, closingBalance: p.values.closingBalance, recapture: "0.00", terminalLoss: "0.00" });
    totalAllowance = addStr(totalAllowance, p.values.allowance);
  }
  return { regime: run.regime, taxYear, lines, totals: { allowance: totalAllowance, recapture: "0.00", terminalLoss: "0.00" } };
}

function macrsValues(opening: bigint, additions: bigint, dispositions: bigint, allowance: bigint, closing: bigint) {
  return {
    openingBalance: formatMoney(fromUnits(opening), 2), additions: formatMoney(fromUnits(additions), 2), dispositions: formatMoney(fromUnits(dispositions), 2),
    netAdditions: formatMoney(fromUnits(additions > dispositions ? additions - dispositions : 0n), 2), immediateExpense: "0.00",
    base: formatMoney(fromUnits(opening + additions), 2), allowance: formatMoney(fromUnits(allowance), 2), closingBalance: formatMoney(fromUnits(closing), 2),
    recapture: "0.00", terminalLoss: "0.00",
  };
}

function taxAssetConfig(custom: Record<string, unknown> | null, regime: string): Record<string, unknown> {
  const root = custom?.taxDepreciation;
  if (!root || typeof root !== "object" || Array.isArray(root)) return {};
  const value = (root as Record<string, unknown>)[regime];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function decimalOr(value: unknown, fallback: string): string {
  const exact = canonicalDecimal(value ?? fallback, 4);
  if (exact === null) throw new TaxPoolError("percent must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new TaxPoolError("percent must be an exact decimal");
  }
}

const addStr = (a: string, b: string) => formatMoney(add(a, b), 2);

/**
 * Re-running a year must use that year's original opening, not the mutable
 * pool carry-forward balance, so a re-run reproduces the same numbers; a new
 * year opens from the latest prior close. The run-ordering fence guarantees
 * any prior period is at most `taxYear - 1`.
 */
async function openingForTaxYear(tx: SqlExecutor, orgId: string, poolId: string, taxYear: number, fallback: string): Promise<string> {
  const rerun = (await tx.execute<{ opening: string }>(sql`
    select opening_balance::text as opening
      from tax_pool_periods
     where org_id=${orgId} and pool_id=${poolId} and tax_year = ${taxYear}
     limit 1`));
  if (rerun.rows[0]) return rerun.rows[0].opening;
  const prior = (await tx.execute<{ closing: string }>(sql`
    select closing_balance::text as closing
      from tax_pool_periods
     where org_id=${orgId} and pool_id=${poolId} and tax_year < ${taxYear}
     order by tax_year desc limit 1`));
  return prior.rows[0]?.closing ?? fallback;
}

async function ensurePool(
  tx: SqlExecutor,
  run: TaxPoolRun,
  classDef: { code: string; rate: string | number; method: "declining" | "straight_line" },
): Promise<{ id: string; openingBalance: string }> {
  const existing = (await tx.execute<{ id: string; opening: string }>(sql`
    select id, opening_balance::text as opening from tax_depreciation_pools
     where org_id = ${run.orgId} and book_id = ${run.bookId} and subsidiary_id = ${run.subsidiaryId}
       and regime = ${run.regime} and class_code = ${classDef.code} and is_separate_class = false
     limit 1`));
  if (existing.rows[0]) return { id: existing.rows[0].id, openingBalance: existing.rows[0].opening };
  // Under the scope's advisory lock no concurrent run can be inserting the
  // same pool, so this check-then-insert cannot race.
  const ins = (await tx.execute<{ id: string }>(sql`
    insert into tax_depreciation_pools (org_id, book_id, subsidiary_id, regime, class_code, rate, method, created_by, updated_by)
    values (${run.orgId}, ${run.bookId}, ${run.subsidiaryId}, ${run.regime}, ${classDef.code}, ${normalizeDecimal(classDef.rate, 10)}, ${classDef.method}, ${run.actorId}, ${run.actorId})
    returning id`));
  return { id: ins.rows[0]!.id, openingBalance: "0" };
}
