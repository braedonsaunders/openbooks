/**
 * Revenu Québec TP-1015.F-V source deductions of Québec income tax — the
 * regular-payments method (s. 2.1.1) plus Method 2 for gratuities, retroactive
 * pay and similar lump-sum payments (s. 2.1.2).
 *
 * Source: TP-1015.F-V (2026-01), "Formulas to Calculate Source Deductions and
 * Contributions", fetched from revenuquebec.ca — every formula below is a
 * transcription with its section cited, never a reconstruction.
 *
 * The guide's variables, kept by their own names:
 *   P   pay periods in the year
 *   G   gross remuneration subject to source deductions for the period
 *       (excludes gratuities/retroactive pay); D = gross salary or wages,
 *       identical to G for salary/wage remuneration
 *   B1  lump sums paid earlier in the year;  B2  lump sums paid this period
 *   F   period RPP/RRSP/VRSP/PRPP/FHSA/CIP-type deductions (s. 2.1.1 Step 1's
 *       factor-F list; note Québec's F has NO alimony term and NO union-dues
 *       term — both are T4127 concepts with no TP-1015 analog)
 *   H   deduction for workers: (0.06 × D) capped at $1,450 ÷ P
 *   C   employee QPP contribution for the period (base + first additional)
 *   C2  second additional QPP contribution for the period
 *   S3  QPP pensionable salary or wages for the period, INCLUDING lump sums
 *   CS  deduction of additional QPP contributions: C × (0.01 ÷ 0.0630) + C2
 *   CSA CS attributed to the periodic pay:  CS × ((S3 − B2) ÷ S3)
 *   CSB CS attributed to this period's lump sums:  CS × (B2 ÷ S3)
 *   CSB1 the year's prior CSB amounts
 *   J   annual deductions from TP-1015.3-V line 19;  J1 annual deductions
 *       Revenu Québec authorized on TP-1016-V (both subtract identically)
 *   K   the bracket constant;  K1 annual non-refundable credits authorized
 *       on TP-1016-V
 *   E   personal tax credit value from TP-1015.3-V (E1 indexed + E2 not),
 *       rounded to the nearest dollar, halves up
 *   Q   period withholding for Fonds de solidarité FTQ class-A shares
 *   Q1  period withholding for Fondaction class-A/B shares
 *   L   additional source deduction requested (TP-1015.3-V / TP-1017-V)
 *   I   annual taxable income;  Y  income tax for the year;
 *   A   income tax to withhold for the period
 *
 * Rounding discipline: like the T4127 engine, every multiplication rounds
 * half-up straight to the cent as its parenthesis resolves, rate ratios are
 * never rounded, and division by P rounds to the cent. This reproduces the
 * guide's own Appendix 1/2 arithmetic penny for penny (see tp1015.test.ts,
 * including the one documented appendix artifact).
 *
 * QPP and QPIP are NOT computed here: TP-1015.F-V ss. 3.1/4.1 are the same
 * formulas, constants and rounding notes as the T4127 engine's QPP/QPIP arm
 * (asserted against the guide's Appendix 3 in tp1015.test.ts), so C, C2 and
 * S3 arrive as inputs from that engine — one QPP implementation, not two.
 *
 * Out of scope, refused rather than approximated (documented, not forgotten):
 * s. 2.1.2 Method 1 (needs accrued G1/F1/H1/CSA1 the pipeline does not carry;
 * Method 2 is the guide's own sanctioned alternative and its Appendix 2
 * example), s. 2.2 cumulative averaging (commissions), and the s. 5 health
 * services fund employer contribution.
 */
import {
  bmin, D, divIntCents, max0, mulInt, mulRateCents, mulRatioCents, rate6, U,
} from "../decimal.ts";
import { roundDiv } from "../../../money.ts";
import { qcRatesForPayDate, type QcEditionRates, type QcTaxBracket } from "./rates.ts";

export interface Tp1015Ytd {
  /** B1 — gratuities/retroactive pay paid since the start of the year. */
  nonPeriodic?: string;
  /** Factor-F amounts already taken against B1 (reduces B1, s. 2.1.2 NOTE). */
  nonPeriodicPensionDeductions?: string;
  /** CSB1 — the CSB amounts of the year's earlier lump-sum payments. */
  csb?: string;
}

export interface Tp1015Input {
  /** Selects the TP-1015.F-V edition; throws for an untranscribed year. */
  payDate: string;
  /** P — pay periods in the year. */
  periodsPerYear: number;
  /** G (= D) — gross periodic remuneration, EXCLUDING lump sums. */
  income: string;
  /** B2 — gratuity / retroactive pay / similar lump sum paid this period. */
  nonPeriodic?: string;
  /** F — the period's factor-F deductions taken from the periodic pay. */
  pensionDeductions?: string;
  /** Factor-F amounts taken from the lump sum itself (reduces B2). */
  nonPeriodicPensionDeductions?: string;
  /** C — employee QPP contribution this period (from the QPP engine). */
  qpp: string;
  /** C2 — second additional QPP contribution this period. */
  qpp2?: string;
  /** S3 — QPP pensionable salary/wages this period, lump sums included.
   *  Defaults to income + nonPeriodic. */
  pensionable?: string;
  /** E — TP-1015.3-V personal tax credits (line 7 + line 9). Omit to use the
   *  guide's default for an employee with no form on file: the basic personal
   *  amount (s. 2.1.1 Step 2, variable E1). */
  personalCredits?: string;
  /** J — TP-1015.3-V line 19 annual deductions. */
  annualDeductions?: string;
  /** J1 — annual deductions authorized on TP-1016-V. */
  authorizedAnnualDeductions?: string;
  /** K1 — annual non-refundable credits authorized on TP-1016-V. */
  authorizedAnnualCredits?: string;
  /** Q — period withholding for Fonds de solidarité FTQ class-A shares. */
  ftqSharesPerPeriod?: string;
  /** Q1 — period withholding for Fondaction class-A/B shares. */
  fondactionSharesPerPeriod?: string;
  /** L — additional per-period income tax requested by the employee. */
  additionalTaxPerPeriod?: string;
  /** TP-1015.3-V exemption from source deductions of income tax (s. 2.1):
   *  "Do not withhold income tax" — the whole result is zero. */
  taxExempt?: boolean;
  ytd?: Tp1015Ytd;
}

export interface Tp1015Result {
  /** The TP-1015.F-V version the calculation used ("2026-01"). */
  version: string;
  /** A — income tax to withhold on the periodic remuneration (includes L). */
  periodicTax: string;
  /** Income tax to withhold on this period's lump sum (s. 2.1.2 Method 2). */
  bonusTax: string;
  /** periodicTax + bonusTax. */
  totalTax: string;
  /** Every intermediate variable, QC_-prefixed so the stub's factors jsonb
   *  can hold them beside the T4127 factors without a key collision. */
  factors: Record<string, string>;
}

const ZERO = 0n;

function opt(value: string | undefined): bigint {
  return value === undefined || value === "" ? ZERO : U(value);
}

/** E is rounded "to the nearest multiple of 1"; halves round up (Step 2). */
function roundDollar(units: bigint): bigint {
  return roundDiv(units, 10_000n) * 10_000n;
}

function bracketFor(brackets: QcTaxBracket[], annual: bigint): QcTaxBracket {
  for (const bracket of brackets) {
    if (bracket.upTo === null || annual <= U(bracket.upTo)) return bracket;
  }
  return brackets[brackets.length - 1]!;
}

export function calculateTp1015(input: Tp1015Input): Tp1015Result {
  const rates: QcEditionRates = qcRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year: ${P}`);
  }

  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[`QC_${key}`] = D(value); };

  const G = U(input.income);
  const B2 = opt(input.nonPeriodic);
  const F = opt(input.pensionDeductions);
  const F3 = opt(input.nonPeriodicPensionDeductions);
  const C = U(input.qpp);
  const C2 = opt(input.qpp2);
  const S3 = input.pensionable === undefined ? G + B2 : U(input.pensionable);
  const ytd = input.ytd ?? {};
  const B1 = opt(ytd.nonPeriodic);
  const F4 = opt(ytd.nonPeriodicPensionDeductions);
  const CSB1 = opt(ytd.csb);

  // ---- H — deduction for workers (s. 2.1.1 Step 1) -------------------------
  // H = (0.06 × D), up to a maximum of $1,450 ÷ P. D is the gross salary or
  // wages EXCLUDING lump sums, i.e. G here. The cap divides to the cent
  // half-up: the guide's own examples print $1,450 ÷ 26 = 55.77 (Appendix 1)
  // and $1,450 ÷ 52 = 27.88 (Appendix 2).
  const H = bmin(
    mulRateCents(G, rates.workersDeductionRate),
    divIntCents(U(rates.workersDeductionMax), P),
  );
  trace("H", H);

  // ---- CS / CSA / CSB — additional-QPP deduction (s. 2.1.1 Step 1) ---------
  // CS  = C × (0.01 ÷ 0.0630) + C2, the ratio unrounded, the product rounded
  //       to the cent (C2 is already a cent amount).
  // CSA = CS × ((S3 − B2) ÷ S3) — the share attributed to periodic pay.
  // CSB = CS × (B2 ÷ S3)       — the share attributed to this period's lump
  //       sums (s. 2.1.2). Computed independently, exactly as the guide does
  //       (Appendix 2: CS = 54.33 splits 14.82 / 39.51, which do not sum to
  //       54.33 — each parenthesis rounds on its own).
  const CS = mulRatioCents(
    C, rate6(rates.qppFirstAdditionalRate), rate6(rates.qppTotalRate),
  ) + C2;
  const CSA = B2 > ZERO && S3 > ZERO ? mulRatioCents(CS, max0(S3 - B2), S3) : CS;
  const CSB = B2 > ZERO && S3 > ZERO ? mulRatioCents(CS, bmin(B2, S3), S3) : ZERO;
  trace("CS", CS); trace("CSA", CSA); trace("CSB", CSB);

  // ---- E — personal tax credits (s. 2.1.1 Step 2) --------------------------
  // "If the result is not a multiple of 1, round it to the nearest multiple
  // of 1. If the result is halfway between two multiples of 1, round it up."
  // Default when no TP-1015.3-V is on file: the basic personal amount.
  const E = roundDollar(
    input.personalCredits === undefined
      ? U(rates.basicPersonalAmount)
      : U(input.personalCredits),
  );
  trace("E", E);

  const J = opt(input.annualDeductions);
  const J1 = opt(input.authorizedAnnualDeductions);
  const K1 = opt(input.authorizedAnnualCredits);
  const Q = opt(input.ftqSharesPerPeriod);
  const Q1 = opt(input.fondactionSharesPerPeriod);
  const L = opt(input.additionalTaxPerPeriod);

  // The lump sums enter annual income net of the factor-F amounts taken from
  // them (s. 2.1.2 Step 1 NOTE: "you must reduce variables B1 and B2
  // accordingly"). CSB itself is computed on the gross B2 (Appendix 2).
  const B1n = max0(B1 - F4);
  const B2n = max0(B2 - F3);

  // ---- Y at an annual taxable income (s. 2.1.1 Step 2) ---------------------
  // Y = (T × I) − K − K1 − (0.14 × E) − (0.15 × P × Q) − (0.15 × P × Q1),
  // floor 0. Each parenthesis rounds to the cent as it resolves; P × Q is
  // exact, so the credit is one rounded multiplication (Appendix 1:
  // 0.15 × 26 × $100 = $390.00).
  const annualTax = (I: bigint): { y: bigint; t: string; k: string } => {
    const bracket = bracketFor(rates.brackets, I);
    const y = max0(
      mulRateCents(I, bracket.rate)
      - U(bracket.k)
      - K1
      - mulRateCents(E, rates.creditRate)
      - mulRateCents(mulInt(Q, P), rates.labourFundsCreditRate)
      - mulRateCents(mulInt(Q1, P), rates.labourFundsCreditRate),
    );
    return { y, t: bracket.rate, k: bracket.k };
  };

  // ---- Periodic tax (s. 2.1.1) ---------------------------------------------
  // Step 1: I = P × (G − F − H − CSA) − J − J1, floor 0. Unlike T4127's
  // step-2 annual income, the guide's periodic I carries NO lump-sum terms at
  // all — Method 2 accounts for them only in the lump-sum tax itself.
  // Step 3: A = (Y ÷ P) + L, floor 0.
  const I = max0(mulInt(G - F - H - CSA, P) - J - J1);
  trace("I", I);
  let periodicTax = ZERO;
  if (!input.taxExempt) {
    const { y } = annualTax(I);
    trace("Y", y);
    periodicTax = max0(divIntCents(y, P) + L);
  } else {
    trace("Y", ZERO);
  }
  trace("A", periodicTax);

  // ---- Lump-sum tax (s. 2.1.2 Method 2) ------------------------------------
  let bonusTax = ZERO;
  if (B2 > ZERO && !input.taxExempt) {
    // NOTE before Method 1/2: at or below the threshold, withhold flat 7%
    // "from the lump-sum payment". The comparison total is the annual salary
    // or wages plus the year's lump sums, estimated as P × G + B1 + B2.
    const annualEstimate = mulInt(G, P) + B1 + B2;
    if (annualEstimate <= U(rates.lumpSumThreshold)) {
      bonusTax = mulRateCents(B2, rates.lumpSumRate);
    } else {
      // Step 1: I = [P × (G − F − H − CSA)] + B1 + B2 − CSB1 − CSB − J − J1
      // (B1/B2 already net of their factor-F amounts), floor 0.
      // Step 2: A = T × (B2 − CSB), T taken from the bracket of that I.
      const I2 = max0(
        mulInt(G - F - H - CSA, P) + B1n + B2n - CSB1 - CSB - J - J1,
      );
      trace("I2", I2);
      const bracket = bracketFor(rates.brackets, I2);
      bonusTax = max0(mulRateCents(max0(B2n - CSB), bracket.rate));
    }
  }
  trace("AB", bonusTax);

  return {
    version: rates.version,
    periodicTax: D(periodicTax),
    bonusTax: D(bonusTax),
    totalTax: D(periodicTax + bonusTax),
    factors,
  };
}
