import { add, cmp, neg, roundMoney, sum } from "./money.ts";
import { PayrollError } from "./payroll-error.ts";

/**
 * Retroactive pay — the arithmetic, with no database, no clock and no
 * configuration in it.
 *
 * A union agreement settles in March with a wage increase effective the
 * previous 1 January. Ten pay periods have already gone out at the old rate.
 * Retro pay is the four-step answer to that, and this module owns step two:
 *
 *   detect    — an effective-dated change whose window covers periods already
 *               committed (engine/src/payroll-retro-store.ts).
 *   QUANTIFY  — for each affected committed period, what it WOULD pay today
 *               against what it DID pay, differenced bucket by bucket. The
 *               "would pay" side is produced by re-running THE PAY RUN'S OWN
 *               calculation over the committed run (calculatePayRun's
 *               `simulate` seam), never by a second implementation of what a
 *               period pays — two implementations are two answers, and the
 *               second one drifts.
 *   review    — the operator sees old / new / delta per employee per period
 *               before a cent moves.
 *   pay       — a `retro` pay run whose earning lines ARE these buckets.
 *
 * COUNTRY-AGNOSTIC. Nothing here branches on a country or a region. How a
 * retro amount is TAXED is a pack declaration (`retroactivePayTreatment` in
 * engine/src/payroll/packs.ts); whether it accrues vacation is the pay
 * component's own `vacationable` flag. This module only knows money and the
 * dimensions money belongs to.
 *
 * ALL ARITHMETIC IS BIGINT (engine/src/money.ts). No floats anywhere.
 */

export class RetroPayError extends PayrollError {}

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * What nominated a committed period for re-quantification.
 *
 * Detection is deliberately GENEROUS and quantification is the truth: a
 * trigger only says "this period's inputs moved after it was paid", and the
 * recomputation then says whether that changed the money. A trigger that fires
 * on a period whose earnings are unchanged costs one recalculation and
 * produces a zero delta, which is dropped — whereas a trigger that is too
 * clever to fire loses somebody real money silently.
 */
export type RetroTriggerSource =
  /** labor_cost_rates, employee scope — the ONE home for a wage. */
  | "wage_rate"
  /** employee_pay_components — a backdated allowance/deduction assignment. */
  | "pay_component"
  /** Approved hours inside a paid period that no pay run ever claimed. */
  | "unclaimed_time";

export interface RetroReason {
  source: RetroTriggerSource;
  /** Human sentence naming the specific row and its effective date. */
  detail: string;
}

/**
 * One earning line as either side of the difference sees it.
 *
 * The two sides are the SAME shape on purpose: the committed side is read out
 * of `pay_stub_lines`, and the recomputed side is read out of the stub rows the
 * simulated calculation wrote inside a transaction that was then rolled back.
 * Both are the pay run's own output, so the difference compares like with like.
 */
export interface RetroEarningLine {
  componentId: string | null;
  description: string;
  projectId: string | null;
  departmentId: string | null;
  amount: string;
  hours: string | null;
}

/**
 * What earlier COMMITTED retro runs have already settled for one bucket.
 *
 * This is the exactly-once control, and it is a high-water mark rather than a
 * flag for a reason a flag cannot cover: when March's increase is itself
 * corrected in May, the further difference on those same ten periods is
 * genuinely owed. Recording what was settled TO makes paying the same money
 * twice arithmetically impossible without making a second correction
 * unpayable.
 */
export interface RetroSettledBucket {
  componentId: string | null;
  projectId: string | null;
  departmentId: string | null;
  /** Sum of `amount` over committed retro allocations for this bucket. */
  previouslySettled: string;
  /** Description as the earlier settlement recorded it, for a vanished bucket. */
  description?: string | null;
}

/** One (component, project, department) bucket of a difference. */
export interface RetroBucket {
  componentId: string | null;
  description: string;
  projectId: string | null;
  departmentId: string | null;
  originalAmount: string;
  recomputedAmount: string;
  previouslySettled: string;
  /** recomputed − original − previouslySettled. May be negative on its own. */
  amount: string;
  originalHours: string | null;
  recomputedHours: string | null;
}

export interface RetroDifference {
  originalEarnings: string;
  recomputedEarnings: string;
  previouslySettled: string;
  /** recomputed − original − previouslySettled. */
  delta: string;
  /** Every bucket either side (or an earlier settlement) touched. */
  buckets: RetroBucket[];
}

/**
 * What the difference means for one employee for one already-paid period.
 *
 * `overpaid` is its own outcome, never a negative payment. A backdated
 * DECREASE is an overpayment recovery: it has its own consent, notice and
 * statutory-recovery rules in every jurisdiction this product runs in, and
 * netting it into a retro cheque would take money out of somebody's pay
 * without any of them. It is reported and refused.
 */
export type RetroOutcome = "payable" | "none" | "overpaid";

export function retroOutcome(delta: string): RetroOutcome {
  const sign = cmp(delta, "0");
  return sign > 0 ? "payable" : sign < 0 ? "overpaid" : "none";
}

/* ------------------------------------------------------------------ */
/* The difference                                                      */
/* ------------------------------------------------------------------ */

/** The identity of a bucket. Untagged is ONE bucket, not many. */
export function retroBucketKey(bucket: {
  componentId: string | null;
  projectId: string | null;
  departmentId: string | null;
}): string {
  return [bucket.componentId ?? "", bucket.projectId ?? "", bucket.departmentId ?? ""].join("|");
}

interface BucketAccumulator {
  componentId: string | null;
  projectId: string | null;
  departmentId: string | null;
  description: string | null;
  original: string;
  recomputed: string;
  settled: string;
  originalHours: string | null;
  recomputedHours: string | null;
}

/**
 * Difference one already-paid period against what it would pay today.
 *
 * Bucketing by (component, project, department) and differencing each bucket
 * — rather than differencing the totals and allocating the result — is what
 * puts retro wages on the jobs the original hours were charged to, in the
 * proportions those hours had. It is also exact by construction: both sides
 * are stub amounts already rounded to the cent, so the bucket deltas sum to
 * the total delta with no remainder to lose or invent. There is nothing to
 * allocate, which is a stronger guarantee than allocating carefully.
 *
 * A bucket can be negative while the period as a whole is positive — one job's
 * hours were reclassified onto another — and that is correct job costing, so
 * bucket signs are preserved. The PERIOD's sign is what decides whether
 * anything is payable at all (see `retroOutcome`).
 *
 * The bucket universe is the union of all three inputs, including buckets that
 * exist only in an earlier settlement. Dropping those would silently re-pay a
 * bucket that has since disappeared from both sides.
 */
export function differenceRetroEarnings(input: {
  original: readonly RetroEarningLine[];
  recomputed: readonly RetroEarningLine[];
  settled?: readonly RetroSettledBucket[];
}): RetroDifference {
  const buckets = new Map<string, BucketAccumulator>();
  const slot = (bucket: {
    componentId: string | null; projectId: string | null; departmentId: string | null;
  }): BucketAccumulator => {
    const key = retroBucketKey(bucket);
    const existing = buckets.get(key);
    if (existing) return existing;
    const created: BucketAccumulator = {
      componentId: bucket.componentId ?? null,
      projectId: bucket.projectId ?? null,
      departmentId: bucket.departmentId ?? null,
      description: null,
      original: "0", recomputed: "0", settled: "0",
      originalHours: null, recomputedHours: null,
    };
    buckets.set(key, created);
    return created;
  };
  const addHours = (current: string | null, hours: string | null): string | null =>
    hours == null ? current : add(current ?? "0", hours);

  for (const line of input.original) {
    const bucket = slot(line);
    bucket.original = add(bucket.original, line.amount);
    bucket.originalHours = addHours(bucket.originalHours, line.hours);
    bucket.description ??= line.description;
  }
  for (const line of input.recomputed) {
    const bucket = slot(line);
    bucket.recomputed = add(bucket.recomputed, line.amount);
    bucket.recomputedHours = addHours(bucket.recomputedHours, line.hours);
    // The CURRENT description wins: it is what the retro stub will show, and
    // it is the one the operator can still recognise.
    bucket.description = line.description;
  }
  for (const entry of input.settled ?? []) {
    const bucket = slot(entry);
    bucket.settled = add(bucket.settled, entry.previouslySettled);
    bucket.description ??= entry.description ?? null;
  }

  const rows: RetroBucket[] = [...buckets.values()].map((bucket) => ({
    componentId: bucket.componentId,
    description: bucket.description ?? "Retroactive pay",
    projectId: bucket.projectId,
    departmentId: bucket.departmentId,
    originalAmount: roundMoney(bucket.original, 2),
    recomputedAmount: roundMoney(bucket.recomputed, 2),
    previouslySettled: roundMoney(bucket.settled, 2),
    amount: roundMoney(
      add(add(bucket.recomputed, neg(bucket.original)), neg(bucket.settled)),
      2,
    ),
    originalHours: bucket.originalHours,
    recomputedHours: bucket.recomputedHours,
  }));

  const originalEarnings = sum(rows.map((r) => r.originalAmount));
  const recomputedEarnings = sum(rows.map((r) => r.recomputedAmount));
  const previouslySettled = sum(rows.map((r) => r.previouslySettled));
  const delta = add(add(recomputedEarnings, neg(originalEarnings)), neg(previouslySettled));

  const difference: RetroDifference = {
    originalEarnings, recomputedEarnings, previouslySettled, delta,
    // Largest first, so the review screen leads with the money.
    buckets: rows.sort((a, b) => cmp(b.amount, a.amount)),
  };
  assertRetroDifferenceExact(difference);
  return difference;
}

/**
 * The two invariants a difference must satisfy before anything is written.
 *
 * These are asserted rather than assumed because the whole feature is one
 * subtraction repeated across ten periods and a hundred people: an error of a
 * cent that nothing checks becomes an error nobody can find. Both are cheap
 * and both are total.
 */
export function assertRetroDifferenceExact(difference: RetroDifference): void {
  const bucketTotal = sum(difference.buckets.map((bucket) => bucket.amount));
  if (cmp(bucketTotal, difference.delta) !== 0) {
    throw new RetroPayError(
      `retro allocation ${bucketTotal} does not equal the ${difference.delta} difference it splits`,
    );
  }
  const identity = add(
    add(difference.recomputedEarnings, neg(difference.originalEarnings)),
    neg(difference.previouslySettled),
  );
  if (cmp(identity, difference.delta) !== 0) {
    throw new RetroPayError(
      `retro difference ${difference.delta} is not ${difference.recomputedEarnings} `
      + `− ${difference.originalEarnings} − ${difference.previouslySettled}`,
    );
  }
}

/**
 * The buckets a retro run actually pays, for a difference that IS payable.
 *
 * Zero buckets are dropped (they would be stub lines for nothing), and the
 * result is re-asserted against the delta afterwards so dropping them can
 * never quietly change the total.
 */
export function payableRetroBuckets(difference: RetroDifference): RetroBucket[] {
  if (retroOutcome(difference.delta) !== "payable") {
    throw new RetroPayError(
      `a retro difference of ${difference.delta} is not payable — `
      + "a backdated decrease is an overpayment recovery, which has its own consent and "
      + "notice rules and is never netted into a retro cheque",
    );
  }
  const paying = difference.buckets.filter((bucket) => cmp(bucket.amount, "0") !== 0);
  const total = sum(paying.map((bucket) => bucket.amount));
  if (cmp(total, difference.delta) !== 0) {
    throw new RetroPayError(
      `retro lines ${total} do not equal the ${difference.delta} owed`,
    );
  }
  return paying;
}

/* ------------------------------------------------------------------ */
/* What a retro run owes, in total                                     */
/* ------------------------------------------------------------------ */

/** One employee's whole retro position across every period being made good. */
export interface RetroEmployeeSummary {
  employeePartyId: string;
  employeeName: string;
  periods: number;
  /** Sum of the payable deltas. */
  payable: string;
  /** Sum of the deltas that are negative — reported, never paid. */
  overpaid: string;
}

/**
 * Roll a set of per-period differences up per employee.
 *
 * Payable and overpaid are kept APART rather than netted. Netting them would
 * quietly recover an overpayment out of a retro cheque, which is the one thing
 * a retro run must never do on its own authority.
 */
export function summarizeRetro(
  entries: readonly {
    employeePartyId: string;
    employeeName: string;
    delta: string;
  }[],
): RetroEmployeeSummary[] {
  const byEmployee = new Map<string, RetroEmployeeSummary>();
  for (const entry of entries) {
    const summary = byEmployee.get(entry.employeePartyId) ?? {
      employeePartyId: entry.employeePartyId,
      employeeName: entry.employeeName,
      // `sum([])`, not the literal "0": every money value this module hands
      // out is the ledger's canonical four-decimal string, so a caller
      // comparing two of them never has to know which path produced it.
      periods: 0, payable: sum([]), overpaid: sum([]),
    };
    summary.periods += 1;
    if (retroOutcome(entry.delta) === "payable") {
      summary.payable = add(summary.payable, entry.delta);
    } else if (retroOutcome(entry.delta) === "overpaid") {
      summary.overpaid = add(summary.overpaid, entry.delta);
    }
    byEmployee.set(entry.employeePartyId, summary);
  }
  return [...byEmployee.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}
