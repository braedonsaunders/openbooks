import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "./db.ts";
import {
  add,
  cmp,
  fromUnits,
  isZero,
  mulPercent,
  neg,
  sum,
  toUnits,
} from "./money.ts";
import { assertPeriodModulesOpen } from "./close.ts";
import { assertFinalKernelBalance } from "./posting.ts";

/**
 * ASC 740 / IAS 12 income-tax provision. A run measures:
 *   current tax  = max(0, pretax ± permanent − loss used) × enacted rate
 *   deferred tax = temporary differences × enacted rate → DTA/DTL, net of a
 *                  valuation allowance against gross DTA
 * and posts the MOVEMENT from the last posted run to this one as one balanced
 * journal (origin 'tax_provision') through the kernel, gated on the `tax`
 * close module. Reposting a fiscal year reverses that year's posted entry and
 * supersedes its run, so the ledger accumulates movements exactly once and the
 * audit trail (runs, payloads, reversal chain) is complete.
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

/** Pure: the entire provision computation, side-effect free. */
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
// Org data
// ---------------------------------------------------------------------------

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

/** A blended enacted rate plus the jurisdictions that composed it, retained so
 *  every provision run records exactly which rate configuration produced it. */
export interface EnactedRate {
  ratePercent: string;
  jurisdictions: string[];
}

async function activeRatesAt(
  orgId: string,
  subsidiaryId: string | null,
  onDate: string,
): Promise<EnactedRate> {
  const r = (await db.execute<{ rate: string; jurisdictions: string[] }>(sql`
    select coalesce(sum(rate_percent), 0)::text as rate,
           coalesce(jsonb_agg(distinct jurisdiction order by jurisdiction), '[]'::jsonb) as jurisdictions
      from income_tax_rates
     where org_id = ${orgId} and is_active
       and effective_from <= ${onDate} and (effective_to is null or effective_to >= ${onDate})
       and subsidiary_id is not distinct from ${subsidiaryId}
  `));
  return {
    ratePercent: r.rows[0]?.rate ?? "0",
    jurisdictions: r.rows[0]?.jurisdictions ?? [],
  };
}

/**
 * Blended enacted rate at a date, or null when NO active rate row covers it:
 * subsidiary-scoped rows win whenever any exist, else org-wide rows; stacked
 * jurisdictions sum. Null is distinct from a genuine 0% combined rate — an
 * unconfigured jurisdiction must fail the provision closed, never compute at
 * zero silently. A negative blend is misconfiguration and throws here.
 */
export async function resolveEnactedRate(
  orgId: string,
  subsidiaryId: string | null,
  onDate: string,
): Promise<EnactedRate | null> {
  let resolved: EnactedRate | null = null;
  if (subsidiaryId) {
    const scoped = await activeRatesAt(orgId, subsidiaryId, onDate);
    if (scoped.jurisdictions.length > 0) resolved = scoped;
  }
  if (!resolved) {
    const wide = await activeRatesAt(orgId, null, onDate);
    if (wide.jurisdictions.length > 0) resolved = wide;
  }
  if (!resolved) return null;
  if (cmp(resolved.ratePercent, "0") < 0)
    throw new IncomeTaxProvisionError(
      `the enacted income tax rates configured for ${resolved.jurisdictions.join(" + ")} as of ${onDate} blend to a negative rate (${resolved.ratePercent}%) — correct the income tax rate configuration`,
    );
  return resolved;
}

async function pretaxBookIncome(
  orgId: string,
  from: string,
  to: string,
): Promise<string> {
  const r = (await db.execute<{ pretax: string }>(sql`
    select (-coalesce(sum(l.amount), 0))::text as pretax
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join accounting_books b on b.id = e.book_id and b.org_id = e.org_id
     where l.org_id = ${orgId} and b.is_primary
       and a.type in ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred')
       and e.posting_date >= ${from} and e.posting_date <= ${to}
       and e.origin <> 'tax_provision'
  `));
  return r.rows[0]?.pretax ?? "0";
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
    select a.subsidiary_id, sub.name as subsidiary_name,
           coalesce(sum(a.acquisition_cost), 0)::text as cost,
           coalesce(sum(l.posted_amount) filter (where s.book_id = (select primary_id from books)), 0)::text as book_dep,
           coalesce(sum(l.posted_amount) filter (where s.book_id = (select tax_id from books)), 0)::text as tax_dep
      from fixed_assets a
      join subsidiaries sub on sub.id = a.subsidiary_id and sub.org_id = a.org_id
      join depreciation_schedules s on s.asset_id = a.id and s.org_id = a.org_id
      join depreciation_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id and l.journal_entry_id is not null
      join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
     where a.org_id = ${orgId} and p.ends_on <= ${fyEnd}
       and (select tax_id from books) is not null
     group by a.subsidiary_id, sub.name
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
): Promise<ProvisionRunRow[]> {
  const r = (await db.execute<ProvisionRunRow>(sql`
    select id, fiscal_year as "fiscalYear", period_from::text as "periodFrom", period_to::text as "periodTo",
           status, version, payload->>'totalExpense' as "totalExpense",
           payload->>'effectiveRatePercent' as "effectiveRatePercent",
           journal_entry_id as "journalEntryId", created_at as "createdAt"
      from tax_provision_runs where org_id = ${orgId}
     order by fiscal_year desc, version desc
  `));
  return r.rows;
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

export async function getProvisionRun(
  orgId: string,
  runId: string,
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
  const diffs = (await db.execute<(ProvisionRunDetail["differences"])[number]>(sql`
    select id, category, description, book_basis as "bookBasis", tax_basis as "taxBasis",
           difference, rate_percent as "ratePercent", tax_effect as "taxEffect", source
      from temporary_differences where org_id = ${orgId} and run_id = ${runId}
     order by category, description
  `));
  run.differences = diffs.rows;
  return run;
}

/**
 * The deferred-balance baseline a new run measures its movement from: the
 * latest posted run of an EARLIER fiscal year. Same-year posted runs are
 * excluded deliberately — posting supersedes and reverses them, so the new
 * run must carry that year's full balances (not a movement against an entry
 * that is about to be reversed).
 */
async function latestPostedBalances(
  orgId: string,
  beforeFiscalYear: number,
): Promise<{
  runId: string | null;
  dtaGross: string;
  dtlGross: string;
  valuationAllowance: string;
  netTemporaryDifference: string;
}> {
  const r = (await db.execute<{ id: string; dta: string; dtl: string; va: string; net_temp: string | null }>(sql`
    select id, payload->'balances'->>'dtaGross' as dta, payload->'balances'->>'dtlGross' as dtl,
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
  return row
    ? {
        runId: row.id,
        dtaGross: row.dta,
        dtlGross: row.dtl,
        valuationAllowance: row.va,
        netTemporaryDifference: row.net_temp ?? "0",
      }
    : { runId: null, dtaGross: "0", dtlGross: "0", valuationAllowance: "0", netTemporaryDifference: "0" };
}

export interface ComputeProvisionOptions {
  permanentDifferences?: PermanentDifference[];
  lossCarryforwardUsed?: string;
  valuationAllowance?: string;
  additionalDifferences?: DifferenceInput[];
  /** Root/primary subsidiary for enacted-rate resolution (default root). */
  subsidiaryId?: string | null;
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
    const subsidiaryId =
      opts.subsidiaryId ??
      (
        (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgId} and parent_id is null limit 1
    `))
      ).rows[0]?.id ??
      null;
    // withOrg pins one PostgreSQL client for the whole provision run. Keep
    // queries sequential on that client: concurrent client.query calls rely on
    // pg's deprecated implicit queueing and make execution order ambiguous.
    const pretax = await pretaxBookIncome(orgId, range.from, range.to);
    const resolvedRate = await resolveEnactedRate(
      orgId,
      subsidiaryId ?? null,
      range.to,
    );
    if (!resolvedRate) {
      const scope = subsidiaryId
        ? (
            (await db.execute<{ name: string }>(sql`
              select name from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}
            `))
          ).rows[0]?.name ?? subsidiaryId
        : "the organization";
      throw new IncomeTaxProvisionError(
        `no enacted income tax rate covers ${scope} for fiscal year ${fiscalYear} (period ending ${range.to}) — configure income tax rates before computing a provision`,
      );
    }
    const rate = resolvedRate.ratePercent;
    const autoDiffs = await computeFixedAssetDifferences(orgId, range.to);
    const prior = await latestPostedBalances(orgId, fiscalYear);
    const framework = await orgTaxFramework(orgId);

    const differences = [...autoDiffs, ...(opts.additionalDifferences ?? [])];
    const computation = buildProvision({
      pretaxBookIncome: pretax,
      enactedRatePercent: rate,
      permanentDifferences: opts.permanentDifferences ?? [],
      lossCarryforwardUsed: opts.lossCarryforwardUsed ?? "0",
      valuationAllowance: opts.valuationAllowance ?? "0",
      differences,
      framework,
      prior: {
        dtaGross: prior.dtaGross,
        dtlGross: prior.dtlGross,
        valuationAllowance: prior.valuationAllowance,
      },
      priorNetTemporaryDifference: prior.netTemporaryDifference,
    });

    const payload = {
      fiscalYear,
      framework,
      pretaxBookIncome: pretax,
      enactedRatePercent: rate,
      enactedRateJurisdictions: resolvedRate.jurisdictions,
      permanentDifferences: opts.permanentDifferences ?? [],
      lossCarryforwardUsed: opts.lossCarryforwardUsed ?? "0",
      taxableIncome: computation.taxableIncome,
      currentTax: computation.currentTax,
      deferredExpense: computation.deferredExpense,
      totalExpense: computation.totalExpense,
      balances: computation.balances,
      movement: computation.movement,
      netTemporaryDifference: computation.netTemporaryDifference,
      effectiveRatePercent: computation.effectiveRatePercent,
      rateReconciliation: computation.rateReconciliation,
      priorPostedRunId: prior.runId,
    };
    const snapshotHash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");

    // An identical retry returns the existing draft. A changed recomputation
    // preserves the prior draft as discarded audit evidence; draft financial
    // workpapers are never physically deleted.
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
    for (const d of computation.measured) {
      await db.execute(sql`
        insert into temporary_differences
          (org_id, run_id, category, description, subsidiary_id, book_basis, tax_basis, difference, rate_percent, tax_effect, source, created_by, updated_by)
        values (${orgId}, ${runId}, ${d.category}, ${d.description}, ${d.subsidiaryId ?? null},
                ${d.bookBasis ?? "0"}, ${d.taxBasis ?? "0"}, ${d.difference}, ${d.ratePercent}, ${d.taxEffect}, ${d.source},
                ${actorId}, ${actorId})
      `);
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_provision_runs', ${runId}, 'insert',
              ${JSON.stringify({ after: { fiscalYear, version, totalExpense: computation.totalExpense, effectiveRatePercent: computation.effectiveRatePercent } })}::jsonb,
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

/**
 * Post a draft run: reverse the same-FY posted entry (when reposting), then
 * post the MOVEMENT vs the last posted run as one balanced journal. The run
 * becomes the FY's posted provision; the superseded run keeps its payload.
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
    const payload = run.payload as {
      currentTax: string;
      totalExpense: string;
      balances: DeferredBalances;
      movement: {
        dtaGross: string;
        dtlGross: string;
        valuationAllowance: string;
      };
      priorPostedRunId: string | null;
    };

    const c =
      (
        (await db.execute<{ c: IncomeTaxControlAccounts | null }>(sql`
      select settings->'controlAccounts' as c from orgs where id = ${orgId}
    `))
      ).rows[0]?.c ?? {};
    const need = (
      key: keyof IncomeTaxControlAccounts,
      amount: string,
    ): string | null => {
      if (isZero(amount)) return null;
      const account = c[key];
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
    const subsidiaryId = (
      (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgId} and parent_id is null limit 1
    `))
    ).rows[0]?.id;
    if (!subsidiaryId) throw new IncomeTaxProvisionError("no root subsidiary");
    const currency =
      (
        (await db.execute<{ c: string }>(sql`
      select base_currency as c from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}
    `))
      ).rows[0]?.c ?? "USD";

    // The journal is the MOVEMENT vs the last posted run, posted at FY end.
    const payable = need("incomeTaxPayable", payload.currentTax);
    const expenseAccount = need("incomeTaxExpense", payload.totalExpense);
    const dtaAccount = need("deferredTaxAsset", payload.movement.dtaGross);
    const dtlAccount = need("deferredTaxLiability", payload.movement.dtlGross);
    const vaAccount = need(
      "valuationAllowance",
      payload.movement.valuationAllowance,
    );

    const lines: { accountId: string; amount: string; memo: string }[] = [];
    if (payable)
      lines.push({
        accountId: payable,
        amount: neg(payload.currentTax),
        memo: `Current income tax FY${run.fiscalYear}`,
      });
    if (dtaAccount)
      lines.push({
        accountId: dtaAccount,
        amount: payload.movement.dtaGross,
        memo: "Movement in deferred tax assets",
      });
    if (dtlAccount)
      lines.push({
        accountId: dtlAccount,
        amount: neg(payload.movement.dtlGross),
        memo: "Movement in deferred tax liabilities",
      });
    if (vaAccount)
      lines.push({
        accountId: vaAccount,
        amount: neg(payload.movement.valuationAllowance),
        memo: "Movement in valuation allowance",
      });
    if (expenseAccount)
      lines.push({
        accountId: expenseAccount,
        amount: payload.totalExpense,
        memo: `Income tax expense FY${run.fiscalYear}`,
      });
    const nonzero = lines.filter((l) => !isZero(l.amount));
    if (nonzero.length === 0)
      throw new IncomeTaxProvisionError("provision is zero — nothing to post");
    assertFinalKernelBalance(
      nonzero.map((l) => ({ amount: l.amount, subsidiaryId })),
    );

    await assertPeriodModulesOpen(db, {
      orgId,
      periodId,
      bookId,
      subsidiaryIds: [subsidiaryId],
      modules: ["tax"],
    });

    // Reverse the FY's previously posted entry (repost path).
    const priorPosted = (await db.execute<{ id: string; journal_entry_id: string | null }>(sql`
      select id, journal_entry_id from tax_provision_runs
       where org_id = ${orgId} and fiscal_year = ${run.fiscalYear} and status = 'posted' and id <> ${runId}
       order by version desc limit 1
    `));
    let reversalEntryId: string | null = null;
    if (priorPosted.rows[0]?.journal_entry_id) {
      reversalEntryId = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, reverses_entry_id, created_by, updated_by)
        values (${reversalEntryId}, ${orgId}, ${bookId}, ${subsidiaryId}, ${`ITX-REV-FY${run.fiscalYear}`},
                ${run.periodTo}, ${periodId}, ${`Reverse income tax provision FY${run.fiscalYear}`}, 'draft', 'tax_provision',
                ${priorPosted.rows[0].journal_entry_id}, ${actorId}, ${actorId})
      `);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
        select ${orgId}, ${reversalEntryId}, line_number, account_id, subsidiary_id, -amount, currency, -txn_amount, fx_rate,
               'Reversal — ' || coalesce(memo, '')
          from journal_lines where org_id = ${orgId} and entry_id = ${priorPosted.rows[0].journal_entry_id}
      `);
      await db.execute(
        sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${reversalEntryId} and org_id = ${orgId}`,
      );
      await db.execute(sql`
        update journal_entries
           set status = 'reversed', updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId}
           and id = ${priorPosted.rows[0].journal_entry_id}
           and status = 'posted'
      `);
      await db.execute(sql`
        update tax_provision_runs set status = 'superseded', updated_at = now(), updated_by = ${actorId}
         where id = ${priorPosted.rows[0].id} and org_id = ${orgId}
      `);
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${orgId}, 'tax_provision_runs', ${priorPosted.rows[0].id},
           'supersede',
           ${JSON.stringify({
             reason: "recomputed income tax provision",
             replacementRunId: runId,
             reversalEntryId,
           })}::jsonb,
           ${actorId})
      `);
    }

    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${entryId}, ${orgId}, ${bookId}, ${subsidiaryId}, ${`ITX-FY${run.fiscalYear}-v${run.version}`},
              ${run.periodTo}, ${periodId}, ${`Income tax provision FY${run.fiscalYear} (v${run.version})`}, 'draft', 'tax_provision',
              ${actorId}, ${actorId})
    `);
    for (let i = 0; i < nonzero.length; i++) {
      const l = nonzero[i]!;
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
        values (${orgId}, ${entryId}, ${i + 1}, ${l.accountId}, ${subsidiaryId}, ${l.amount}, ${currency}, ${l.amount}, 1, ${l.memo})
      `);
    }
    await db.execute(
      sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${entryId} and org_id = ${orgId}`,
    );
    await db.execute(sql`
      update tax_provision_runs
         set status = 'posted', journal_entry_id = ${entryId}, posted_at = now(), posted_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where id = ${runId} and org_id = ${orgId}
    `);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_provision_runs', ${runId}, 'post',
              ${JSON.stringify({ after: { journalEntryId: entryId, reversalEntryId, totalExpense: payload.totalExpense } })}::jsonb,
              ${actorId})
    `);
    return { entryId };
  });
}
