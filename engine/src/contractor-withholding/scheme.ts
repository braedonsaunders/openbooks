// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction.io, licensed under AGPL-3.0-or-later.
/**
 * Contractor withholding arithmetic — what is deducted from a payment to a
 * subcontractor, at which band, on which base.
 *
 * Every decision is a pure function of the scheme a country pack declares,
 * the payee's recorded standing and the bill being paid, so the money that
 * leaves the business is testable without a database. Three rules hold:
 *
 *   1. THE BASE is the paid share of the bill's subject lines. A payment
 *      settles a bill proportionally, so each payment carries the same share
 *      of labour, materials and VAT as the bill it pays; the scheme declares
 *      whether direct materials costs and VAT leave the base.
 *   2. THE BAND comes from a verification that is current on the payment
 *      date. A reduced band without one falls to the scheme's default band,
 *      which is always its highest rate, and the fall is reported.
 *   3. THE THRESHOLD, where a scheme declares one, is a Freigrenze: once the
 *      payee's consideration for the calendar year exceeds it, the earlier
 *      payments of that year become subject too and are caught up on the
 *      payment that crosses it.
 */
import type { ContractorWithholdingBand, ContractorWithholdingSchemeDefinition } from "../country-tax-packs/index.ts";
import { add, apportion, cmp, fromUnits, isZero, mulPercent, roundDiv, toUnits } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { addMonthsStart, civilDateFromParts, daysInCivilMonth, parseIsoDate } from "../platform/civil-date.ts";
import { withholdingCurrencyRate, withholdingStatutoryAmount } from "./payment-currency.ts";

export class ContractorWithholdingError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = "ContractorWithholdingError";
  }
}

/** How a bill line counts toward a withholding base. */
export type WithholdingLineTreatment = "labour" | "materials" | "excluded";
export const WITHHOLDING_LINE_TREATMENTS: readonly WithholdingLineTreatment[] = ["labour", "materials", "excluded"];

/** The payee's recorded standing under one scheme. */
export interface WithholdingStanding {
  id: string;
  bandCode: string;
  verificationReference: string | null;
  validFrom: string;
  validTo: string | null;
  status: "active" | "revoked";
  /** Deduct from the first payment of the year rather than waiting for the threshold. */
  applyFromFirstPayment: boolean;
}

export interface WithholdingReason {
  code:
    | "verification_missing"
    | "verification_not_current"
    | "standing_revoked"
    | "below_threshold"
    | "threshold_crossed"
    | "deduction_capped";
  message: string;
  amount?: string;
}

export interface BandDecision {
  bandCode: string;
  ratePercent: string;
  downgradedFrom: string | null;
  reasons: WithholdingReason[];
}

function findBand(scheme: ContractorWithholdingSchemeDefinition, code: string): ContractorWithholdingBand | undefined {
  return scheme.bands.find((band) => band.code === code);
}

/** The band's statutory rate on `date`; refuses when the schedule does not cover it. */
export function bandRateOn(scheme: ContractorWithholdingSchemeDefinition, bandCode: string, date: string): string {
  const band = findBand(scheme, bandCode);
  if (!band) throw new ContractorWithholdingError(`${scheme.name} has no band ${bandCode}`);
  const rate = band.rates.find((r) => r.effectiveFrom <= date && (!r.effectiveTo || r.effectiveTo >= date));
  if (!rate) {
    throw new ContractorWithholdingError(
      `${scheme.name} declares no ${band.name} rate in force on ${date}`,
      "Payments dated before the scheme's published rate history cannot be deducted automatically.",
    );
  }
  return rate.ratePercent;
}

/** Whether a standing's verification supports its band on `date`. */
export function verificationCurrent(standing: WithholdingStanding, date: string): boolean {
  if (standing.status !== "active") return false;
  if (!(standing.verificationReference ?? "").trim()) return false;
  if (standing.validFrom > date) return false;
  return standing.validTo === null || standing.validTo >= date;
}

/** Decide the band a payment on `date` is deducted at. */
export function resolveBand(
  scheme: ContractorWithholdingSchemeDefinition,
  standing: WithholdingStanding,
  date: string,
): BandDecision {
  const requested = findBand(scheme, standing.bandCode);
  if (!requested) {
    throw new ContractorWithholdingError(
      `the payee's ${scheme.name} band ${standing.bandCode} is not a band of the scheme`,
      "Correct the band on the subcontractor's withholding standing.",
    );
  }
  const fallback = findBand(scheme, scheme.defaultBandCode);
  if (!fallback) throw new ContractorWithholdingError(`${scheme.name} declares no default band`);
  const reasons: WithholdingReason[] = [];
  let band = requested;
  if (standing.status === "revoked") {
    reasons.push({
      code: "standing_revoked",
      message: `The ${scheme.name} standing was revoked, so the ${fallback.name} band applies.`,
    });
    band = fallback;
  } else if (requested.requiresVerification && (!verificationCurrent(standing, date) || (requested.verificationRequiresEndDate && standing.validTo === null))) {
    const missing = !(standing.verificationReference ?? "").trim();
    reasons.push({
      code: missing ? "verification_missing" : "verification_not_current",
      message: requested.verificationRequiresEndDate && standing.validTo === null && !missing
        ? `The ${scheme.verificationLabel.toLowerCase()} has no recorded expiry date, so the ${fallback.name} band applies.`
        : missing
        ? `The ${requested.name} band needs a recorded ${scheme.verificationLabel.toLowerCase()}, so the ${fallback.name} band applies.`
        : `The ${scheme.verificationLabel.toLowerCase()} behind the ${requested.name} band is not valid on ${date}, so the ${fallback.name} band applies.`,
    });
    band = fallback;
  }
  return {
    bandCode: band.code,
    ratePercent: bandRateOn(scheme, band.code, date),
    downgradedFrom: band.code === requested.code ? null : requested.code,
    reasons,
  };
}

/** One bill line, in the bill's transaction currency. */
export interface WithholdingBillLine {
  /** Net line amount, excluding VAT. */
  amount: string;
  /** Standard (VAT/GST) tax on the line. */
  vat: string;
  treatment: WithholdingLineTreatment;
  /** Subcontractor direct cost, rather than the material selling price. */
  materialsCost?: string | null;
  /** A retainage hold or release line rather than work billed. */
  retainage: boolean;
}

/** The parts of one bill that a payment settles proportionally. */
export interface BillComposition {
  /** Gross of the lines the shares are taken from. */
  denominator: bigint;
  net: bigint;
  /** Direct cost where the scheme excludes materials; selling price otherwise. */
  materials: bigint;
  vat: bigint;
  base: bigint;
}

/**
 * Split a bill into the parts withholding reads. Retainage lines are left out
 * of the shares when the bill also carries work lines, because a retention
 * holds back a slice of every work line alike; a bill made only of retainage
 * (a release) is read by its own lines. Excluded lines (supplies outside the
 * scheme) stay in the denominator so a payment carries their share out.
 */
export function composeBill(
  scheme: ContractorWithholdingSchemeDefinition,
  lines: readonly WithholdingBillLine[],
): BillComposition {
  const hasWork = lines.some((line) => !line.retainage);
  const considered = lines.filter((line) => !hasWork || !line.retainage);
  let denominator = 0n;
  let net = 0n;
  let materials = 0n;
  let vat = 0n;
  let base = 0n;
  for (const line of considered) {
    const lineNet = toUnits(line.amount);
    const lineVat = toUnits(line.vat);
    denominator += lineNet + lineVat;
    if (line.treatment === "excluded") continue;
    net += lineNet;
    vat += lineVat;
    let excludedCost = 0n;
    if (line.treatment === "materials") {
      if (scheme.base.excludesMaterials) {
        const exactCost = canonicalDecimal(line.materialsCost, 4);
        if (exactCost === null) throw new ContractorWithholdingError(
          "a subcontractor materials line needs an explicit direct materials cost",
          "Edit the bill's Direct materials cost cell using the subcontractor's supported direct cost or an estimate; enter zero when no direct cost qualifies. Include irrecoverable materials VAT in that cost for a subcontractor that is not VAT registered.",
        );
        excludedCost = toUnits(exactCost);
        if (excludedCost < 0n || excludedCost > lineNet) throw new ContractorWithholdingError(
          "direct materials cost must be nonnegative and no greater than the net materials line amount",
          "Correct the bill's Direct materials cost before paying it.",
        );
        materials += excludedCost;
      } else materials += lineNet;
    }
    base += lineNet - excludedCost + (scheme.base.excludesVat ? 0n : lineVat);
  }
  return { denominator, net, materials, vat, base };
}

/**
 * A native retainage release carries the original work mix. Cumulative direct
 * cost shares preserve the remaining cost across successive partial releases.
 * Native subcontract draw bills hold net work and have no VAT component.
 */
export function retainedBillLines(lines: readonly WithholdingBillLine[], amount: string, previousAmount: string): WithholdingBillLine[] {
  const work = lines.filter(line => !line.retainage);
  if (work.length === 0 || work.some(line => !isZero(line.vat))) throw new ContractorWithholdingError(
    "the retainage release has no supported net-work source bill",
    "Recreate the draft release from the native subcontract after correcting its source bill.",
  );
  const totals = { labour: 0n, materials: 0n, excluded: 0n };
  let cost = 0n, missingCost = false;
  for (const line of work) {
    totals[line.treatment] += toUnits(line.amount);
    if (line.treatment === "materials") {
      if (line.materialsCost == null) missingCost = true;
      else {
        const exact = canonicalDecimal(line.materialsCost, 4);
        if (exact === null || toUnits(exact) < 0n || toUnits(exact) > toUnits(line.amount)) throw new ContractorWithholdingError("the retained source bill has an invalid direct materials cost");
        cost += toUnits(exact);
      }
    }
  }
  const treatments = ["labour", "materials", "excluded"] as const;
  const weights = treatments.map(treatment => totals[treatment]);
  const denominator = weights.reduce((a, b) => a + b, 0n);
  const paid = toUnits(amount), previous = toUnits(previousAmount);
  if (paid <= 0n || previous < 0n || denominator <= 0n || weights.some(weight => weight < 0n) || previous + paid > denominator) throw new ContractorWithholdingError("the retained source bill cannot support this release amount");
  const amounts = apportion(paid, weights);
  const costShare = roundDiv((previous + paid) * cost, denominator) - roundDiv(previous * cost, denominator);
  if (costShare > amounts[1]!) throw new ContractorWithholdingError("the retainage release is too small to allocate the source direct materials cost at ledger precision");
  return treatments.flatMap((treatment, index) => amounts[index] === 0n ? [] : [{
    amount: fromUnits(amounts[index]!), vat: "0.0000", treatment, retainage: true,
    materialsCost: treatment === "materials" ? (missingCost ? null : fromUnits(costShare)) : null,
  }]);
}

function shareOf(paid: bigint, part: bigint, denominator: bigint): string {
  if (denominator === 0n || part === 0n || paid === 0n) return fromUnits(0n);
  const negative = (paid < 0n) !== (part < 0n) !== (denominator < 0n);
  const magnitude = roundDiv(
    (paid < 0n ? -paid : paid) * (part < 0n ? -part : part),
    (denominator < 0n ? -denominator : denominator) * 100n,
  );
  return fromUnits((negative ? -magnitude : magnitude) * 100n);
}

/** What a payment of `paid` carries of the bill's parts, rounded to the cent. */
export interface PaymentShare {
  paid: string;
  /** Paid amount net of VAT, from lines inside the scheme. */
  net: string;
  /** Paid share of the scheme's reportable materials amount. */
  materials: string;
  vat: string;
  /** Consideration counted toward an annual threshold: net plus VAT. */
  consideration: string;
  base: string;
}

export function paymentShare(composition: BillComposition, paid: string): PaymentShare {
  const paidUnits = toUnits(paid);
  const net = shareOf(paidUnits, composition.net, composition.denominator);
  const vat = shareOf(paidUnits, composition.vat, composition.denominator);
  return {
    paid: fromUnits(paidUnits),
    net,
    materials: shareOf(paidUnits, composition.materials, composition.denominator),
    vat,
    consideration: add(net, vat),
    base: shareOf(paidUnits, composition.base, composition.denominator),
  };
}

/** The payee's earlier position in the calendar year, from recorded deductions. */
export interface ThresholdHistory {
  /** Consideration already paid this calendar year. */
  consideration: string;
  /** Bases of this year's payments left undeducted while under the threshold. */
  pendingBase: string;
}

export interface ThresholdDecision {
  subject: boolean;
  catchUpBase: string;
  limit: string | null;
}

/** The scheme's annual limit for an enrollment basis on `date`, or null when it declares none. */
export function thresholdLimit(
  scheme: ContractorWithholdingSchemeDefinition,
  basis: string | null,
  date: string,
): string | null {
  if (!scheme.threshold) return null;
  const limit = scheme.threshold.limits.find((entry) =>
    (entry.basis ?? null) === (basis ?? null) && entry.effectiveFrom <= date && (!entry.effectiveTo || entry.effectiveTo >= date));
  if (!limit) {
    throw new ContractorWithholdingError(
      `${scheme.name} declares no exemption limit in force on ${date}${basis ? ` for basis ${basis}` : ""}`,
    );
  }
  return limit.amount;
}

export function thresholdDecision(input: {
  limit: string | null;
  history: ThresholdHistory;
  consideration: string;
  applyFromFirstPayment: boolean;
}): ThresholdDecision {
  if (input.limit === null) return { subject: true, catchUpBase: "0.0000", limit: null };
  const yearToDate = add(input.history.consideration, input.consideration);
  const subject = input.applyFromFirstPayment || cmp(yearToDate, input.limit) > 0;
  return { subject, catchUpBase: subject ? input.history.pendingBase : "0.0000", limit: input.limit };
}

/** One computed deduction, ready to post and to report. */
export interface DeductionFigures {
  bandCode: string;
  ratePercent: string;
  downgradedFrom: string | null;
  share: PaymentShare;
  belowThreshold: boolean;
  catchUpBase: string;
  /** Tax taken from this payment. */
  deducted: string;
  /** An explicitly declared outstanding liability; a statutory waiver is recorded in the reasons instead. */
  uncollected: string;
  reasons: WithholdingReason[];
}

/**
 * Compute statutory-currency figures on one payment allocation. Foreign
 * payments require an explicit stored transaction-to-statutory quote; the
 * caller freezes its native source evidence alongside the payment.
 */
export function computeDeduction(input: {
  scheme: ContractorWithholdingSchemeDefinition;
  standing: WithholdingStanding;
  paymentDate: string;
  currency: string;
  composition: BillComposition;
  paid: string;
  thresholdBasis: string | null;
  history: ThresholdHistory;
  reportingFxRate?: string;
}): DeductionFigures {
  const { scheme } = input;
  if (input.currency !== scheme.currency && input.reportingFxRate === undefined) {
    throw new ContractorWithholdingError(
      `${scheme.name} payments are reported in ${scheme.currency}; this payment is in ${input.currency}`,
      `Enter or refresh the ${input.currency} → ${scheme.currency} quote in Setup → Exchange Rates, then save the payment again.`,
    );
  }
  const decision = resolveBand(scheme, input.standing, input.paymentDate);
  if (cmp(input.paid, "0") < 0 || (input.composition.denominator <= 0n && cmp(input.paid, "0") > 0)) throw new ContractorWithholdingError("the payment needs a positive bill base");
  const transactionShare = paymentShare(input.composition, input.paid);
  const rate = input.reportingFxRate === undefined ? "1.0000000000" : withholdingCurrencyRate(input.reportingFxRate);
  if (input.currency === scheme.currency && rate !== "1.0000000000") throw new ContractorWithholdingError("Same-currency withholding must use exact par.");
  const net = withholdingStatutoryAmount(transactionShare.net, rate);
  const vat = withholdingStatutoryAmount(transactionShare.vat, rate);
  const share: PaymentShare = {
    paid: withholdingStatutoryAmount(transactionShare.paid, rate), net, vat,
    materials: withholdingStatutoryAmount(transactionShare.materials, rate),
    base: withholdingStatutoryAmount(transactionShare.base, rate), consideration: add(net, vat),
  };
  if (cmp(share.base, "0") < 0) throw new ContractorWithholdingError("the withholding base cannot be negative");
  if (scheme.threshold?.excludesVerifiedZeroRateConsideration && isZero(decision.ratePercent)) return {
    ...decision, share: { ...share, base: "0.0000" }, belowThreshold: false, catchUpBase: "0.0000", deducted: "0.0000", uncollected: "0.0000", reasons: decision.reasons,
  };
  const threshold = thresholdDecision({
    limit: thresholdLimit(scheme, input.thresholdBasis, input.paymentDate),
    history: isZero(decision.ratePercent) ? { ...input.history, pendingBase: "0" } : input.history,
    consideration: share.consideration,
    applyFromFirstPayment: input.standing.applyFromFirstPayment,
  });
  const reasons = [...decision.reasons];
  if (!threshold.subject) {
    reasons.push({
      code: "below_threshold",
      message: `The payee's consideration for the year stays within the ${threshold.limit} ${scheme.currency} limit, so nothing is deducted yet.`,
    });
    return {
      ...decision, share, reasons, belowThreshold: true, catchUpBase: "0.0000", deducted: "0.0000", uncollected: "0.0000",
    };
  }
  if (!isZero(threshold.catchUpBase)) {
    reasons.push({
      code: "threshold_crossed",
      message: `This payment takes the year past the ${threshold.limit} ${scheme.currency} limit, so the year's earlier payments are deducted now as well.`,
    });
  }
  const due = mulPercent(add(share.base, threshold.catchUpBase), decision.ratePercent, 2);
  if (cmp(due, share.paid) > 0 && !scheme.threshold?.excessCatchUpNotDue) throw new ContractorWithholdingError("The deduction exceeds the available payment; this scheme declares no excess-payment treatment.", "Use a governed statutory adjustment before settling this payment.");
  const paidUnits = toUnits(share.paid);
  const dueUnits = toUnits(due);
  const deductedUnits = dueUnits > paidUnits ? (paidUnits > 0n ? paidUnits : 0n) : dueUnits;
  const excess = fromUnits(dueUnits - deductedUnits);
  const uncollected = scheme.threshold?.excessCatchUpNotDue ? "0.0000" : excess;
  if (!isZero(excess)) {
    reasons.push({
      code: "deduction_capped",
      message: `The available consideration limits this deduction; the excess ${excess} ${scheme.currency} is not due under the scheme’s catch-up rule.`,
      amount: excess,
    });
  }
  return {
    ...decision,
    share,
    belowThreshold: false,
    catchUpBase: threshold.catchUpBase,
    deducted: fromUnits(deductedUnits),
    uncollected,
    reasons,
  };
}

/** The scheme's deduction period containing `date`, with its statutory due dates. */
export interface WithholdingPeriod {
  start: string;
  end: string;
  returnDue: string | null;
  paymentDue: string | null;
}

function dueAfter(end: string, rule: { dayOfMonth: number; monthsAfterPeriodEnd: number }): string {
  const month = addMonthsStart(end, rule.monthsAfterPeriodEnd);
  const year = Number(month.slice(0, 4));
  const month1 = Number(month.slice(5, 7));
  return civilDateFromParts(year, month1, Math.min(rule.dayOfMonth, daysInCivilMonth(year, month1)));
}

export function withholdingPeriod(scheme: ContractorWithholdingSchemeDefinition, date: string, returnFrequency: "monthly" | "quarterly" | "annual" = scheme.returnFrequency ?? "monthly"): WithholdingPeriod {
  if (!(scheme.returnFrequencies ?? [scheme.returnFrequency ?? "monthly"]).includes(returnFrequency)) throw new ContractorWithholdingError("The enrollment selects a return period that this scheme does not declare.");
  const day = parseIsoDate(date).getUTCDate();
  const monthStart = `${date.slice(0, 7)}-01`;
  const startMonth = day >= scheme.periodStartDay ? monthStart : addMonthsStart(monthStart, -1);
  const start = `${startMonth.slice(0, 8)}${String(scheme.periodStartDay).padStart(2, "0")}`;
  const nextStartMonth = addMonthsStart(startMonth, 1);
  const nextYear = Number(nextStartMonth.slice(0, 4));
  const nextMonth1 = Number(nextStartMonth.slice(5, 7));
  const end = scheme.periodStartDay === 1
    ? civilDateFromParts(Number(startMonth.slice(0, 4)), Number(startMonth.slice(5, 7)), daysInCivilMonth(Number(startMonth.slice(0, 4)), Number(startMonth.slice(5, 7))))
    : civilDateFromParts(nextYear, nextMonth1, scheme.periodStartDay - 1);
  const quarterMonth = Math.floor((Number(date.slice(5,7)) - 1) / 3) * 3 + 1;
  const year = Number(date.slice(0,4));
  const periodStart = returnFrequency === "annual" ? `${date.slice(0,4)}-01-01` : returnFrequency === "quarterly" ? civilDateFromParts(year,quarterMonth,1) : start;
  const periodEnd = returnFrequency === "annual" ? `${date.slice(0,4)}-12-31` : returnFrequency === "quarterly" ? civilDateFromParts(year,quarterMonth+2,daysInCivilMonth(year,quarterMonth+2)) : end;
  return { start: periodStart, end: periodEnd, returnDue: scheme.returnDue ? dueAfter(periodEnd, scheme.returnDue) : null, paymentDue: scheme.paymentDue ? dueAfter(periodEnd, scheme.paymentDue) : null };
}

/** A recorded deduction as a return reads it. */
export interface ReturnDeduction {
  partyId: string;
  payeeName: string;
  payeeReference: string | null;
  verificationReference: string | null;
  bandCode: string;
  paid: string;
  net: string;
  materials: string;
  vat: string;
  consideration: string;
  base: string;
  deducted: string;
  uncollected: string;
  waived?: string;
}

export interface ReturnPayeeLine {
  partyId: string;
  payeeName: string;
  payeeReference: string | null;
  verificationReference: string | null;
  bandCodes: string[];
  paid: string;
  net: string;
  materials: string;
  vat: string;
  consideration: string;
  base: string;
  deducted: string;
  uncollected: string;
  waived?: string;
}

export interface ReturnTotals {
  paid: string;
  net: string;
  materials: string;
  vat: string;
  consideration: string;
  base: string;
  deducted: string;
  uncollected: string;
  waived?: string;
}

const MONEY_FIELDS = ["paid", "net", "materials", "vat", "consideration", "base", "deducted", "uncollected", "waived"] as const;

/** Aggregate a period's deductions into one line per payee, ordered by payee name. */
export function aggregateReturn(deductions: readonly ReturnDeduction[]): { lines: ReturnPayeeLine[]; totals: ReturnTotals } {
  const byPayee = new Map<string, ReturnPayeeLine>();
  for (const deduction of deductions) {
    const line = byPayee.get(deduction.partyId) ?? {
      partyId: deduction.partyId,
      payeeName: deduction.payeeName,
      payeeReference: deduction.payeeReference,
      verificationReference: deduction.verificationReference,
      bandCodes: [],
      paid: "0.0000", net: "0.0000", materials: "0.0000", vat: "0.0000",
      consideration: "0.0000", base: "0.0000", deducted: "0.0000", uncollected: "0.0000",
    };
    for (const field of MONEY_FIELDS) line[field] = add(line[field] ?? "0", deduction[field] ?? "0");
    if (!line.bandCodes.includes(deduction.bandCode)) line.bandCodes.push(deduction.bandCode);
    line.verificationReference = deduction.verificationReference ?? line.verificationReference;
    line.payeeReference = deduction.payeeReference ?? line.payeeReference;
    byPayee.set(deduction.partyId, line);
  }
  const lines = [...byPayee.values()].sort((a, b) => a.payeeName.localeCompare(b.payeeName) || a.partyId.localeCompare(b.partyId));
  const totals = Object.fromEntries(MONEY_FIELDS.map((field) => [field, "0.0000"])) as unknown as ReturnTotals;
  for (const line of lines) for (const field of MONEY_FIELDS) totals[field] = add(totals[field] ?? "0", line[field] ?? "0");
  return { lines, totals };
}
