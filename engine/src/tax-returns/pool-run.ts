import { lockAssetTaxLifecycle } from "../organization/asset-tax-fence.ts";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { add, formatMoney, fromUnits, normalizeDecimal, normalizeMoney, toUnits } from "../money/money.ts";
import {
  computeMacrsThroughYear,
  computePoolYear,
  macrsConventionAfterMidQuarter,
  macrsMidQuarterByTaxYear,
  type MacrsYearWindow,
  type PoolClassDef,
  type PoolYearResult,
  TAX_DEPRECIATION_REGIMES,
} from "./depreciation-pool.ts";
import { MacrsShortYearError, assertShortYearFactorAgrees } from "./macrs-short-year.ts";
import { MacrsVintageError, resolveMacrsVintages, type MacrsWorkpaperEvent } from "./macrs-vintages.ts";
import { continuingNzAssociatedRates, nzPooledDepreciationRate, TaxBasisPolicyError } from "./asset-basis-policy.ts";
import { effectiveClasses, regimeClassAttribute } from "./tax-classification.ts";
import { legacyPoolDisposition, taxEventRequiresTaxWorkpaper } from "./pool-run-legacy.ts";

export { legacyPoolDisposition, taxEventRequiresTaxWorkpaper } from "./pool-run-legacy.ts";

/**
 * Run a jurisdiction's tax depreciation pools for a tax year on a book. Groups
 * the org's assets by their regime class (from the asset category's
 * tax_attributes), derives additions (assets placed in service in the year) and
 * dispositions, then runs the pure per-pool waterfall (computePoolYear),
 * persisting each result and rolling the pool's balance forward. Canada CCA is
 * the first regime; the engine is generic.
 *
 * Disposition sources stay split on purpose:
 *   - legacy `disposed` / `written_off` with financial_change_id NULL keep
 *     lesser-of-proceeds-and-capital-cost, scoped to this book and cut off
 *     by a same-or-earlier reversal;
 *   - native governed changes (financial_change_id, partials, transfers)
 *     consume an approved tax workpaper and refuse if it is missing.
 * Do not fold the first path into the second without a backfill.
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

type LiveWorkpaper = {
  asset_id: string;
  receiving_asset_id: string | null;
  effective_on: string;
  source_operation: "partial_disposal" | "intercompany_transfer";
  applicable: "seller" | "buyer" | "both";
  seller_disposition: string | null;
  buyer_addition: string | null;
  remaining_basis: string | null;
  seller_subsidiary_id: string;
  seller_class: string;
  buyer_subsidiary_id: string | null;
  buyer_class: string | null;
  short_year_method: string | null;
  placed_in_service_on: string | null;
  macrs_method: string | null;
  macrs_convention: string | null;
  carryover_basis: string | null;
  excess_basis: string | null;
  buyer_cost: string | null;
  recognition: string | null;
  section_168i7_kind: string | null;
  disposed_unadjusted_basis: string | null;
  related_person: string | null;
  recovery_period_years: string | null;
  relationship: string | null;
  associated_person_equivalent_rate: string | null;
  buyer_placed_in_service_on: string | null;
  buyer_recovery_period_years: string | null;
  buyer_method: string | null;
  buyer_convention: string | null;
  original_unadjusted_basis: string | null;
  section_179: string | null;
  bonus_percent: string | null;
  business_use_percent: string | null;
  prior_depreciation: string | null;
  vintage_allocations: unknown;
};

function classifiedClassSql(
  asset: "a" | "seller" | "buyer",
  run: TaxPoolRun,
  attr: string,
) {
  if (asset === "seller") {
    return sql`coalesce(seller.custom->'taxDepreciation'->${run.regime}->>'classCode', seller_c.tax_attributes->>${attr}, '')`;
  }
  if (asset === "buyer") {
    return sql`coalesce(buyer.custom->'taxDepreciation'->${run.regime}->>'classCode', buyer_c.tax_attributes->>${attr}, '')`;
  }
  return sql`coalesce(a.custom->'taxDepreciation'->${run.regime}->>'classCode', c.tax_attributes->>${attr}, '')`;
}

function eventOnRunBook(run: TaxPoolRun) {
  return sql`(
    e.book_id is null
    or e.book_id = ${run.bookId}
    or exists (
      select 1 from journal_entries j
       where j.org_id = e.org_id and j.id = e.journal_entry_id and j.book_id = ${run.bookId}
    )
  )`;
}

/** Predicate must stay aligned with taxEventRequiresTaxWorkpaper: do not add
 *  NULL-change disposed/written_off, which still use the legacy proceeds path. */
async function refuseMissingTaxWorkpaper(
  tx: SqlExecutor,
  run: TaxPoolRun,
  attr: string,
): Promise<void> {
  const missing = (
    await tx.execute<{ asset_number: string }>(sql`
      select a.asset_number from fixed_assets a
      join asset_categories c on c.org_id=a.org_id and c.id=a.category_id
      where a.org_id=${run.orgId} and a.subsidiary_id=${run.subsidiaryId}
        and ${classifiedClassSql("a", run, attr)}<>''
        and (
          exists(
            select 1 from asset_events e
             where e.org_id=a.org_id and e.asset_id=a.id
               and e.occurred_on<=${run.yearEnd}
               and (
                 e.kind in ('partially_disposed','transferred')
                 or (e.kind in ('disposed','written_off') and e.financial_change_id is not null)
               )
               and not exists(
                 select 1 from asset_events r
                  where r.org_id=e.org_id and r.reverses_event_id=e.id and r.occurred_on<=${run.yearEnd}
               )
               and not exists(
                 select 1 from tax_asset_basis_workpapers w
                  where w.org_id=a.org_id and w.regime=${run.regime}
                    and w.effective_on<=${run.yearEnd}
                    and (w.reversed_on is null or w.reversed_on>${run.yearEnd})
                    and (w.asset_id=a.id or w.receiving_asset_id=a.id)
                    and (
                      (e.financial_change_id is not null and w.source_change_id=e.financial_change_id)
                      or (e.financial_change_id is null and w.source_change_id is null and w.source_event_id=e.id)
                    )
               )
          )
          or exists(
            select 1 from asset_transfer_bases t
             where t.org_id=a.org_id and t.receiving_asset_id=a.id
               and t.effective_on<=${run.yearEnd}
               and (t.reversed_on is null or t.reversed_on>${run.yearEnd})
               and not exists(
                 select 1 from tax_asset_basis_workpapers w
                  where w.org_id=t.org_id and w.regime=${run.regime}
                    and w.receiving_asset_id=a.id and w.source_change_id=t.change_id
                    and w.effective_on<=${run.yearEnd}
                    and (w.reversed_on is null or w.reversed_on>${run.yearEnd})
               )
          )
        )
      order by a.asset_number limit 1`)
  ).rows[0];
  if (missing) {
    throw new TaxPoolError(
      `Tax depreciation for asset ${missing.asset_number} requires an applied tax basis workpaper for its approved disposal or intercompany transfer. ` +
        `Record and apply the ${run.regime} workpaper from the asset's Tax basis workpaper action; do not substitute book cost, buyerAmount or group_component. ` +
        `A legacy disposed or written-off event with no financial change still uses recorded proceeds capped at capital cost and does not need a workpaper.`,
    );
  }
}

async function liveWorkpapers(
  tx: SqlExecutor,
  run: TaxPoolRun,
  attr: string,
): Promise<LiveWorkpaper[]> {
  return (
    await tx.execute<LiveWorkpaper>(sql`
      select w.asset_id, w.receiving_asset_id, w.effective_on::text, w.source_operation,
             w.applicable, w.seller_disposition::text, w.buyer_addition::text, w.remaining_basis::text,
             seller.subsidiary_id as seller_subsidiary_id,
             ${classifiedClassSql("seller", run, attr)} as seller_class,
             buyer.subsidiary_id as buyer_subsidiary_id,
             ${classifiedClassSql("buyer", run, attr)} as buyer_class,
             w.computed->>'shortYearMethod' as short_year_method,
             w.computed->>'placedInServiceOn' as placed_in_service_on,
             w.computed->>'method' as macrs_method,
             w.computed->>'convention' as macrs_convention,
             w.computed->>'carryoverBasis' as carryover_basis,
             w.computed->>'excessBasis' as excess_basis,
             w.computed->>'buyerCost' as buyer_cost,
             w.computed->>'recognition' as recognition,
             w.computed->>'section168i7Kind' as section_168i7_kind,
             w.computed->>'disposedUnadjustedBasis' as disposed_unadjusted_basis,
             w.facts->>'relatedPerson' as related_person,
             w.facts->>'recoveryPeriodYears' as recovery_period_years,
             w.facts->>'relationship' as relationship,
             coalesce(w.computed->>'associatedPersonEquivalentRate', w.facts->>'associatedPersonEquivalentRate')
               as associated_person_equivalent_rate,
             w.computed->>'buyerPlacedInServiceOn' as buyer_placed_in_service_on,
             w.computed->>'buyerRecoveryPeriodYears' as buyer_recovery_period_years,
             w.computed->>'buyerMethod' as buyer_method,
             w.computed->>'buyerConvention' as buyer_convention,
             coalesce(w.computed->>'originalUnadjustedBasis', w.facts->>'originalUnadjustedBasis')
               as original_unadjusted_basis,
             w.computed->>'section179' as section_179,
             w.computed->>'bonusPercent' as bonus_percent,
             w.computed->>'businessUsePercent' as business_use_percent,
             w.computed->>'priorDepreciation' as prior_depreciation,
             w.computed->'vintageAllocations' as vintage_allocations
        from tax_asset_basis_workpapers w
        join fixed_assets seller on seller.org_id=w.org_id and seller.id=w.asset_id
        join asset_categories seller_c on seller_c.org_id=seller.org_id and seller_c.id=seller.category_id
        left join fixed_assets buyer on buyer.org_id=w.org_id and buyer.id=w.receiving_asset_id
        left join asset_categories buyer_c on buyer_c.org_id=buyer.org_id and buyer_c.id=buyer.category_id
       where w.org_id=${run.orgId} and w.regime=${run.regime}
         and w.effective_on<=${run.yearEnd}
         and (w.reversed_on is null or w.reversed_on>${run.yearEnd})
         and (
           w.source_change_id is null
           or not exists(
             select 1 from financial_changes r
              where r.org_id=w.org_id and r.domain='asset' and r.operation='reversal'
                and r.status='applied' and r.payload->>'sourceChangeId'=w.source_change_id::text
                and r.effective_on<=${run.yearEnd}
           )
         )
         and (
           w.source_event_id is null
           or not exists(
             select 1 from asset_events r
              where r.org_id=w.org_id and r.reverses_event_id=w.source_event_id
                and r.occurred_on<=${run.yearEnd}
           )
         )
       order by w.effective_on, w.id`)
  ).rows;
}

async function qualifyingActivityCeased(tx: SqlExecutor, run: TaxPoolRun): Promise<boolean> {
  if (run.regime !== "uk_wda") return true;
  const row = (
    await tx.execute<{ ceased: boolean }>(sql`
      select true as ceased from tax_qualifying_activity_cessations
       where org_id=${run.orgId} and subsidiary_id=${run.subsidiaryId} and regime=${run.regime}
         and ceased_on<=${run.yearEnd}
         and (resumed_on is null or resumed_on>${run.yearEnd})
       limit 1`)
  ).rows[0];
  return !!row;
}

async function macrsWindows(tx: SqlExecutor, run: TaxPoolRun): Promise<MacrsYearWindow[]> {
  const rows = (
    await tx.execute<{ tax_year: number; year_start: string; year_end: string }>(sql`
      select distinct pp.tax_year, pp.year_start::text, pp.year_end::text
        from tax_pool_periods pp
        join tax_depreciation_pools tp on tp.id=pp.pool_id and tp.org_id=pp.org_id
       where tp.org_id=${run.orgId} and tp.book_id=${run.bookId}
         and tp.subsidiary_id=${run.subsidiaryId} and tp.regime=${run.regime}
         and pp.tax_year<${run.taxYear}
       order by pp.tax_year`)
  ).rows;
  return [
    ...rows.map((row) => ({ taxYear: row.tax_year, yearStart: row.year_start, yearEnd: row.year_end })),
    { taxYear: run.taxYear, yearStart: run.yearStart, yearEnd: run.yearEnd },
  ];
}

async function receiverAssetIds(tx: SqlExecutor, run: TaxPoolRun): Promise<Set<string>> {
  const rows = (
    await tx.execute<{ id: string }>(sql`
      select receiving_asset_id as id from asset_transfer_bases
       where org_id=${run.orgId} and effective_on<=${run.yearEnd}
         and (reversed_on is null or reversed_on>${run.yearEnd})`)
  ).rows;
  return new Set(rows.map((row) => row.id));
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
 *  regime) scope at a time. The separate asset-lifecycle fence also serializes
 *  books/regimes within a legal entity while a related asset change publishes. */
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

async function regimeModel(tx: SqlExecutor, orgId: string, regime: string): Promise<"pool" | "macrs"> {
  const r = (await tx.execute<{ calculation_model: "pool" | "macrs" }>(sql`
    select calculation_model from tax_regimes where org_id = ${orgId} and code = ${regime} and is_active limit 1`));
  return r.rows[0]?.calculation_model ?? TAX_DEPRECIATION_REGIMES[regime]?.calculationModel ?? "pool";
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
  let macrsShortYearFactor = shortYearFactor;

  // One transaction for the whole year. The advisory lock is taken inside it
  // BEFORE any state is read, so two runs of this scope — same or adjacent
  // years — fully serialize, and a mid-year failure rolls back everything.
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${taxPoolRunLockKey(orgId, bookId, subsidiaryId, regime)}, 0))`);

    await lockAssetTaxLifecycle(tx, orgId, [subsidiaryId]);

    const classes = await effectiveClasses(tx, orgId, regime);
    if (classes.size === 0) throw new TaxPoolError(`unknown tax depreciation regime "${regime}"`);
    const attr = await regimeClassAttribute(tx, orgId, regime);
    const model = await regimeModel(tx, orgId, regime);

    if (model === "macrs") {
      try {
        macrsShortYearFactor = assertShortYearFactorAgrees(opts.yearStart, opts.yearEnd, opts.shortYearFactor);
      } catch (error) {
        throw error instanceof MacrsShortYearError
          ? new TaxPoolError(error.message)
          : error;
      }
    }
    const run: TaxPoolRun = {
      orgId, bookId, subsidiaryId, regime, taxYear,
      yearStart: opts.yearStart, yearEnd: opts.yearEnd,
      shortYearFactor: model === "macrs" ? macrsShortYearFactor : shortYearFactor,
      actorId: opts.actorId,
    };
    await refuseMissingTaxWorkpaper(tx, run, attr);

    await fenceRunOrdering(tx, orgId, bookId, subsidiaryId, regime, taxYear);

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

  // Read every classified asset before doing any computation.  We resolve the
  // class in code (rather than joining only tenant rows) because built-in
  // classes need to participate in per-asset cost caps too.  A disposal event
  // is effective for a historical run only when it occurred by year-end and
  // has not itself been reversed by that year-end; the mutable present-day
  // asset status is deliberately not consulted.
  const assetRows = (await tx.execute<{
    id: string;
    acquisition_cost: string;
    placed_on: string | null;
    class_code: string;
    held_at_year_end: boolean;
  }>(sql`
    select a.id, a.acquisition_cost::text,
           coalesce(a.in_service_on, a.acquired_on)::text as placed_on,
           ${classifiedClassSql("a", run, attr)} as class_code,
           (
             coalesce(a.in_service_on, a.acquired_on) is not null
             and coalesce(a.in_service_on, a.acquired_on) <= ${run.yearEnd}
             and not exists (
               select 1
                 from asset_events disposal
                where disposal.org_id = a.org_id and disposal.asset_id = a.id
                  and disposal.kind in ('disposed', 'written_off')
                  and disposal.occurred_on <= ${run.yearEnd}
                  and not exists (
                    select 1
                      from asset_events reversal
                     where reversal.org_id = disposal.org_id
                       and reversal.reverses_event_id = disposal.id
                       and reversal.occurred_on <= ${run.yearEnd}
                  )
             )
             and (
               a.acquisition_cost + coalesce((
                 select sum(x.cost_delta) from asset_basis_changes x
                  where x.org_id = a.org_id and x.asset_id = a.id and x.book_id = ${run.bookId}
                    and x.effective_on <= ${run.yearEnd}
               ), 0)
             ) > 0
           ) as held_at_year_end
      from fixed_assets a
      join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
     where a.org_id = ${orgId} and a.subsidiary_id = ${run.subsidiaryId}
       and not exists(select 1 from asset_transfer_bases t where t.org_id=a.org_id and t.receiving_asset_id=a.id and t.reversed_on<=${run.yearEnd})
       and ${classifiedClassSql("a", run, attr)} <> ''
     order by class_code, a.id`));

  const unknownClasses = [...new Set(assetRows.rows
    .map((row) => row.class_code)
    .filter((classCode) => !classes.has(classCode)))].sort();
  if (unknownClasses.length > 0) {
    throw new TaxPoolError(
      `unknown tax class code(s) for regime "${run.regime}": ${unknownClasses.join(", ")}`,
    );
  }

  type ClassAggregate = { additions: bigint; dispositions: bigint; hasAssets: boolean };
  const aggregateByClass = new Map<string, ClassAggregate>();
  const addAggregate = (classCode: string): ClassAggregate => {
    const existing = aggregateByClass.get(classCode);
    if (existing) return existing;
    const created: ClassAggregate = { additions: 0n, dispositions: 0n, hasAssets: false };
    aggregateByClass.set(classCode, created);
    return created;
  };
  const cappedCost = (cost: string, classDef: PoolClassDef): string => {
    const cap = classDef.costCap == null ? null : normalizeMoney(classDef.costCap);
    if (cap == null || toUnits(cost) <= toUnits(cap)) return cost;
    return cap;
  };

  const receivers = await receiverAssetIds(tx, run);
  for (const row of assetRows.rows) {
    const classDef = classes.get(row.class_code)!;
    const aggregate = addAggregate(row.class_code);
    const capitalCost = cappedCost(row.acquisition_cost, classDef);
    if (
      row.placed_on &&
      row.placed_on >= run.yearStart &&
      row.placed_on <= run.yearEnd &&
      !receivers.has(row.id)
    ) {
      aggregate.additions += toUnits(capitalCost);
    }
    if (row.held_at_year_end) aggregate.hasAssets = true;
  }

  // Legacy ordinary disposals: disposed/written_off with no financial
  // change. Σ least(proceeds, each asset's effective capital cost), one
  // event per book (book_id or its journal book; NULL-book events still
  // apply), reversed by year-end excluded. Native governed events are
  // not in this query — they consume the frozen workpaper below.
  const dispRows = (
    await tx.execute<{
      amount: string | null;
      acquisition_cost: string;
      class_code: string;
    }>(sql`
      select distinct on (e.id) e.amount::text, a.acquisition_cost::text,
             ${classifiedClassSql("a", run, attr)} as class_code
        from asset_events e
        join fixed_assets a on a.id = e.asset_id and a.org_id = e.org_id
        join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
       where e.org_id = ${orgId} and a.subsidiary_id = ${run.subsidiaryId}
         and e.kind in ('disposed', 'written_off')
         and e.financial_change_id is null
         and e.occurred_on between ${run.yearStart} and ${run.yearEnd}
         and ${classifiedClassSql("a", run, attr)} <> ''
         and ${eventOnRunBook(run)}
         and not exists (
           select 1
             from asset_events reversal
            where reversal.org_id = e.org_id
              and reversal.reverses_event_id = e.id
              and reversal.occurred_on <= ${run.yearEnd}
         )
         and not exists (
           select 1 from tax_asset_basis_workpapers w
            where w.org_id = e.org_id and w.regime = ${run.regime}
              and w.source_change_id is null and w.source_event_id = e.id
              and w.effective_on <= ${run.yearEnd}
              and (w.reversed_on is null or w.reversed_on > ${run.yearEnd})
         )
       order by e.id`)
  ).rows;
  for (const row of dispRows) {
    const classDef = classes.get(row.class_code);
    if (!classDef) {
      throw new TaxPoolError(
        `unknown tax class code "${row.class_code}" on a legacy ${run.regime} disposal; assign the tax class before running the pool`,
      );
    }
    addAggregate(row.class_code).dispositions += toUnits(
      legacyPoolDisposition(row.amount, cappedCost(row.acquisition_cost, classDef)),
    );
  }

  const ceased = await qualifyingActivityCeased(tx, run);
  const papers = await liveWorkpapers(tx, run, attr);
  for (const paper of papers) {
    if (paper.effective_on < run.yearStart || paper.effective_on > run.yearEnd) continue;
    if (paper.seller_subsidiary_id === run.subsidiaryId && paper.seller_disposition) {
      if (!paper.seller_class || !classes.has(paper.seller_class)) {
        throw new TaxPoolError(
          `unknown tax class code "${paper.seller_class}" on the frozen ${run.regime} workpaper; assign the seller's tax class before running the pool`,
        );
      }
      addAggregate(paper.seller_class).dispositions += toUnits(paper.seller_disposition);
    }
    if (
      paper.source_operation === "intercompany_transfer" &&
      paper.buyer_subsidiary_id === run.subsidiaryId &&
      paper.buyer_addition
    ) {
      if (!paper.buyer_class || !classes.has(paper.buyer_class)) {
        throw new TaxPoolError(
          `unknown tax class code "${paper.buyer_class}" on the frozen ${run.regime} workpaper; assign the receiving asset's tax class before running the pool`,
        );
      }
      addAggregate(paper.buyer_class).additions += toUnits(paper.buyer_addition);
    }
  }

  const classRows = [...aggregateByClass.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([classCode, aggregate]) => ({
      class_code: classCode,
      additions: fromUnits(aggregate.additions),
      dispositions: fromUnits(aggregate.dispositions),
      has_assets: aggregate.hasAssets,
    }));

  // Compute every class FIRST (reads only once pools exist), then persist all
  // results below in this same transaction — the year lands whole or not at all.
  const prepared: { poolId: string; classCode: string; def: PoolClassDef; result: PoolYearResult; enhancedMultiplier: string | null }[] = [];
  for (const row of classRows) {
    const classCode = row.class_code;
    const classDef = classes.get(classCode);
    if (!classDef) throw new TaxPoolError(`unknown tax class code "${classCode}"`);
    const dispositions = row.dispositions;

    const pool = await ensurePool(tx, run, classDef);
    const openingBalance = await openingForTaxYear(tx, orgId, pool.id, taxYear, pool.openingBalance);
    const rule = await firstYearRule(tx, orgId, run.regime, classCode, run.yearEnd, classDef.firstYearFraction);

    const result = computePoolYear({
      openingBalance,
      additions: row.additions,
      dispositions,
      rate: nzYearRate(run, classCode, classDef, papers),
      firstYearFraction: rule.firstYearFraction,
      enhancedFirstYearMultiplier: rule.enhancedMultiplier,
      shortYearFactor: run.shortYearFactor,
      poolHasAssetsAtYearEnd: row.has_assets,
      allowRecapture: classDef.allowRecapture,
      allowTerminalLoss: classDef.allowTerminalLoss && (run.regime !== "uk_wda" || ceased),
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
         short_year_factor, year_start, year_end, enhanced_multiplier, created_by, updated_by)
      values (${orgId}, ${p.poolId}, ${taxYear}, ${p.result.openingBalance}, ${p.result.additions},
              ${p.result.dispositions}, ${p.result.netAdditions}, ${p.result.immediateExpense}, ${p.result.base},
              ${p.result.allowance}, ${p.result.closingBalance}, ${p.result.recapture}, ${p.result.terminalLoss},
              ${run.shortYearFactor}, ${run.yearStart}, ${run.yearEnd}, ${p.enhancedMultiplier}, ${run.actorId}, ${run.actorId})
      on conflict (org_id, pool_id, tax_year) do update set
        opening_balance = excluded.opening_balance, additions = excluded.additions,
        dispositions = excluded.dispositions, net_additions = excluded.net_additions,
        immediate_expense = excluded.immediate_expense, base = excluded.base,
        allowance = excluded.allowance, closing_balance = excluded.closing_balance,
        recapture = excluded.recapture, terminal_loss = excluded.terminal_loss,
        short_year_factor = excluded.short_year_factor, year_start = excluded.year_start, year_end = excluded.year_end,
        enhanced_multiplier = excluded.enhanced_multiplier,
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

function nzYearRate(
  run: TaxPoolRun,
  classCode: string,
  classDef: PoolClassDef,
  papers: LiveWorkpaper[],
): string | number {
  if (run.regime !== "nz_pool") return classDef.rate;
  try {
    return nzPooledDepreciationRate(classDef.rate, continuingNzAssociatedRates(papers, run, classCode));
  } catch (error) {
    throw error instanceof TaxBasisPolicyError ? new TaxPoolError(error.message) : error;
  }
}

function asMacrsEvents(papers: LiveWorkpaper[]): MacrsWorkpaperEvent[] {
  return papers.map((paper) => ({
    asset_id: paper.asset_id,
    receiving_asset_id: paper.receiving_asset_id,
    effective_on: paper.effective_on,
    seller_subsidiary_id: paper.seller_subsidiary_id,
    buyer_subsidiary_id: paper.buyer_subsidiary_id,
    remaining_basis: paper.remaining_basis,
    disposed_unadjusted_basis: paper.disposed_unadjusted_basis,
    carryover_basis: paper.carryover_basis,
    excess_basis: paper.excess_basis,
    buyer_cost: paper.buyer_cost,
    recognition: paper.recognition,
    section_168i7_kind: paper.section_168i7_kind,
    related_person: paper.related_person,
    recovery_period_years: paper.recovery_period_years,
    placed_in_service_on: paper.placed_in_service_on,
    macrs_method: paper.macrs_method,
    macrs_convention: paper.macrs_convention,
    short_year_method: paper.short_year_method,
    buyer_placed_in_service_on: paper.buyer_placed_in_service_on,
    buyer_recovery_period_years: paper.buyer_recovery_period_years,
    buyer_method: paper.buyer_method,
    buyer_convention: paper.buyer_convention,
    original_unadjusted_basis: paper.original_unadjusted_basis,
    section_179: paper.section_179,
    bonus_percent: paper.bonus_percent,
    business_use_percent: paper.business_use_percent,
    prior_depreciation: paper.prior_depreciation,
    vintage_allocations: Array.isArray(paper.vintage_allocations)
      ? paper.vintage_allocations
      : null,
  }));
}

type MacrsAssetRow = {
  id: string;
  class_code: string;
  acquisition_cost: string;
  placed_on: string;
  disposed_on: string | null;
  disposition_amount: string | null;
  disposal_change_id: string | null;
  custom: Record<string, unknown> | null;
};

async function runMacrs(
  tx: SqlExecutor,
  run: TaxPoolRun,
  attr: string,
  classes: Map<string, PoolClassDef>,
): Promise<TaxPoolRunResult> {
  const { orgId, taxYear } = run;
  const papers = await liveWorkpapers(tx, run, attr);
  const windows = await macrsWindows(tx, run);
  const receivers = await receiverAssetIds(tx, run);
  const assets = (await tx.execute<MacrsAssetRow>(sql`
    select a.id,
           coalesce(a.custom->'taxDepreciation'->${run.regime}->>'classCode', c.tax_attributes->>${attr}) as class_code,
           a.acquisition_cost::text, coalesce(a.in_service_on, a.acquired_on)::text as placed_on,
           d.occurred_on::text as disposed_on, d.amount::text as disposition_amount,
           d.financial_change_id::text as disposal_change_id, a.custom
      from fixed_assets a
      join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
      left join lateral (
        select e.occurred_on, e.amount, e.financial_change_id from asset_events e
         where e.asset_id = a.id and e.org_id = a.org_id and e.org_id = ${orgId}
           and e.kind in ('disposed', 'written_off')
           and e.occurred_on <= ${run.yearEnd}
           and ${eventOnRunBook(run)}
           and not exists (
             select 1 from asset_events reversal
              where reversal.org_id = e.org_id
                and reversal.reverses_event_id = e.id
                and reversal.occurred_on <= ${run.yearEnd}
           )
         order by e.occurred_on, e.id limit 1
      ) d on true
     where a.org_id = ${orgId} and a.subsidiary_id = ${run.subsidiaryId}
       and not exists(select 1 from asset_transfer_bases t where t.org_id=a.org_id and t.receiving_asset_id=a.id and t.reversed_on<=${run.yearEnd})
       and coalesce(a.in_service_on, a.acquired_on) is not null
       and coalesce(a.in_service_on, a.acquired_on) <= ${run.yearEnd}
       and coalesce(a.custom->'taxDepreciation'->${run.regime}->>'classCode', c.tax_attributes->>${attr}, '') <> ''`));

  const unknownClasses = [...new Set(assets.rows
    .map((asset) => asset.class_code)
    .filter((classCode) => !classes.has(classCode)))].sort();
  if (unknownClasses.length > 0) {
    throw new TaxPoolError(
      `unknown tax class code(s) for regime "${run.regime}": ${unknownClasses.join(", ")}`,
    );
  }

  const grouped = new Map<string, { def: PoolClassDef; assets: MacrsAssetRow[] }>();
  for (const asset of assets.rows) {
    const def = classes.get(asset.class_code);
    if (!def) throw new TaxPoolError(`unknown tax class code "${asset.class_code}"`);
    if (!def.recoveryPeriodYears || !def.macrsMethod || !def.convention) {
      throw new TaxPoolError(`incomplete tax class configuration for "${asset.class_code}" in regime "${run.regime}"`);
    }
    const group = grouped.get(asset.class_code) ?? { def, assets: [] };
    group.assets.push(asset);
    grouped.set(asset.class_code, group);
  }

  type ResolvedMacrsAsset = {
    classCode: string;
    def: PoolClassDef;
    asset: MacrsAssetRow;
    vintages: ReturnType<typeof resolveMacrsVintages>;
    sellerPapers: LiveWorkpaper[];
    receiverPapers: LiveWorkpaper[];
    latestReceiver: LiveWorkpaper | undefined;
    yearPapers: LiveWorkpaper[];
  };
  const resolved: ResolvedMacrsAsset[] = [];
  for (const [classCode, group] of grouped) {
    for (const asset of group.assets) {
      const config = taxAssetConfig(asset.custom, run.regime);
      const sellerPapers = papers.filter((paper) => paper.asset_id === asset.id);
      const receiverPapers = papers.filter((paper) => paper.receiving_asset_id === asset.id);
      try {
        resolved.push({
          classCode,
          def: group.def,
          asset,
          sellerPapers,
          receiverPapers,
          latestReceiver: receiverPapers.at(-1),
          yearPapers: [...sellerPapers, ...receiverPapers].filter(
            (paper) => paper.effective_on >= run.yearStart && paper.effective_on <= run.yearEnd,
          ),
          vintages: resolveMacrsVintages({
            assetId: asset.id,
            subsidiaryId: run.subsidiaryId,
            placedOn: asset.placed_on,
            acquisitionCost: asset.acquisition_cost,
            disposedOn: asset.disposed_on,
            papers: asMacrsEvents([...sellerPapers, ...receiverPapers]),
            defaults: {
              recoveryPeriodYears: String(group.def.recoveryPeriodYears!),
              method: group.def.macrsMethod!,
              convention: group.def.convention!,
              section179: String(config.section179 ?? "0"),
              bonusPercent: decimalOr(config.bonusPercent, "0"),
              businessUsePercent: decimalOr(config.businessUsePercent, "100"),
              shortYearMethod: "simplified",
            },
          }),
        });
      } catch (error) {
        throw error instanceof MacrsVintageError ? new TaxPoolError(error.message) : error;
      }
    }
  }
  const midQuarterByTaxYear = macrsMidQuarterByTaxYear(
    windows,
    resolved.flatMap((row) => row.vintages),
  );

  // Compute every class first, then persist all periods and roll-forwards in
  // this one transaction — identical atomicity contract to the pooled model.
  const prepared: { poolId: string; classCode: string; def: PoolClassDef; values: ReturnType<typeof macrsValues> }[] = [];
  let totalAllowance = "0";
  for (const [classCode, group] of grouped) {
    let opening = 0n, additions = 0n, dispositions = 0n, allowance = 0n, closing = 0n;
    for (const row of resolved.filter((item) => item.classCode === classCode)) {
      const { asset, vintages, latestReceiver, yearPapers } = row;
      for (const vintage of vintages) {
        if (vintage.placedInServiceOn > run.yearEnd) continue;
        const walked = computeMacrsThroughYear({
          basis: vintage.basis,
          placedInServiceOn: vintage.placedInServiceOn,
          taxYear,
          recoveryPeriodYears: vintage.recoveryPeriodYears,
          method: vintage.method,
          convention: macrsConventionAfterMidQuarter(
            vintage,
            group.def.convention!,
            windows,
            midQuarterByTaxYear,
          ),
          disposedOn: vintage.disposedOn,
          dispositionRecognition: vintage.recognition,
          section179: vintage.section179,
          bonusPercent: vintage.bonusPercent,
          businessUsePercent: vintage.businessUsePercent,
          shortYearFactor: run.shortYearFactor,
          shortYearMethod: vintage.shortYearMethod,
          adjustedCarryover: vintage.adjustedCarryover ?? undefined,
          carryoverOn: vintage.transferOn && vintage.adjustedCarryover ? vintage.transferOn : undefined,
          section168i7Kind: vintage.section168i7Kind ?? undefined,
        }, windows);
        const current = walked.current;
        const transferredThisYear = !!(
          vintage.role === "buyer" &&
          vintage.adjustedCarryover &&
          vintage.transferOn &&
          vintage.transferOn >= run.yearStart &&
          vintage.transferOn <= run.yearEnd
        );
        const transferredBeforeYear = !!(
          vintage.role === "buyer" &&
          vintage.adjustedCarryover &&
          vintage.transferOn &&
          vintage.transferOn < run.yearStart
        );
        const vintagePlacedThisYear =
          vintage.placedInServiceOn >= run.yearStart && vintage.placedInServiceOn <= run.yearEnd;
        const vintagePlacedBeforeYear = vintage.placedInServiceOn < run.yearStart;
        if (transferredThisYear) {
          additions += toUnits(vintage.adjustedCarryover!);
        } else if (transferredBeforeYear || (!vintage.adjustedCarryover && vintagePlacedBeforeYear)) {
          opening += toUnits(walked.prior.remainingBasis);
        }
        if (!vintage.adjustedCarryover && vintagePlacedThisYear && vintage.role === "buyer") {
          additions += toUnits(vintage.basis);
        } else if (vintagePlacedThisYear && vintage.role === "seller" && !receivers.has(asset.id)) {
          additions += toUnits(vintage.basis);
        }
        allowance += toUnits(current.allowance);
        closing += toUnits(current.remainingBasis);
      }
      if (
        asset.placed_on >= run.yearStart &&
        asset.placed_on <= run.yearEnd &&
        receivers.has(asset.id) &&
        !latestReceiver?.buyer_addition &&
        !latestReceiver?.carryover_basis &&
        !latestReceiver?.buyer_cost
      ) {
        throw new TaxPoolError(
          `receiving asset ${asset.id} has no frozen buyer tax basis; record the ${run.regime} workpaper — do not use book cost`,
        );
      }
      let usedWorkpaperDisposition = false;
      for (const paper of yearPapers) {
        if (paper.asset_id === asset.id && paper.seller_subsidiary_id === run.subsidiaryId && paper.seller_disposition) {
          dispositions += toUnits(paper.seller_disposition);
          usedWorkpaperDisposition = true;
        }
      }
      if (
        !usedWorkpaperDisposition &&
        !taxEventRequiresTaxWorkpaper("disposed", asset.disposal_change_id) &&
        asset.disposed_on &&
        asset.disposed_on >= run.yearStart &&
        asset.disposed_on <= run.yearEnd
      ) {
        dispositions += toUnits(asset.disposition_amount ?? "0");
      }
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
         short_year_factor, year_start, year_end, created_by, updated_by)
      values (${orgId}, ${p.poolId}, ${taxYear}, ${p.values.openingBalance}, ${p.values.additions},
              ${p.values.dispositions}, ${p.values.netAdditions}, ${p.values.immediateExpense}, ${p.values.base},
              ${p.values.allowance}, ${p.values.closingBalance}, 0, 0, ${run.shortYearFactor}, ${run.yearStart}, ${run.yearEnd}, ${run.actorId}, ${run.actorId})
      on conflict (org_id, pool_id, tax_year) do update set
        opening_balance=excluded.opening_balance, additions=excluded.additions, dispositions=excluded.dispositions,
        net_additions=excluded.net_additions, immediate_expense=excluded.immediate_expense, base=excluded.base,
        allowance=excluded.allowance, closing_balance=excluded.closing_balance, recapture=0, terminal_loss=0,
        short_year_factor=excluded.short_year_factor, year_start=excluded.year_start, year_end=excluded.year_end,
        updated_at=now(), updated_by=${run.actorId}
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
