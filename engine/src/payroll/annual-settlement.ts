import { cmp } from "../money/money.ts";
import { PayrollPackError } from "./payroll-error.ts";
import type { PayrollCountryPack, PayrollTaxYearDefinition } from "./packs.ts";
import type {
  PayrollStatutoryComputeContext,
  PushStatutoryFn,
} from "./statutory-context.ts";

/**
 * Annual settlement — the pack-declared year-end recomputation and its
 * settlement in the final pay of the tax year.
 *
 * Three jurisdictions need this one capability in three shapes, so the
 * declaration carries the union, and the generic layer branches on nothing:
 *
 * - JP 年末調整 posts one extra line on the December run: a refund or a
 *   collection of the difference between the annual liability (年調年税額)
 *   and what the monthly 月額表 actually withheld.
 * - IT `art. 23 DPR 600/1973` conguaglio is a no-op inside the pack's
 *   modelled scope (full-year level pay): the capability must be able to be
 *   declared and legitimately compute a ZERO difference, not just refuse or
 *   adjust. Its addizionali ride tenant-declared rates, so the settlement
 *   must tolerate a component whose rate is configuration, not
 *   transcription.
 * - DE Dezember-PAP is not one extra line but a DIFFERENT ALGORITHM for the
 *   final period (year-to-date Nachholung: two MBERECH passes plus
 *   MLST1224), differing by year — so the settlement resolves PER EDITION,
 *   not per country.
 *
 * Packs declare; the generic run layer runs. No `country === …` anywhere
 * outside a pack directory: the only pack this module ever touches is the
 * one handed to it.
 *
 * THE MONEY RULE, stated once so three packs inherit it instead of each
 * rediscovering it. A settlement that pays the employee (a refund) posts a
 * `credit` line; one that collects posts a `deduction` line; a zero
 * difference posts nothing. Amounts are always positive — direction rides
 * the kind, never the sign. This is not style:
 *
 * - Net math is `gross − deductions + credits` (run-stub-compute.ts), so a
 *   credit increases the stub net the bank file pays (bank-file.ts pays
 *   committed stub nets under a control total that sums them). A refund
 *   therefore flows onto the bank file exactly like Italy's trattamento
 *   integrativo already does — no new rail, no control-total special case.
 * - The remittance summary negates credit slices against the same
 *   destination's withholdings (remittance.ts: the payable is withholdings
 *   minus credits), so the liability ties to the reduced remittance and the
 *   employer's reclaim is the difference — the F24-compensation shape, not
 *   a second mechanism.
 * - Posting follows the existing commit legs (run-commit.ts): credits post
 *   against the liability the deductions credited, so the double-entry
 *   balances and the run still balances.
 * - `pushStatutory` passes negative amounts through unchecked
 *   (push-statutory.ts has no sign check), and the net arithmetic would
 *   silently absorb one — so the settlement push below REFUSES a negative
 *   amount by name rather than letting a sign error read as money moved.
 */

/** The two settlement shapes the union requires. */
export type AnnualSettlementMode =
  /** One extra line on an otherwise normal final run (JP, IT). */
  | "adjustment_line"
  /** The final period is priced by a different program, not the monthly engine (DE). */
  | "final_period_recomputation";

/**
 * What the generic layer resolves before invoking a settlement: committed
 * history for the tax year, canonical money strings (money.ts numeric(19,4)).
 *
 * Room is consumed from COMMITTED stubs only — the same doctrine as the
 * employer-aggregate channel: abandoning a draft must never burn annual
 * room, and the current run's own monthly pass is already committed-or-not
 * by the time the settlement reads it back.
 */
export interface AnnualSettlementPriors {
  /** Committed taxable gross for the employee's tax year, current run included once calculated. */
  ytdGross: string;
  /** Committed withheld sums by withholding systemKey (e.g. `income_tax`), current run included. */
  ytdWithheldBySystemKey: Readonly<Record<string, string>>;
}

/**
 * The context a settlement computes in: the statutory context minus the
 * monthly-only assumptions, plus the year's priors. The money contract on
 * every amount is the one documented on `PayrollStatutoryComputeContext`
 * (canonical numeric(19,4); parse with money.ts).
 */
export type PayrollAnnualSettlementContext = Pick<
  PayrollStatutoryComputeContext,
  | "tx"
  | "orgId"
  | "documentId"
  | "employeePartyId"
  | "employeeName"
  | "taxYear"
  | "country"
  | "region"
  | "run"
  | "emp"
  | "filingAccountId"
  | "periodsPerYear"
  | "storedCertificates"
  | "certificateFor"
  | "bool"
  | "assertRegionSupported"
  | "employerLevies"
> & {
  /** ISO pay date of the final run being settled. */
  payDate: string;
  /** The tax year's committed priors (see above). */
  priors: AnnualSettlementPriors;
  /**
   * The settlement push: `pushStatutory` wrapped to refuse negative amounts
   * by name (see the money rule above). Direction rides the kind.
   */
  pushSettlement: PushStatutoryFn;
};

/**
 * One tax year's settlement edition, returned by the pack's
 * `annualSettlement` closure for a transcribed year, or null for a year
 * with no settlement (untranscribed years, pre-wiring) — absent means the
 * generic layer runs nothing and the monthly path is untouched.
 */
export interface PayrollAnnualSettlement {
  /** The agency's own name for the settlement (年末調整, conguaglio, …). */
  label: string;
  /** NTA document and section (or the pack's equivalent) per figure and rule. */
  citation: string;
  mode: AnnualSettlementMode;
  /**
   * Keys into the pack's `employeeFacts` the settlement reads. A fact the
   * employee has not declared makes the settlement REFUSE by name for that
   * employee — an assumed zero is a silently wrong refund.
   */
  requiredEmployeeFacts: readonly string[];
  /**
   * Keys into the pack's `certificates` the settlement reads (the autumn
   * declarations for JP). Same refusal doctrine as the facts.
   */
  requiredCertificates: readonly string[];
  /**
   * Tenant-declared rate-slot keys the settlement prices through (JP
   * `jp_health_rate`, IT `it_addizionale_regionale` /
   * `it_addizionale_comunale`). Configuration, never transcription — and a
   * missing one refuses at the rate channel, never defaults.
   */
  usesTenantRates: readonly string[];
  /**
   * The withholding systemKey the difference settles against
   * (`income_tax` for JP gensen). Must name a systemKey the pack's
   * statutory slots declare — settling against a key no slot owns would
   * post onto a component the remittance cannot see.
   */
  settlementSystemKey: string;
  /**
   * Price the settlement and push its lines through `ctx.pushSettlement`.
   * Returns trace factors for the stub (the pack's `factorLabels` names
   * them, like the monthly pass). A zero difference pushes nothing and
   * returns its factors — the legitimate IT no-op.
   */
  compute: (
    ctx: PayrollAnnualSettlementContext,
  ) => Promise<Record<string, string>>;
}

/**
 * The pack-side declaration: per-edition resolution (DE's algorithm differs
 * by year), LAZY like `employerAggregateLevies` / `openingYtdFields`.
 * OPTIONAL on the pack: absent means the pack settles nothing and the
 * generic layer never calls.
 */
export type AnnualSettlementDeclaration = (
  taxYear: number,
) => PayrollAnnualSettlement | null;

function fail(message: string): never {
  throw new PayrollPackError(`annual settlement: ${message}`);
}

/**
 * Whether a pay date is the FINAL period of the pack's tax year on a
 * monthly payroll — the country-neutral gate for invoking a settlement.
 * Derived from the pack's own `taxYear` definition (calendar closes in
 * December; a fiscal year closes the month before it opens), so HMRC/ATO-style
 * years need no new code.
 */
export function isFinalPeriodOfTaxYear(
  taxYear: PayrollTaxYearDefinition,
  periodsPerYear: number,
  payDateISO: string,
): boolean {
  if (periodsPerYear !== 12) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(payDateISO);
  if (!match) {
    fail(`pay date "${payDateISO}" is not an ISO date — cannot tell the final period`);
  }
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    fail(`pay date "${payDateISO}" is not an ISO date — cannot tell the final period`);
  }
  const closingMonth = taxYear.basis === "calendar" ? 12 : ((taxYear.startMonth + 10) % 12) + 1;
  return month === closingMonth;
}

/**
 * The settlement push: the pack's `pushStatutory` refusing negative amounts
 * by name. `pushStatutory` passes negatives through unchecked and the net
 * arithmetic would silently absorb one, so a sign error here is a refusal,
 * never money moved.
 */
export function createSettlementPush(pushStatutory: PushStatutoryFn): PushStatutoryFn {
  return (systemKey, kind, description, amount, sequence, options) => {
    if (cmp(amount, "0") < 0) {
      fail(
        `settlement amount ${amount} for "${description}" is negative: direction rides the kind `
        + `(a refund posts a positive "credit", a collection a positive "deduction"), never the sign`,
      );
    }
    pushStatutory(systemKey, kind, description, amount, sequence, options);
  };
}

/**
 * Which of a settlement edition's declared inputs are missing for one
 * employee: required employee facts with no value, required certificates
 * with no resolution. The pack composes these into the per-employee refusal
 * (naming the employee, the missing input, and the declaration to file).
 * Country-neutral: keys only, never their meaning.
 */
export function missingSettlementInputs(
  settlement: PayrollAnnualSettlement,
  input: {
    emp: Record<string, string | null>;
    certificateFor: (key: string) => unknown;
  },
): string[] {
  const missing: string[] = [];
  for (const key of settlement.requiredEmployeeFacts) {
    const value = input.emp[key];
    if (value == null || value === "") missing.push(`employee fact ${key}`);
  }
  for (const key of settlement.requiredCertificates) {
    if (input.certificateFor(key) == null) missing.push(`certificate ${key}`);
  }
  return missing;
}

/**
 * Resolve a pack's settlement edition for a tax year: absent declaration or
 * a null edition both mean "settle nothing" (the monthly path untouched),
 * while an edition settling against an undeclared systemKey is refused at
 * wiring time — before any employee's pay is touched.
 */
export function resolveAnnualSettlement(
  pack: Partial<Pick<PayrollCountryPack, "statutorySlots">> & {
    annualSettlement?: AnnualSettlementDeclaration;
  },
  taxYear: number,
): PayrollAnnualSettlement | null {
  const edition = pack.annualSettlement?.(taxYear) ?? null;
  if (edition === null) return null;
  const owned = (pack.statutorySlots ?? []).some((slot) =>
    slot.components.some((component) => component.systemKey === edition.settlementSystemKey),
  );
  if (!owned) {
    fail(
      `settlement "${edition.label}" settles against systemKey "${edition.settlementSystemKey}", `
      + "which no statutory slot declares — the remittance could not see the line",
    );
  }
  return edition;
}