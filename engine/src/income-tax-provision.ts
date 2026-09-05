import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "./db.ts";
import { canonicalJson } from "./canonical-json.ts";
import {
  add,
  cmp,
  fromUnits,
  isZero,
  mulPercent,
  mulRate,
  neg,
  sum,
  toUnits,
} from "./money.ts";
import { assertPeriodModulesOpen } from "./close.ts";
import { assertFinalKernelBalance } from "./posting.ts";

/**
 * ASC 740 / IAS 12 income-tax provision. A run measures, PER LEGAL ENTITY
 * (subsidiary) in its functional currency:
 *   current tax  = max(0, pretax ± permanent − loss used) × enacted rate
 *   deferred tax = temporary differences × enacted rate → DTA/DTL, net of a
 *                  valuation allowance against gross DTA
 * and posts one balanced journal per entity (origin 'tax_provision') through
 * the kernel, gated on the `tax` close module. The consolidated view is an
 * explicit translation of each entity at the period's spot rate into the
 * presentation currency — foreign-currency amounts are never summed raw.
 *
 * Reposting a fiscal year reverses EVERY entry the superseded run posted and
 * supersedes that run, so the ledger accumulates movements exactly once and
 * the audit trail (runs, payloads, reversal chain) is complete. Entry numbers
 * are derived deterministically from (fiscal year, run version, entity), so
 * any number of same-year reposts stay collision-free and reproducible.
 *
 * A draft is bound to its sources: the computation records a fingerprint of
 * the ledger balance, enacted-rate configuration, fixed-asset differences and
 * prior-year baseline it measured, and posting refuses (with zero writes)
 * unless every source is still identical. Recompute after any change.
 *
 * Money is exact decimal throughout (string at numeric(19,4), BigInt units).
 */

export class IncomeTaxProvisionError extends Error {}

/**
 * Income-tax framework: ASC 740 (US GAAP) or IAS 12 (IFRS). The computation
 * is shared; the difference is recognition language and presentation — IAS 12
 * has no "valuation allowance" account concept, it recognizes deferred tax
 * assets only to the extent recovery is probable, so the same input is the
 * DTA recognition adjustment. Recorded per run in the payload.
 */
export type TaxFramework = "asc740" | "ias12";

export async function orgTaxFramework(orgId: string): Promise<TaxFramework> {
  const r = (await db.execute<{ f: string | null }>(sql`
    select settings->>'taxFramework' as f from orgs where id = ${orgId}
  `));
  return r.rows[0]?.f === "ias12" ? "ias12" : "asc740";
}

/** Framework-aware name for the DTA-reduction input. */
export function deferredAssetAdjustmentLabel(framework: TaxFramework): string {
  return framework === "ias12"
    ? "Deferred tax asset recognition adjustment"
    : "Valuation allowance";
}

// ---------------------------------------------------------------------------
// Pure computation core
// ---------------------------------------------------------------------------

export interface PermanentDifference {
  description: string;
  /** Signed: non-deductible expense positive, non-taxable income negative. */
  amount: string;
  /** Legal entity the difference belongs to; null = the org's root entity. */
  subsidiaryId?: string | null;
}

export interface DifferenceInput {
  category:
    | "fixed_assets"
    | "revenue_recognition"
    | "provisions"
    | "loss_carryforward"
    | "other";
  description: string;
  subsidiaryId?: string | null;
  bookBasis?: string;
  taxBasis?: string;
  /** Signed: positive = taxable temporary difference (DTL), negative = deductible (DTA). */
  difference: string;
  source: "auto" | "manual";
}

export interface ProvisionComputationInput {
  pretaxBookIncome: string;
  enactedRatePercent: string;
  permanentDifferences: PermanentDifference[];
  lossCarryforwardUsed: string;
  /** ASC 740: valuation allowance. IAS 12: DTA recognition adjustment — the
   *  same mechanism, capped at gross DTA. */
  valuationAllowance: string;
  differences: DifferenceInput[];
  framework?: TaxFramework;
  prior?: {
    dtaGross: string;
    dtlGross: string;
    valuationAllowance: string;
  } | null;
  /**
   * Prior-year CUMULATIVE net basis difference (pre-tax, signed the same way as
   * `DifferenceInput.difference`: positive = taxable/DTL-side), EXCLUDING
   * loss-carryforward attributes. Current tax is measured on taxable profit
   * (ASC 740-10-30-2 / IAS 12.12), so the year's ORIGINATING or REVERSING
   * movement in basis differences — current cumulative minus this — adjusts
   * taxable income. Loss carryforwards are excluded on both sides: a
   * carryforward is a tax attribute (its DTA arises from the unused loss), not
   * a book-versus-tax basis difference, so it never adjusts the current-year
   * return.
   */
  priorNetTemporaryDifference?: string | null;
}

export interface RateReconStep {
  key: string;
  label: string;
  amount: string;
  /** Percent of pretax income (null when pretax is zero). */
  percent: string | null;
}

export interface DeferredBalances {
  dtaGross: string;
  dtlGross: string;
  valuationAllowance: string;
}

export interface ProvisionComputation {
  taxableIncome: string;
  currentTax: string;
  deferredExpense: string;
  totalExpense: string;
  balances: DeferredBalances;
  movement: { dtaGross: string; dtlGross: string; valuationAllowance: string };
  /** Cumulative net basis difference (pre-tax, excl. loss carryforwards) —
   *  persisted so the next year's run can measure its originating movement. */
  netTemporaryDifference: string;
  effectiveRatePercent: string | null;
  rateReconciliation: RateReconStep[];
  measured: (DifferenceInput & { ratePercent: string; taxEffect: string })[];
}

function maxZero(v: string): string {
  return cmp(v, "0") < 0 ? "0.0000" : fromUnits(toUnits(v));
}

function percentOf(amount: string, base: string): string | null {
  if (isZero(base)) return null;
  const pct = (toUnits(amount) * 1_000_000n) / toUnits(base); // 4dp of percent
  const sign = pct < 0n ? "-" : "";
  const abs = pct < 0n ? -pct : pct;
  const whole = abs / 10_000n;
  const frac = String(abs % 10_000n).padStart(4, "0");
  return `${sign}${whole}.${frac.slice(0, 2)}`;
}

/** Pure: the entire provision computation for ONE legal entity, side-effect free. */
export function buildProvision(
  input: ProvisionComputationInput,
): ProvisionComputation {
  const rate = input.enactedRatePercent;
  const permanentTotal = sum(input.permanentDifferences.map((p) => p.amount));

  // Current tax is measured on TAXABLE PROFIT (ASC 740-10-30-2 / IAS 12.12).
  // Basis differences originating this year (tax deduction ahead of book, or
  // book income ahead of tax) move taxable income away from book income by the
  // year's MOVEMENT in the cumulative net difference; reversals move it back.
  // Loss carryforwards are tax attributes, not basis differences, and never
  // adjust the current-year return — they are excluded from the movement.
  const netTemporaryDifference = sum(
    input.differences
      .filter((d) => d.category !== "loss_carryforward")
      .map((d) => d.difference),
  );
  const temporaryMovement = add(
    netTemporaryDifference,
    neg(input.priorNetTemporaryDifference ?? "0"),
  );
  const taxableIncome = add(
    add(
      add(input.pretaxBookIncome, permanentTotal),
      neg(input.lossCarryforwardUsed),
    ),
    neg(temporaryMovement),
  );
  const currentTax = maxZero(mulPercent(maxZero(taxableIncome), rate, 4));

  // Temporary differences → gross DTA / DTL at the enacted rate.
  let dta = 0n;
  let dtl = 0n;
  const measured = input.differences.map((d) => {
    const effect = mulPercent(d.difference, rate, 4);
    if (cmp(d.difference, "0") >= 0) dtl += toUnits(effect);
    else dta += -toUnits(effect);
    return { ...d, ratePercent: rate, taxEffect: effect };
  });
  const dtaGross = fromUnits(dta);
  const dtlGross = fromUnits(dtl);
  const valuationAllowance = maxZero(input.valuationAllowance);
  if (cmp(valuationAllowance, dtaGross) > 0) {
    throw new IncomeTaxProvisionError(
      "valuation allowance cannot exceed gross deferred tax assets",
    );
  }

  const prior = input.prior ?? {
    dtaGross: "0",
    dtlGross: "0",
    valuationAllowance: "0",
  };
  const movement = {
    dtaGross: fromUnits(toUnits(dtaGross) - toUnits(prior.dtaGross)),
    dtlGross: fromUnits(toUnits(dtlGross) - toUnits(prior.dtlGross)),
    valuationAllowance: fromUnits(
      toUnits(valuationAllowance) - toUnits(prior.valuationAllowance),
    ),
  };
  // Deferred expense = ΔDTL − ΔDTA(gross) + ΔVA.
  const deferredExpense = fromUnits(
    toUnits(movement.dtlGross) -
      toUnits(movement.dtaGross) +
      toUnits(movement.valuationAllowance),
  );
  const totalExpense = add(currentTax, deferredExpense);

  // Rate reconciliation: statutory → permanent → loss benefit → deferred → total.
  const steps: RateReconStep[] = [];
  const expected = mulPercent(input.pretaxBookIncome, rate, 4);
  steps.push({
    key: "statutory",
    label: "Expected tax at the statutory rate",
    amount: expected,
    percent: percentOf(expected, input.pretaxBookIncome),
  });
  for (const p of input.permanentDifferences) {
    const effect = mulPercent(p.amount, rate, 4);
    steps.push({
      key: `permanent:${p.description}`,
      label: p.description,
      amount: effect,
      percent: percentOf(effect, input.pretaxBookIncome),
    });
  }
  if (!isZero(input.lossCarryforwardUsed)) {
    const benefit = neg(mulPercent(input.lossCarryforwardUsed, rate, 4));
    steps.push({
      key: "lossCarryforward",
      label: "Loss carryforward benefit used",
      amount: benefit,
      percent: percentOf(benefit, input.pretaxBookIncome),
    });
  }
  if (!isZero(temporaryMovement)) {
    // The current-tax leg of timing: deferred to (or recovered from) future
    // periods. Its deferred-tax leg sits inside the deferredMovement step, so
    // the two cancel for pure timing and the schedule stays additive to total.
    const currentEffect = neg(mulPercent(temporaryMovement, rate, 4));
    steps.push({
      key: "temporaryDifferences",
      label: "Temporary differences deferred to future periods (current tax)",
      amount: currentEffect,
      percent: percentOf(currentEffect, input.pretaxBookIncome),
    });
  }
  if (cmp(taxableIncome, "0") < 0) {
    // Current tax floored at zero: the not-recognized current benefit of the loss.
    const unrecognized = neg(mulPercent(taxableIncome, rate, 4));
    steps.push({
      key: "currentLossNotRecognized",
      label: "Current-year loss with no current tax",
      amount: unrecognized,
      percent: percentOf(unrecognized, input.pretaxBookIncome),
    });
  }
  if (!isZero(deferredExpense)) {
    const vaLabel = deferredAssetAdjustmentLabel(input.framework ?? "asc740");
    steps.push({
      key: "deferredMovement",
      label: `Change in deferred taxes (incl. ${vaLabel.toLowerCase()})`,
      amount: deferredExpense,
      percent: percentOf(deferredExpense, input.pretaxBookIncome),
    });
  }
  steps.push({
    key: "total",
    label: "Total income tax expense",
    amount: totalExpense,
    percent: percentOf(totalExpense, input.pretaxBookIncome),
  });

  return {
    taxableIncome,
    currentTax,
    deferredExpense,
    totalExpense,
    balances: { dtaGross, dtlGross, valuationAllowance },
    movement,
    netTemporaryDifference: fromUnits(toUnits(netTemporaryDifference)),
    effectiveRatePercent: percentOf(totalExpense, input.pretaxBookIncome),
    rateReconciliation: steps,
    measured,
  };
}

// ---------------------------------------------------------------------------
// Enacted rates: jurisdiction stacking across scopes
// ---------------------------------------------------------------------------

/** A blended enacted rate plus the jurisdictions that composed it, retained so
 *  every provision run records exactly which rate configuration produced it. */
export interface EnactedRate {
  ratePercent: string;
  jurisdictions: string[];
}

/** One applicable enacted-rate row, tagged with the scope it was configured at. */
export interface EnactedRateComponent {
  jurisdiction: string;
  ratePercent: string;
  /** "org" = org-wide row (applies to every subsidiary); "subsidiary" = row
   *  configured for one legal entity. */
  scope: "org" | "subsidiary";
}

/**
 * Stack the enacted-rate rows that apply to one subsidiary into a single
 * blended rate. Jurisdictions compose additively (federal + state), the model
 * documented by `income_tax_rates`: org-wide rows apply to ALL subsidiaries
 * and STACK with the subsidiary's own rows, so an org-wide federal 21% plus a
 * subsidiary state 5% resolves to 26% — never the scoped rows alone. A
 * jurisdiction configured at BOTH scopes is ambiguous (which rate wins?) and
 * fails closed rather than guessing; a negative blend is misconfiguration and
 * throws here. Ordering is deterministic (sorted jurisdictions).
 */
export function stackEnactedRateComponents(
  components: EnactedRateComponent[],
): EnactedRate {
  const byJurisdiction = new Map<string, EnactedRateComponent[]>();
  for (const component of components) {
    const rows = byJurisdiction.get(component.jurisdiction) ?? [];
    rows.push(component);
    byJurisdiction.set(component.jurisdiction, rows);
  }
  let total = 0n;
  const jurisdictions: string[] = [];
  for (const jurisdiction of [...byJurisdiction.keys()].sort()) {
    const rows = byJurisdiction.get(jurisdiction)!;
    const scopes = new Set(rows.map((r) => r.scope));
    if (scopes.size > 1) {
      throw new IncomeTaxProvisionError(
        `income tax jurisdiction '${jurisdiction}' is configured both org-wide and subsidiary-scoped — remove one configuration so the enacted rate is unambiguous`,
      );
    }
    jurisdictions.push(jurisdiction);
    for (const row of rows) total += toUnits(row.ratePercent);
  }
  const ratePercent = fromUnits(total);
  if (cmp(ratePercent, "0") < 0) {
    throw new IncomeTaxProvisionError(
      `the enacted income tax rates configured for ${jurisdictions.join(" + ")} blend to a negative rate (${ratePercent}%) — correct the income tax rate configuration`,
    );
  }
  return { ratePercent, jurisdictions };
}

async function applicableRateRows(
  orgId: string,
  subsidiaryId: string | null,
  onDate: string,
): Promise<EnactedRateComponent[]> {
  const r = (await db.execute<{ jurisdiction: string; rate: string }>(sql`
    select jurisdiction, rate_percent::text as rate
      from income_tax_rates
     where org_id = ${orgId} and is_active
       and effective_from <= ${onDate} and (effective_to is null or effective_to >= ${onDate})
       and subsidiary_id is not distinct from ${subsidiaryId}
     order by jurisdiction, rate_percent
  `));
  return r.rows.map((row) => ({
    jurisdiction: row.jurisdiction,
    ratePercent: row.rate,
    scope: subsidiaryId === null ? "org" : "subsidiary",
  }));
}

/**
 * Blended enacted rate at a date for one subsidiary (or the org when no
 * subsidiary is given), or null when NO active rate row covers it: org-wide
 * rows always apply, subsidiary-scoped rows stack on top of them, and a
 * jurisdiction configured at both scopes fails closed. Null is distinct from a
 * genuine 0% combined rate — an unconfigured entity must fail the provision
 * closed, never compute at zero silently.
 */
export async function resolveEnactedRate(
  orgId: string,
  subsidiaryId: string | null,
  onDate: string,
): Promise<EnactedRate | null> {
  const wide = await applicableRateRows(orgId, null, onDate);
  const scoped = subsidiaryId
    ? await applicableRateRows(orgId, subsidiaryId, onDate)
    : [];
  if (wide.length === 0 && scoped.length === 0) return null;
  return stackEnactedRateComponents([...wide, ...scoped]);
}

// ---------------------------------------------------------------------------
// Source lineage — the fence that keeps a reviewed draft current
// ---------------------------------------------------------------------------

/** An enacted-rate row as captured in a run's source lineage. */
export interface RateRowFingerprint {
  jurisdiction: string;
  ratePercent: string;
  /** null = org-wide row. */
  subsidiaryId: string | null;
}

/** Per-entity deferred balances carried forward from the last posted run. */
export interface EntityBaseline extends DeferredBalances {
  netTemporaryDifference: string;
}

/** Whether an opening deferred-tax baseline gives an entity something to unwind. */
export function hasPriorDeferredTaxMeasurement(
  baseline: EntityBaseline | null | undefined,
): boolean {
  return (
    !isZero(baseline?.dtaGross ?? "0") ||
    !isZero(baseline?.dtlGross ?? "0") ||
    !isZero(baseline?.valuationAllowance ?? "0") ||
    !isZero(baseline?.netTemporaryDifference ?? "0")
  );
}

/**
 * Everything outside the preparer's own inputs that a provision measurement
 * depends on. Captured at compute time, stored in the draft payload, and
 * re-captured at post time: any difference means the draft no longer measures
 * the world it claims to and must be recomputed before posting.
 */
export interface ProvisionSourceSnapshot {
  framework: TaxFramework;
  /** Live pretax book income per subsidiary (zero-balance entities omitted). */
  pretaxBySubsidiaryId: Record<string, string>;
  /** Auto-derived book-vs-tax fixed-asset differences, canonical order. */
  fixedAssetDifferences: DifferenceInput[];
  /** Every active enacted-rate row the entities' scopes can see. */
  rateRows: RateRowFingerprint[];
  /** The earlier-FY posted run this run measures its movement from. */
  priorPostedRunId: string | null;
  priorPostedSnapshotHash: string | null;
  /** That run's deferred balances, attributed per entity. */
  priorBalancesBySubsidiaryId: Record<string, EntityBaseline>;
}

function canonicalDifferences(diffs: DifferenceInput[]): DifferenceInput[] {
  return [...diffs].sort((a, b) =>
    [
      a.subsidiaryId ?? "",
      a.category,
      a.description,
      a.bookBasis ?? "",
      a.taxBasis ?? "",
      a.difference,
      a.source,
    ].join("\u0000") <
    [
      b.subsidiaryId ?? "",
      b.category,
      b.description,
      b.bookBasis ?? "",
      b.taxBasis ?? "",
      b.difference,
      b.source,
    ].join("\u0000")
      ? -1
      : 1,
  );
}

function canonicalRates(rows: RateRowFingerprint[]): RateRowFingerprint[] {
  return [...rows].sort(
    (a, b) =>
      `${a.jurisdiction}\u0000${a.subsidiaryId ?? ""}`.localeCompare(
        `${b.jurisdiction}\u0000${b.subsidiaryId ?? ""}`,
      ) ||
      cmp(a.ratePercent, b.ratePercent),
  );
}

/**
 * Compare a captured lineage against the live one and name the sections that
 * drifted. Pure — the staleness decision is unit-testable without a database.
 */
export function detectProvisionSourceDrift(
  captured: ProvisionSourceSnapshot,
  current: ProvisionSourceSnapshot,
): string[] {
  const sections: [string, (s: ProvisionSourceSnapshot) => unknown][] = [
    ["framework", (s) => s.framework],
    ["pretax book income", (s) => s.pretaxBySubsidiaryId],
    ["fixed-asset temporary differences", (s) =>
      canonicalDifferences(s.fixedAssetDifferences)],
    ["enacted income tax rates", (s) => canonicalRates(s.rateRows)],
    ["prior-year posted baseline", (s) => ({
      runId: s.priorPostedRunId,
      snapshotHash: s.priorPostedSnapshotHash,
      balances: s.priorBalancesBySubsidiaryId,
    })],
  ];
  return sections
    .filter(([, get]) => canonicalJson(get(captured)) !== canonicalJson(get(current)))
    .map(([name]) => name);
}

async function pretaxBookIncomeBySubsidiary(
  orgId: string,
  from: string,
  to: string,
): Promise<Record<string, string>> {
  const r = (await db.execute<{ sid: string; pretax: string }>(sql`
    select l.subsidiary_id as sid, (-coalesce(sum(l.amount), 0))::text as pretax
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join accounting_books b on b.id = e.book_id and b.org_id = e.org_id
     where l.org_id = ${orgId} and b.is_primary
       and a.type in ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred')
       and e.posting_date >= ${from} and e.posting_date <= ${to}
       and e.origin <> 'tax_provision'
     group by l.subsidiary_id
     order by l.subsidiary_id
  `));
  const out: Record<string, string> = {};
  for (const row of r.rows) {
    // A net-zero entity contributes nothing to measure; keeping it out also
    // keeps the lineage stable when offsetting entries are added later.
    if (!isZero(row.pretax)) out[row.sid] = row.pretax;
  }
  return out;
}

/**
 * Book-vs-tax fixed-asset differences from per-book depreciation: cumulative
 * posted depreciation on the primary book vs the tax book (code 'tax'), per
 * subsidiary. Positive difference (tax depreciation ahead of book) is a
 * taxable temporary difference → DTL.
 */
export async function computeFixedAssetDifferences(
  orgId: string,
  fyEnd: string,
): Promise<DifferenceInput[]> {
  const r = (await db.execute<{
      subsidiary_id: string;
      subsidiary_name: string;
      cost: string;
      book_dep: string;
      tax_dep: string;
    }>(sql`
    with books as (
      select (select id from accounting_books where org_id = ${orgId} and is_primary) as primary_id,
             (select id from accounting_books where org_id = ${orgId} and code = 'tax' and is_active) as tax_id
    )
    select a.subsidiary_id, a.subsidiary_name,
           coalesce(sum(a.acquisition_cost), 0)::text as cost,
           coalesce(sum(a.book_dep), 0)::text as book_dep,
           coalesce(sum(a.tax_dep), 0)::text as tax_dep
      from (
        -- Collapse each asset's schedules and lines before summing acquisition
        -- cost. This keeps cost cardinality at one row per asset while still
        -- retaining every posted depreciation line in each book.
        select fa.id, fa.subsidiary_id, sub.name as subsidiary_name,
               fa.acquisition_cost,
               coalesce(sum(l.posted_amount) filter (where s.book_id = (select primary_id from books)), 0) as book_dep,
               coalesce(sum(l.posted_amount) filter (where s.book_id = (select tax_id from books)), 0) as tax_dep
          from fixed_assets fa
          join subsidiaries sub on sub.id = fa.subsidiary_id and sub.org_id = fa.org_id
          join depreciation_schedules s on s.asset_id = fa.id and s.org_id = fa.org_id
          join depreciation_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id and l.journal_entry_id is not null
          join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
         where fa.org_id = ${orgId} and p.ends_on <= ${fyEnd}
           and (select tax_id from books) is not null
         group by fa.id, fa.subsidiary_id, sub.name, fa.acquisition_cost
      ) a
     group by a.subsidiary_id, a.subsidiary_name
     order by a.subsidiary_id
  `));
  const out: DifferenceInput[] = [];
  for (const row of r.rows) {
    const difference = fromUnits(toUnits(row.tax_dep) - toUnits(row.book_dep));
    if (isZero(difference)) continue;
    out.push({
      category: "fixed_assets",
      description: `Property & equipment — book vs tax depreciation (${row.subsidiary_name})`,
      subsidiaryId: row.subsidiary_id,
      bookBasis: fromUnits(toUnits(row.cost) - toUnits(row.book_dep)),
      taxBasis: fromUnits(toUnits(row.cost) - toUnits(row.tax_dep)),
      difference,
      source: "auto",
    });
  }
  return out;
}

/**
 * Every active enacted-rate row the org's scopes can see at the date: all
 * org-wide rows plus each subsidiary's own rows. Capturing the full surface
 * keeps the lineage independent of which entities happen to have activity,
 * so any rate edit anywhere is caught at posting time.
 */
async function applicableRateFingerprintRows(
  orgId: string,
  onDate: string,
): Promise<RateRowFingerprint[]> {
  const rows: RateRowFingerprint[] = [];
  for (const row of await applicableRateRows(orgId, null, onDate)) {
    rows.push({ jurisdiction: row.jurisdiction, ratePercent: row.ratePercent, subsidiaryId: null });
  }
  const subs = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} order by id
  `));
  for (const { id } of subs.rows) {
    for (const row of await applicableRateRows(orgId, id, onDate)) {
      rows.push({ jurisdiction: row.jurisdiction, ratePercent: row.ratePercent, subsidiaryId: id });
    }
  }
  return canonicalRates(rows);
}

/**
 * The deferred-balance baseline a new run measures its movements from: the
 * latest posted run of an EARLIER fiscal year, per legal entity. Same-year
 * posted runs are excluded deliberately — posting supersedes and reverses
 * them, so the new run must carry those years' full balances (not a movement
 * against an entry that is about to be reversed). Runs recorded before
 * per-entity baselines existed posted everything to the root entity; their
 * flat balances are attributed there.
 */
async function latestPostedBaselines(
  orgId: string,
  beforeFiscalYear: number,
  rootSubsidiaryId: string | null,
): Promise<{
  runId: string | null;
  snapshotHash: string | null;
  bySubsidiaryId: Record<string, EntityBaseline>;
}> {
  const r = (await db.execute<{
    id: string;
    snapshot_hash: string;
    entities: {
      subsidiaryId: string;
      computation: Pick<ProvisionComputation, "balances" | "netTemporaryDifference">;
    }[] | null;
    dta: string | null;
    dtl: string | null;
    va: string | null;
    net_temp: string | null;
  }>(sql`
    select id, snapshot_hash,
           payload->'entities' as entities,
           payload->'balances'->>'dtaGross' as dta,
           payload->'balances'->>'dtlGross' as dtl,
           payload->'balances'->>'valuationAllowance' as va,
           coalesce(
             payload->>'netTemporaryDifference',
             -- Runs recorded before netTemporaryDifference was persisted:
             -- recover the cumulative basis-difference total from the run's own
             -- retained temporary_differences rows. Loss carryforwards are tax
             -- attributes, not basis differences, and are excluded.
             (select coalesce(sum(difference), 0)::text
                from temporary_differences td
               where td.org_id = ${orgId} and td.run_id = tax_provision_runs.id
                 and td.category <> 'loss_carryforward')
           ) as net_temp
      from tax_provision_runs
     where org_id = ${orgId} and status = 'posted' and fiscal_year < ${beforeFiscalYear}
     order by fiscal_year desc, version desc limit 1
  `));
  const row = r.rows[0];
  if (!row) {
    return { runId: null, snapshotHash: null, bySubsidiaryId: {} };
  }
  const bySubsidiaryId: Record<string, EntityBaseline> = {};
  if (Array.isArray(row.entities)) {
    for (const entity of row.entities) {
      bySubsidiaryId[entity.subsidiaryId] = {
        dtaGross: entity.computation.balances.dtaGross,
        dtlGross: entity.computation.balances.dtlGross,
        valuationAllowance: entity.computation.balances.valuationAllowance,
        netTemporaryDifference: entity.computation.netTemporaryDifference,
      };
    }
  } else if (rootSubsidiaryId && row.dta !== null && row.dtl !== null && row.va !== null) {
    bySubsidiaryId[rootSubsidiaryId] = {
      dtaGross: row.dta,
      dtlGross: row.dtl,
      valuationAllowance: row.va,
      netTemporaryDifference: row.net_temp ?? "0",
    };
  }
  return { runId: row.id, snapshotHash: row.snapshot_hash, bySubsidiaryId };
}

/** Capture the full source lineage of a provision measurement. Sequential
 *  queries: callers hold the org's advisory lock on one pinned client. */
async function captureProvisionSources(
  orgId: string,
  fiscalYear: number,
  range: { from: string; to: string },
): Promise<ProvisionSourceSnapshot> {
  const framework = await orgTaxFramework(orgId);
  const pretaxBySubsidiaryId = await pretaxBookIncomeBySubsidiary(
    orgId,
    range.from,
    range.to,
  );
  const fixedAssetDifferences = canonicalDifferences(
    await computeFixedAssetDifferences(orgId, range.to),
  );
  const rateRows = await applicableRateFingerprintRows(orgId, range.to);
  const rootSubsidiaryId =
    (
      (await db.execute<{ id: string | null }>(sql`
        select id from subsidiaries where org_id = ${orgId} and parent_id is null limit 1
      `))
    ).rows[0]?.id ?? null;
  const prior = await latestPostedBaselines(
    orgId,
    fiscalYear,
    rootSubsidiaryId,
  );
  return {
    framework,
    pretaxBySubsidiaryId,
    fixedAssetDifferences,
    rateRows,
    priorPostedRunId: prior.runId,
    priorPostedSnapshotHash: prior.snapshotHash,
    priorBalancesBySubsidiaryId: prior.bySubsidiaryId,
  };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type ProvisionRunRow = {
  id: string;
  fiscalYear: number;
  periodFrom: string;
  periodTo: string;
  status: string;
  version: number;
  totalExpense: string;
  effectiveRatePercent: string | null;
  journalEntryId: string | null;
  createdAt: string;
};

export async function listProvisionRuns(
  orgId: string,
  allowedSubsidiaryIds?: ProvisionSubsidiaryScope,
): Promise<ProvisionRunRow[]> {
  const r = (await db.execute<ProvisionRunRow & { payload: Record<string, unknown> }>(sql`
    select payload, id, fiscal_year as "fiscalYear", period_from::text as "periodFrom", period_to::text as "periodTo",
           status, version, payload->>'totalExpense' as "totalExpense",
           payload->>'effectiveRatePercent' as "effectiveRatePercent",
           journal_entry_id as "journalEntryId", created_at as "createdAt"
      from tax_provision_runs where org_id = ${orgId}
     order by fiscal_year desc, version desc
  `));
  return r.rows.flatMap(({ payload, ...row }) => {
    if (allowedSubsidiaryIds == null) return [row];
    const projected = projectProvisionPayload(payload, allowedSubsidiaryIds);
    if (!projected) return [];
    return [{ ...row, totalExpense: String(projected.totalExpense),
      effectiveRatePercent: projected.effectiveRatePercent == null ? null : String(projected.effectiveRatePercent) }];
  });
}

export type ProvisionRunDetail = ProvisionRunRow & {
  snapshotHash: string;
  payload: Record<string, unknown>;
  differences: {
    id: string;
    category: string;
    description: string;
    bookBasis: string;
    taxBasis: string;
    difference: string;
    ratePercent: string;
    taxEffect: string;
    source: string;
  }[];
};

/** The role-derived subsidiary visibility a caller carries into a provision
 * read. A null/undefined scope is unrestricted; an empty set matches nothing.
 * Provision runs are org-wide records, so restricted reads are projected to
 * the entity workpapers the caller is allowed to see. */
export type ProvisionSubsidiaryScope = ReadonlySet<string> | null | undefined;

/** Project an org-wide run payload to the caller's visible legal entities.
 * Every aggregate is recomputed from the projected entity workpapers so an
 * entity-restricted caller cannot infer another subsidiary's tax detail from
 * the consolidated totals or reconciliation steps. */
function projectProvisionPayload(
  payload: Record<string, unknown>,
  allowedSubsidiaryIds: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!Array.isArray(payload.entities)) return null;
  const entities = payload.entities.filter((entity): entity is EntityProvisionResult =>
    typeof entity === "object" &&
    entity !== null &&
    typeof (entity as { subsidiaryId?: unknown }).subsidiaryId === "string" &&
    allowedSubsidiaryIds.has((entity as { subsidiaryId: string }).subsidiaryId),
  );
  if (entities.length === 0) return null;

  const consolidated = consolidateEntityResults(entities);
  const projected: Record<string, unknown> = {
    ...payload,
    entities,
    pretaxBookIncome: consolidated.pretaxBookIncome,
    taxableIncome: consolidated.taxableIncome,
    currentTax: consolidated.currentTax,
    deferredExpense: consolidated.deferredExpense,
    totalExpense: consolidated.totalExpense,
    balances: consolidated.balances,
    movement: consolidated.movement,
    netTemporaryDifference: consolidated.netTemporaryDifference,
    effectiveRatePercent: consolidated.effectiveRatePercent,
    rateReconciliation: consolidated.rateReconciliation,
  };

  // These fields are root-entity echoes in the unrestricted payload. For a
  // restricted projection they must describe a visible entity, never the
  // hidden root or another subsidiary.
  const echo = entities[0]!;
  projected.enactedRatePercent = echo.enactedRatePercent;
  projected.enactedRateJurisdictions = echo.enactedRateJurisdictions;

  const lineage = payload.sourceLineage;
  if (typeof lineage === "object" && lineage !== null) {
    const source = lineage as {
      pretaxBySubsidiaryId?: unknown;
      fixedAssetDifferences?: unknown;
      rateRows?: unknown;
      priorBalancesBySubsidiaryId?: unknown;
    };
    const pretax = source.pretaxBySubsidiaryId;
    const priorBalances = source.priorBalancesBySubsidiaryId;
    projected.sourceLineage = {
      ...source,
      ...(typeof pretax === "object" && pretax !== null
        ? {
            pretaxBySubsidiaryId: Object.fromEntries(
              Object.entries(pretax).filter(([id]) => allowedSubsidiaryIds.has(id)),
            ),
          }
        : {}),
      ...(Array.isArray(source.fixedAssetDifferences)
        ? {
            fixedAssetDifferences: source.fixedAssetDifferences.filter((difference) =>
              typeof difference === "object" &&
              difference !== null &&
              typeof (difference as { subsidiaryId?: unknown }).subsidiaryId === "string" &&
              allowedSubsidiaryIds.has((difference as { subsidiaryId: string }).subsidiaryId),
            ),
          }
        : {}),
      ...(Array.isArray(source.rateRows)
        ? {
            rateRows: source.rateRows.filter((row) =>
              typeof row === "object" &&
              row !== null &&
              (typeof (row as { subsidiaryId?: unknown }).subsidiaryId !== "string" ||
                allowedSubsidiaryIds.has((row as { subsidiaryId: string }).subsidiaryId)),
            ),
          }
        : {}),
      ...(typeof priorBalances === "object" && priorBalances !== null
        ? {
            priorBalancesBySubsidiaryId: Object.fromEntries(
              Object.entries(priorBalances).filter(([id]) => allowedSubsidiaryIds.has(id)),
            ),
          }
        : {}),
    };
  }
  return projected;
}

export async function getProvisionRun(
  orgId: string,
  runId: string,
  allowedSubsidiaryIds?: ProvisionSubsidiaryScope,
): Promise<ProvisionRunDetail | null> {
  const runs = (await db.execute<ProvisionRunDetail>(sql`
    select id, fiscal_year as "fiscalYear", period_from::text as "periodFrom", period_to::text as "periodTo",
           status, version, payload->>'totalExpense' as "totalExpense",
           payload->>'effectiveRatePercent' as "effectiveRatePercent",
           journal_entry_id as "journalEntryId", created_at as "createdAt",
           snapshot_hash as "snapshotHash", payload
      from tax_provision_runs where org_id = ${orgId} and id = ${runId}
  `));
  const run = runs.rows[0];
  if (!run) return null;
  if (allowedSubsidiaryIds != null) {
    const projected = projectProvisionPayload(run.payload, allowedSubsidiaryIds);
    // A run has no single subsidiary column: no visible entity means the run
    // is indistinguishable from a missing record to a restricted caller.
    if (!projected) return null;
    run.payload = projected;
    run.totalExpense = String(projected.totalExpense);
    run.effectiveRatePercent =
      projected.effectiveRatePercent == null
        ? null
        : String(projected.effectiveRatePercent);
  }
  const differenceScope =
    allowedSubsidiaryIds == null
      ? sql``
      : allowedSubsidiaryIds.size > 0
        ? sql` and subsidiary_id in (${sql.join(
            [...allowedSubsidiaryIds].map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql` and false`;
  const diffs = (await db.execute<(ProvisionRunDetail["differences"])[number]>(sql`
    select id, category, description, book_basis as "bookBasis", tax_basis as "taxBasis",
           difference, rate_percent as "ratePercent", tax_effect as "taxEffect", source
      from temporary_differences where org_id = ${orgId} and run_id = ${runId}
       ${differenceScope}
     order by category, description
  `));
  run.differences = diffs.rows;
  return run;
}

/** Preparer-supplied inputs for ONE legal entity's provision component. */
export interface EntityProvisionInputs {
  permanentDifferences?: PermanentDifference[];
  lossCarryforwardUsed?: string;
  valuationAllowance?: string;
  additionalDifferences?: DifferenceInput[];
}

export interface ComputeProvisionOptions {
  /** Org-level inputs for the ROOT entity — the historical single-book shape.
   *  Other entities take their inputs through `entities`. */
  permanentDifferences?: PermanentDifference[];
  lossCarryforwardUsed?: string;
  valuationAllowance?: string;
  additionalDifferences?: DifferenceInput[];
  /** Per-entity overrides/additions keyed by subsidiary id. A field present
   *  here replaces the root default for that entity. Unattributed items
   *  (no subsidiaryId) always land on the root entity. */
  entities?: Record<string, EntityProvisionInputs>;
  /** Currency the consolidated view translates into (default: the org's base
   *  currency). Never affects the per-entity journals — those post in each
   *  entity's functional currency. */
  presentationCurrency?: string;
}

/** One legal entity's measured provision component, in its own words: the
 *  functional-currency amounts, the rate configuration that produced them,
 *  and the full measured difference detail (hashed into the draft identity). */
export interface EntityProvisionResult {
  subsidiaryId: string;
  name: string;
  /** Functional currency — the currency this entity's journal posts in. */
  currency: string;
  /** Spot rate used to translate this entity into the presentation currency;
   *  exactly "1" when the entity reports in the presentation currency. */
  fxRate: string;
  enactedRatePercent: string;
  enactedRateJurisdictions: string[];
  permanentDifferences: PermanentDifference[];
  lossCarryforwardUsed: string;
  valuationAllowance: string;
  pretaxBookIncome: string;
  computation: ProvisionComputation;
}

/**
 * Translate every entity component into the presentation currency and merge
 * them into the consolidated provision view. This is the ONLY place entity
 * amounts combine: each amount crosses currencies through its own recorded
 * fxRate (`mulRate`, exact decimal), so unlike currencies are never added
 * unit-for-unit. The merged rate reconciliation keeps the canonical step
 * order of the first entity and recomputes percentages against consolidated
 * pretax income. Pure — the arithmetic is unit-testable without a database.
 */
export function consolidateEntityResults(
  entities: EntityProvisionResult[],
): {
  pretaxBookIncome: string;
  taxableIncome: string;
  currentTax: string;
  deferredExpense: string;
  totalExpense: string;
  balances: DeferredBalances;
  movement: EntityProvisionResult["computation"]["movement"];
  netTemporaryDifference: string;
  effectiveRatePercent: string | null;
  rateReconciliation: RateReconStep[];
} {
  const ordered = [...entities].sort((a, b) =>
    a.subsidiaryId < b.subsidiaryId ? -1 : a.subsidiaryId > b.subsidiaryId ? 1 : 0,
  );
  const translate = (amounts: string[]) =>
    fromUnits(
      ordered.reduce(
        (acc, e, i) => acc + toUnits(mulRate(amounts[i]!, e.fxRate)),
        0n,
      ),
    );
  const field = (pick: (e: EntityProvisionResult) => string): string =>
    translate(ordered.map(pick));

  const pretaxBookIncome = field((e) => e.pretaxBookIncome);
  const taxableIncome = field((e) => e.computation.taxableIncome);
  const currentTax = field((e) => e.computation.currentTax);
  const deferredExpense = field((e) => e.computation.deferredExpense);
  const totalExpense = field((e) => e.computation.totalExpense);
  const balances: DeferredBalances = {
    dtaGross: field((e) => e.computation.balances.dtaGross),
    dtlGross: field((e) => e.computation.balances.dtlGross),
    valuationAllowance: field((e) => e.computation.balances.valuationAllowance),
  };
  const movement = {
    dtaGross: field((e) => e.computation.movement.dtaGross),
    dtlGross: field((e) => e.computation.movement.dtlGross),
    valuationAllowance: field(
      (e) => e.computation.movement.valuationAllowance,
    ),
  };
  const netTemporaryDifference = field(
    (e) => e.computation.netTemporaryDifference,
  );

  // Merge reconciliation steps by key; keys align structurally across
  // entities (statutory … total) except per-item permanent differences,
  // which legitimately appear as separate reconciling items.
  const merged = new Map<string, RateReconStep>();
  for (const entity of ordered) {
    for (const step of entity.computation.rateReconciliation) {
      const existing = merged.get(step.key);
      const translatedAmount = mulRate(step.amount, entity.fxRate);
      if (!existing) {
        merged.set(step.key, { ...step, amount: translatedAmount });
      } else {
        existing.amount = add(existing.amount, translatedAmount);
      }
    }
  }
  const rateReconciliation = [...merged.values()].map((step) => ({
    ...step,
    percent: percentOf(step.amount, pretaxBookIncome),
  }));

  return {
    pretaxBookIncome,
    taxableIncome,
    currentTax,
    deferredExpense,
    totalExpense,
    balances,
    movement,
    netTemporaryDifference,
    effectiveRatePercent: percentOf(totalExpense, pretaxBookIncome),
    rateReconciliation,
  };
}

async function fiscalYearRange(
  orgId: string,
  fiscalYear: number,
): Promise<{ from: string; to: string }> {
  const r = (await db.execute<{ from: string | null; to: string | null }>(sql`
    select min(starts_on)::text as "from", max(ends_on)::text as "to"
      from accounting_periods
     where org_id = ${orgId} and fiscal_year = ${fiscalYear} and not is_adjustment
  `));
  if (!r.rows[0]?.from || !r.rows[0].to)
    throw new IncomeTaxProvisionError(
      `no accounting periods for fiscal year ${fiscalYear}`,
    );
  return { from: r.rows[0].from, to: r.rows[0].to };
}

interface SubsidiaryRow {
  id: string;
  name: string;
  currency: string;
  parentId: string | null;
  controlAccounts: Record<string, string>;
}

async function loadSubsidiaries(orgId: string): Promise<SubsidiaryRow[]> {
  const r = (await db.execute<{
    id: string;
    name: string;
    currency: string;
    parent_id: string | null;
    control_accounts: Record<string, string> | null;
  }>(sql`
    select id, name, base_currency as currency, parent_id,
           control_accounts as "control_accounts"
      from subsidiaries where org_id = ${orgId}
     order by id
  `));
  return r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    currency: row.currency,
    parentId: row.parent_id,
    controlAccounts: row.control_accounts ?? {},
  }));
}

/**
 * Latest spot rate from a functional currency into the presentation currency
 * on or before the provisioning date — the same direct-then-inverted lookup
 * the posting kernel uses. Missing coverage fails closed: consolidating at an
 * invented rate would misstate every translated figure.
 */
async function spotRateToPresentation(
  orgId: string,
  fromCurrency: string,
  toCurrency: string,
  onDate: string,
): Promise<string> {
  if (fromCurrency === toCurrency) return "1";
  const r = (await db.execute<{ rate: string }>(sql`
    select rate::text from (
      select rate, as_of from fx_rates
       where org_id = ${orgId} and from_currency = ${fromCurrency}
         and to_currency = ${toCurrency} and rate_type = 'spot'
         and as_of <= ${onDate}
      union all
      select (1 / rate)::numeric(19,10) as rate, as_of from fx_rates
       where org_id = ${orgId} and from_currency = ${toCurrency}
         and to_currency = ${fromCurrency} and rate_type = 'spot'
         and as_of <= ${onDate}
    ) candidates order by as_of desc limit 1
  `));
  const rate = r.rows[0]?.rate;
  if (!rate) {
    throw new IncomeTaxProvisionError(
      `no spot FX rate for ${fromCurrency}→${toCurrency} on or before ${onDate} — configure exchange rates before computing a multi-currency provision`,
    );
  }
  return rate;
}

/** Compute (or recompute) the draft run for a fiscal year. Prior DRAFT runs
 *  of the same FY are replaced; posted runs are never touched. */
export async function computeProvisionRun(
  orgId: string,
  fiscalYear: number,
  opts: ComputeProvisionOptions,
  actorId: string,
): Promise<string> {
  if (!actorId) {
    throw new IncomeTaxProvisionError(
      "an attributable provision actor is required",
    );
  }
  return await withOrg(orgId, async () => {
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`income-tax-provision:${orgId}:${fiscalYear}`}, 0)
      )
    `);
    const range = await fiscalYearRange(orgId, fiscalYear);

    // withOrg pins one PostgreSQL client for the whole provision run. Keep
    // queries sequential on that client: concurrent client.query calls rely on
    // pg's deprecated implicit queueing and make execution order ambiguous.
    const subsidiaries = await loadSubsidiaries(orgId);
    const roots = subsidiaries.filter((s) => s.parentId === null);
    const root = roots[0] ?? null;
    const known = new Set(subsidiaries.map((s) => s.id));

    const orgRow = (await db.execute<{ base_currency: string | null }>(sql`
      select base_currency from orgs where id = ${orgId}
    `));
    const presentationCurrency =
      opts.presentationCurrency ??
      orgRow.rows[0]?.base_currency ??
      root?.currency;

    // Capture the ENTIRE source surface once; both the measurement and the
    // stored lineage derive from this snapshot, so what was measured is
    // exactly what can be re-verified at posting time.
    const sources = await captureProvisionSources(orgId, fiscalYear, range);

    // Attribute manual inputs to their legal entities; unknown attributions
    // and unattributable inputs without a root fail loudly instead of landing
    // somewhere arbitrary.
    const knownOrRoot = new Set([...known]);
    const manualByEntity = new Map<string, DifferenceInput[]>();
    for (const d of opts.additionalDifferences ?? []) {
      const target = d.subsidiaryId ?? root?.id ?? null;
      if (!target || !knownOrRoot.has(target)) {
        throw new IncomeTaxProvisionError(
          `temporary difference "${d.description}" references subsidiary ${d.subsidiaryId ?? "(none)"}, which is not a subsidiary of this organization`,
        );
      }
      const list = manualByEntity.get(target) ?? [];
      list.push(d);
      manualByEntity.set(target, list);
    }
    const permanentByEntity = new Map<string, PermanentDifference[]>();
    for (const p of opts.permanentDifferences ?? []) {
      const target = p.subsidiaryId ?? root?.id ?? null;
      if (!target || !knownOrRoot.has(target)) {
        throw new IncomeTaxProvisionError(
          `permanent difference "${p.description}" references subsidiary ${p.subsidiaryId ?? "(none)"}, which is not a subsidiary of this organization`,
        );
      }
      const list = permanentByEntity.get(target) ?? [];
      list.push(p);
      permanentByEntity.set(target, list);
    }

    // The auto fixed-asset differences are already per-entity; group them.
    const autoByEntity = new Map<string, DifferenceInput[]>();
    for (const d of sources.fixedAssetDifferences) {
      if (!d.subsidiaryId) continue;
      const list = autoByEntity.get(d.subsidiaryId) ?? [];
      list.push(d);
      autoByEntity.set(d.subsidiaryId, list);
    }

    // Entity set: every legal entity with anything to measure. Prior deferred
    // balances are a measurement source too: even when an entity has no
    // current-year activity, its opening DTA/DTL (or cumulative basis
    // difference) must be carried into this run so the balance can unwind.
    const entityIds = [...new Set([
      ...Object.keys(sources.pretaxBySubsidiaryId),
      ...autoByEntity.keys(),
      ...manualByEntity.keys(),
      ...permanentByEntity.keys(),
      ...Object.keys(sources.priorBalancesBySubsidiaryId),
      ...(opts.entities ? Object.keys(opts.entities) : []),
    ])]
      .filter((id) => known.has(id))
      .sort();
    const measuredEntities = entityIds.filter((id) => {
      const override = opts.entities?.[id];
      const prior = sources.priorBalancesBySubsidiaryId[id];
      return (
        !isZero(sources.pretaxBySubsidiaryId[id] ?? "0") ||
        (autoByEntity.get(id)?.length ?? 0) > 0 ||
        (manualByEntity.get(id)?.length ?? 0) > 0 ||
        (permanentByEntity.get(id)?.length ?? 0) > 0 ||
        (override?.permanentDifferences?.length ?? 0) > 0 ||
        (override?.additionalDifferences?.length ?? 0) > 0 ||
        hasPriorDeferredTaxMeasurement(prior) ||
        !isZero(override?.lossCarryforwardUsed ?? (id === root?.id ? opts.lossCarryforwardUsed ?? "0" : "0")) ||
        !isZero(override?.valuationAllowance ?? (id === root?.id ? opts.valuationAllowance ?? "0" : "0"))
      );
    });
    // Degenerate org (no activity anywhere): keep the historical behavior of a
    // computable zero draft on the root entity rather than failing obscurely.
    const effectiveEntityIds =
      measuredEntities.length > 0
        ? measuredEntities
        : root
          ? [root.id]
          : [];

    const results: EntityProvisionResult[] = [];
    for (const subsidiaryId of effectiveEntityIds) {
      const sub = subsidiaries.find((s) => s.id === subsidiaryId)!;
      const override = opts.entities?.[subsidiaryId];
      const isRoot = subsidiaryId === root?.id;
      const permanentDifferences = [
        ...(permanentByEntity.get(subsidiaryId) ?? []),
        ...(override?.permanentDifferences ?? []),
      ];
      const differences = [
        ...(autoByEntity.get(subsidiaryId) ?? []),
        ...(manualByEntity.get(subsidiaryId) ?? []),
        ...(override?.additionalDifferences ?? []),
      ];
      const lossCarryforwardUsed =
        override?.lossCarryforwardUsed ??
        (isRoot ? opts.lossCarryforwardUsed ?? "0" : "0");
      const valuationAllowance =
        override?.valuationAllowance ??
        (isRoot ? opts.valuationAllowance ?? "0" : "0");

      // Stack this entity's applicable jurisdictions: org-wide rows always
      // apply, subsidiary rows layer on top, ambiguity fails closed.
      const components = sources.rateRows
        .filter(
          (row) =>
            row.subsidiaryId === null || row.subsidiaryId === subsidiaryId,
        )
        .map((row) => ({
          jurisdiction: row.jurisdiction,
          ratePercent: row.ratePercent,
          scope: row.subsidiaryId === null ? ("org" as const) : ("subsidiary" as const),
        }));
      if (components.length === 0) {
        throw new IncomeTaxProvisionError(
          `no enacted income tax rate covers ${sub.name} for fiscal year ${fiscalYear} (period ending ${range.to}) — configure income tax rates before computing a provision`,
        );
      }
      const resolvedRate = stackEnactedRateComponents(components);

      const pretax = sources.pretaxBySubsidiaryId[subsidiaryId] ?? "0";
      const prior = sources.priorBalancesBySubsidiaryId[subsidiaryId] ?? {
        dtaGross: "0",
        dtlGross: "0",
        valuationAllowance: "0",
        netTemporaryDifference: "0",
      };
      const computation = buildProvision({
        pretaxBookIncome: pretax,
        enactedRatePercent: resolvedRate.ratePercent,
        permanentDifferences,
        lossCarryforwardUsed,
        valuationAllowance,
        differences,
        framework: sources.framework,
        prior: {
          dtaGross: prior.dtaGross,
          dtlGross: prior.dtlGross,
          valuationAllowance: prior.valuationAllowance,
        },
        priorNetTemporaryDifference: prior.netTemporaryDifference,
      });
      const fxRate = await spotRateToPresentation(
        orgId,
        sub.currency,
        presentationCurrency ?? sub.currency,
        range.to,
      );
      results.push({
        subsidiaryId,
        name: sub.name,
        currency: sub.currency,
        fxRate,
        enactedRatePercent: resolvedRate.ratePercent,
        enactedRateJurisdictions: resolvedRate.jurisdictions,
        permanentDifferences,
        lossCarryforwardUsed,
        valuationAllowance,
        pretaxBookIncome: pretax,
        computation,
      });
    }

    const consolidated = consolidateEntityResults(results);
    const echo = results.find((r) => r.subsidiaryId === root?.id) ?? results[0];

    const payload = {
      fiscalYear,
      framework: sources.framework,
      presentationCurrency,
      // Per-entity workpapers — the journals post from these, in each
      // entity's functional currency, with the FULL measured detail hashed
      // into the draft identity.
      entities: results,
      // Consolidated view: explicitly translated, never a raw unit sum.
      pretaxBookIncome: consolidated.pretaxBookIncome,
      taxableIncome: consolidated.taxableIncome,
      currentTax: consolidated.currentTax,
      deferredExpense: consolidated.deferredExpense,
      totalExpense: consolidated.totalExpense,
      balances: consolidated.balances,
      movement: consolidated.movement,
      netTemporaryDifference: consolidated.netTemporaryDifference,
      effectiveRatePercent: consolidated.effectiveRatePercent,
      rateReconciliation: consolidated.rateReconciliation,
      priorPostedRunId: sources.priorPostedRunId,
      // Root-entity echo of the rate configuration for single-entity readers.
      enactedRatePercent: echo?.enactedRatePercent ?? "0",
      enactedRateJurisdictions: echo?.enactedRateJurisdictions ?? [],
      // Source lineage fence: verified unchanged at posting time.
      sourceLineage: sources,
      sourceFingerprint: createHash("sha256")
        .update(canonicalJson(sources))
        .digest("hex"),
    };
    // Canonical JSON: the hash survives the jsonb store/read cycle, so the
    // draft identity is reproducible from stored evidence alone.
    const snapshotHash = createHash("sha256")
      .update(canonicalJson(payload))
      .digest("hex");

    // An identical retry returns the existing draft. A changed recomputation —
    // including one whose aggregate totals match but whose temporary-
    // difference DETAIL differs — hashes differently and preserves the prior
    // draft as discarded audit evidence; draft financial workpapers are never
    // physically deleted.
    const priorDrafts = (await db.execute<{ id: string; snapshot_hash: string }>(sql`
      select id, snapshot_hash
        from tax_provision_runs
       where org_id = ${orgId} and fiscal_year = ${fiscalYear}
         and status = 'draft'
       order by version desc
       for update
    `));
    const identical = priorDrafts.rows.find(
      (draft) => draft.snapshot_hash === snapshotHash,
    );
    if (identical) {
      return identical.id;
    }
    const versionRow = (await db.execute<{ v: number }>(sql`
      select coalesce(max(version), 0)::int as v from tax_provision_runs where org_id = ${orgId} and fiscal_year = ${fiscalYear}
    `));
    const version = (versionRow.rows[0]?.v ?? 0) + 1;

    const runId = randomUUID();
    for (const draft of priorDrafts.rows) {
      await db.execute(sql`
        update tax_provision_runs
           set status = 'discarded', updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${draft.id} and status = 'draft'
      `);
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${orgId}, 'tax_provision_runs', ${draft.id}, 'discard',
           ${JSON.stringify({
             reason: "recomputed before posting",
             replacedByRunId: runId,
           })}::jsonb,
           ${actorId})
      `);
    }
    await db.execute(sql`
      insert into tax_provision_runs
        (id, org_id, fiscal_year, period_from, period_to, status, version, snapshot_hash, payload, created_by, updated_by)
      values (${runId}, ${orgId}, ${fiscalYear}, ${range.from}, ${range.to}, 'draft', ${version}, ${snapshotHash},
              ${JSON.stringify(payload)}::jsonb, ${actorId}, ${actorId})
    `);
    for (const entity of results) {
      for (const d of entity.computation.measured) {
        await db.execute(sql`
          insert into temporary_differences
            (org_id, run_id, category, description, subsidiary_id, book_basis, tax_basis, difference, rate_percent, tax_effect, source, created_by, updated_by)
          values (${orgId}, ${runId}, ${d.category}, ${d.description}, ${d.subsidiaryId ?? entity.subsidiaryId},
                  ${d.bookBasis ?? "0"}, ${d.taxBasis ?? "0"}, ${d.difference}, ${d.ratePercent}, ${d.taxEffect}, ${d.source},
                  ${actorId}, ${actorId})
        `);
      }
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_provision_runs', ${runId}, 'insert',
              ${JSON.stringify({ after: { fiscalYear, version, totalExpense: consolidated.totalExpense, effectiveRatePercent: consolidated.effectiveRatePercent, entities: results.length } })}::jsonb,
              ${actorId})
    `);
    return runId;
  });
}

interface IncomeTaxControlAccounts {
  incomeTaxExpense?: string;
  incomeTaxPayable?: string;
  deferredTaxAsset?: string;
  deferredTaxLiability?: string;
  valuationAllowance?: string;
}

/** Stable, collision-resistant identity for one organization's legal entity.
 * The full digest avoids truncating UUIDs (which can collide in practice) and
 * keeps the organization boundary explicit even though entry numbers are
 * currently unique within an organization. */
function provisionEntityIdentity(orgId: string, subsidiaryId: string): string {
  return createHash("sha256")
    .update(`${orgId}\u0000${subsidiaryId}`)
    .digest("hex");
}

/** Deterministic, collision-free journal numbering: the run's (fiscal year,
 *  version) is unique per org and the organization/entity identity separates
 *  the per-entity journals of one run, so any number of reposts in a fiscal
 *  year produce distinct, reproducible numbers. */
export function provisionEntryNumber(
  fiscalYear: number,
  version: number,
  orgId: string,
  subsidiaryId: string,
): string {
  return `ITX-FY${fiscalYear}-v${version}-${provisionEntityIdentity(orgId, subsidiaryId)}`;
}

/** The reversal of the entry a superseded run of `supersededVersion` posted
 *  for one entity. Distinct from every other reversal because versions never
 *  repeat within an org+fiscal year — the third same-year repost writes
 *  ITX-REV-FY<v>-… for v2, never colliding with v1's reversal. */
export function provisionReversalEntryNumber(
  fiscalYear: number,
  supersededVersion: number,
  orgId: string,
  subsidiaryId: string,
): string {
  return `ITX-REV-FY${fiscalYear}-v${supersededVersion}-${provisionEntityIdentity(orgId, subsidiaryId)}`;
}

/**
 * Post a draft run: verify its source lineage is still live, reverse EVERY
 * entry the same-FY posted run wrote (when reposting), then post one balanced
 * journal per entity in that entity's FUNCTIONAL currency — the kernel keeps
 * each legal entity's books balanced on their own. The run becomes the FY's
 * posted provision; the superseded run keeps its payload.
 */
export async function postProvisionRun(
  orgId: string,
  runId: string,
  actorId: string,
): Promise<{ entryId: string }> {
  if (!actorId) {
    throw new IncomeTaxProvisionError(
      "an attributable provision actor is required",
    );
  }
  return await withOrg(orgId, async () => {
    const scope = (await db.execute<{ fiscal_year: number }>(sql`
      select fiscal_year
        from tax_provision_runs
       where org_id = ${orgId} and id = ${runId}
    `));
    if (!scope.rows[0]) {
      throw new IncomeTaxProvisionError("provision run not found");
    }
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(
          ${`income-tax-provision:${orgId}:${scope.rows[0].fiscal_year}`},
          0
        )
      )
    `);
    const run = await getProvisionRun(orgId, runId);
    if (!run) throw new IncomeTaxProvisionError("provision run not found");
    if (
      (run.status === "posted" || run.status === "superseded") &&
      run.journalEntryId
    ) {
      return { entryId: run.journalEntryId };
    }
    if (run.status !== "draft")
      throw new IncomeTaxProvisionError(`provision run is ${run.status}`);
    // Postings must be chronological: a later posted year would strand its
    // movement baseline if an earlier year changed underneath it.
    const later = (await db.execute(sql`
      select 1 from tax_provision_runs
       where org_id = ${orgId} and status = 'posted' and fiscal_year > ${run.fiscalYear} limit 1
    `));
    if (later.rows.length > 0) {
      throw new IncomeTaxProvisionError(
        `a posted provision already exists for a later fiscal year — recompute and repost the later year after changing FY${run.fiscalYear}`,
      );
    }

    // SOURCE LINEAGE FENCE — before any write. Re-capture the world the draft
    // measured and refuse to post if any source moved: journals, enacted
    // rates, fixed-asset bases or a prior provision changed after the draft
    // was reviewed mean the stored numbers are stale. Zero business rows are
    // written on rejection; the reviewer recomputes instead.
    const payload = run.payload as {
      fiscalYear: number;
      entities: EntityProvisionResult[];
      currentTax: string;
      totalExpense: string;
      sourceLineage?: ProvisionSourceSnapshot;
      sourceFingerprint?: string;
    };
    if (
      !payload.sourceLineage ||
      !payload.sourceFingerprint ||
      !Array.isArray(payload.entities) ||
      payload.entities.length === 0
    ) {
      throw new IncomeTaxProvisionError(
        `provision draft for FY${run.fiscalYear} predates source-lineage binding — recompute it before posting`,
      );
    }
    const liveSources = await captureProvisionSources(
      orgId,
      run.fiscalYear,
      { from: run.periodFrom, to: run.periodTo },
    );
    const drifted = detectProvisionSourceDrift(
      payload.sourceLineage,
      liveSources,
    );
    if (drifted.length > 0) {
      throw new IncomeTaxProvisionError(
        `income tax provision draft for FY${run.fiscalYear} is stale: ${drifted.join(", ")} changed after computation — recompute before posting`,
      );
    }

    const c =
      (
        (await db.execute<{ c: IncomeTaxControlAccounts | null }>(sql`
      select settings->'controlAccounts' as c from orgs where id = ${orgId}
    `))
      ).rows[0]?.c ?? {};
    const subsidiaries = await loadSubsidiaries(orgId);
    const accountFor = (
      key: keyof IncomeTaxControlAccounts,
      amount: string,
      entity: EntityProvisionResult,
    ): string | null => {
      if (isZero(amount)) return null;
      // Per-subsidiary control-account overrides win over the org default —
      // the same precedence every other posting surface uses.
      const account =
        subsidiaries.find((s) => s.id === entity.subsidiaryId)?.controlAccounts[key] ??
        c[key];
      if (!account)
        throw new IncomeTaxProvisionError(
          `income tax control account '${key}' is not configured (Company Settings)`,
        );
      return account;
    };

    const bookId = (
      (await db.execute<{ id: string }>(sql`
      select id from accounting_books where org_id = ${orgId} and is_primary limit 1
    `))
    ).rows[0]?.id;
    if (!bookId)
      throw new IncomeTaxProvisionError("no primary accounting book");
    const periodId = (
      (await db.execute<{ id: string }>(sql`
      select id from accounting_periods
       where org_id = ${orgId} and is_adjustment = false and starts_on <= ${run.periodTo} and ends_on >= ${run.periodTo}
       limit 1
    `))
    ).rows[0]?.id;
    if (!periodId)
      throw new IncomeTaxProvisionError(
        `no accounting period covers ${run.periodTo}`,
      );

    // Build every entity's journal plan BEFORE writing anything, so an
    // all-zero provision (or an unconfigured control account) aborts without
    // leaving a half-unwound ledger.
    const orderedEntities = [...payload.entities].sort((a, b) =>
      a.subsidiaryId < b.subsidiaryId
        ? -1
        : a.subsidiaryId > b.subsidiaryId
          ? 1
          : 0,
    );
    interface PlannedEntry {
      entity: EntityProvisionResult;
      lines: { accountId: string; amount: string; memo: string }[];
    }
    const plans: PlannedEntry[] = [];
    for (const entity of orderedEntities) {
      const lines: PlannedEntry["lines"] = [];
      const payable = accountFor("incomeTaxPayable", entity.computation.currentTax, entity);
      const expenseAccount = accountFor("incomeTaxExpense", entity.computation.totalExpense, entity);
      const dtaAccount = accountFor("deferredTaxAsset", entity.computation.movement.dtaGross, entity);
      const dtlAccount = accountFor("deferredTaxLiability", entity.computation.movement.dtlGross, entity);
      const vaAccount = accountFor(
        "valuationAllowance",
        entity.computation.movement.valuationAllowance,
        entity,
      );
      if (payable)
        lines.push({
          accountId: payable,
          amount: neg(entity.computation.currentTax),
          memo: `Current income tax FY${run.fiscalYear} — ${entity.name}`,
        });
      if (dtaAccount)
        lines.push({
          accountId: dtaAccount,
          amount: entity.computation.movement.dtaGross,
          memo: "Movement in deferred tax assets",
        });
      if (dtlAccount)
        lines.push({
          accountId: dtlAccount,
          amount: neg(entity.computation.movement.dtlGross),
          memo: "Movement in deferred tax liabilities",
        });
      if (vaAccount)
        lines.push({
          accountId: vaAccount,
          amount: neg(entity.computation.movement.valuationAllowance),
          memo: "Movement in valuation allowance",
        });
      if (expenseAccount)
        lines.push({
          accountId: expenseAccount,
          amount: entity.computation.totalExpense,
          memo: `Income tax expense FY${run.fiscalYear} — ${entity.name}`,
        });
      const nonzero = lines.filter((l) => !isZero(l.amount));
      if (nonzero.length === 0) continue;
      // Each entity's journal balances in ITS functional currency, for ITS
      // legal entity — the kernel enforces per-subsidiary balance again.
      assertFinalKernelBalance(
        nonzero.map((l) => ({ amount: l.amount, subsidiaryId: entity.subsidiaryId })),
      );
      plans.push({ entity, lines: nonzero });
    }
    if (plans.length === 0)
      throw new IncomeTaxProvisionError("provision is zero — nothing to post");

    const entityIds = orderedEntities.map((e) => e.subsidiaryId);
    await assertPeriodModulesOpen(db, {
      orgId,
      periodId,
      bookId,
      subsidiaryIds: entityIds,
      modules: ["tax"],
    });

    // Reverse the FY's previously posted run: EVERY entry that run wrote, in
    // every entity, numbered deterministically from the SUPERSEDED run's
    // version so same-year reposts never collide.
    const priorPosted = (await db.execute<{ id: string; journal_entry_id: string | null; version: number }>(sql`
      select id, journal_entry_id, version from tax_provision_runs
       where org_id = ${orgId} and fiscal_year = ${run.fiscalYear} and status = 'posted' and id <> ${runId}
       order by version desc limit 1
    `));
    const reversalEntryIds: string[] = [];
    if (priorPosted.rows[0]) {
      const priorRun = priorPosted.rows[0];
      const prefix = `ITX-FY${run.fiscalYear}-v${priorRun.version}`;
      const priorEntries = (await db.execute<{ id: string; subsidiary_id: string }>(sql`
        select id, subsidiary_id from journal_entries
         where org_id = ${orgId} and origin = 'tax_provision' and status = 'posted'
           and (entry_number = ${prefix} or entry_number like ${`${prefix}-%`})
         order by entry_number
      `));
      for (const priorEntry of priorEntries.rows) {
        const reversalEntryId = randomUUID();
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, reverses_entry_id, created_by, updated_by)
          values (${reversalEntryId}, ${orgId}, ${bookId}, ${priorEntry.subsidiary_id},
                  ${provisionReversalEntryNumber(run.fiscalYear, priorRun.version, orgId, priorEntry.subsidiary_id)},
                  ${run.periodTo}, ${periodId}, ${`Reverse income tax provision FY${run.fiscalYear}`}, 'draft', 'tax_provision',
                  ${priorEntry.id}, ${actorId}, ${actorId})
        `);
        // Mirror-copy negates each line in place: subsidiary, currency and
        // functional amounts carry over exactly as originally posted.
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
          select ${orgId}, ${reversalEntryId}, line_number, account_id, subsidiary_id, -amount, currency, -txn_amount, fx_rate,
                 'Reversal — ' || coalesce(memo, '')
            from journal_lines where org_id = ${orgId} and entry_id = ${priorEntry.id}
        `);
        await db.execute(
          sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${reversalEntryId} and org_id = ${orgId}`,
        );
        await db.execute(sql`
          update journal_entries
             set status = 'reversed', updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId}
             and id = ${priorEntry.id}
             and status = 'posted'
        `);
        reversalEntryIds.push(reversalEntryId);
      }
      await db.execute(sql`
        update tax_provision_runs set status = 'superseded', updated_at = now(), updated_by = ${actorId}
         where id = ${priorRun.id} and org_id = ${orgId}
      `);
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${orgId}, 'tax_provision_runs', ${priorRun.id},
           'supersede',
           ${JSON.stringify({
             reason: "recomputed income tax provision",
             replacementRunId: runId,
             reversalEntryIds,
           })}::jsonb,
           ${actorId})
      `);
    }

    // One journal per entity, in the entity's functional currency.
    const entryIds: string[] = [];
    for (const plan of plans) {
      const entryId = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
        values (${entryId}, ${orgId}, ${bookId}, ${plan.entity.subsidiaryId},
                ${provisionEntryNumber(run.fiscalYear, run.version, orgId, plan.entity.subsidiaryId)},
                ${run.periodTo}, ${periodId}, ${`Income tax provision FY${run.fiscalYear} (v${run.version})`}, 'draft', 'tax_provision',
                ${actorId}, ${actorId})
      `);
      for (let i = 0; i < plan.lines.length; i++) {
        const l = plan.lines[i]!;
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
          values (${orgId}, ${entryId}, ${i + 1}, ${l.accountId}, ${plan.entity.subsidiaryId},
                  ${l.amount}, ${plan.entity.currency}, ${l.amount}, 1, ${l.memo})
        `);
      }
      await db.execute(
        sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${entryId} and org_id = ${orgId}`,
      );
      entryIds.push(entryId);
    }
    const entryId = entryIds[0]!;
    await db.execute(sql`
      update tax_provision_runs
         set status = 'posted', journal_entry_id = ${entryId}, posted_at = now(), posted_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where id = ${runId} and org_id = ${orgId}
    `);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_provision_runs', ${runId}, 'post',
              ${JSON.stringify({ after: { journalEntryId: entryId, journalEntryIds: entryIds, reversalEntryIds, totalExpense: payload.totalExpense } })}::jsonb,
              ${actorId})
    `);
    return { entryId };
  });
}
