import { canonicalNonNegativeDecimal } from "../../money/exact-decimal.ts";
/**
 * CRA T4127 payroll deductions engine — Option 1 (periodic method), Option 2
 * cumulative averaging, plus the bonus /
 * retroactive (non-periodic) method.
 *
 * Faithful to the guide's factor notation (A, C, C2, EI, F5, K1..K4, T1..T4,
 * V1, V2, S, TB…) and its rounding rule: the guide rounds the deductions
 * themselves (CPP, EI, the per-period tax) half-up to the cent and nothing
 * in between, except personal amounts that the guide explicitly rounds.
 * Income and annual credits retain exact rational precision; printed factors
 * are display amounts, never inputs to later formula steps. Rate ratios are
 * never rounded; the CPP per-period exemption truncates. Arithmetic uses
 * bounded bigint ratios and rounds only at declared statutory boundaries.
 *
 * Methods outside this calculator: TD1X commission employees, mid-year province-transfer credit
 * variants (K2R/K2RQ), and Quebec *provincial* income tax (TP-1015, which
 * Revenu Québec administers — QPP/QPIP and the federal abatement side of
 * Quebec employment ARE implemented).
 */
import { PayrollError } from "../error.ts";
import type { Money } from "../../money/brands.ts";
import {
  bmax, bmin, D, max0, mulInt, mulRatioCents, mulRateCents, rate6, truncCents, U,
} from "../../money/payroll-decimal.ts";
import { rational as Q, addRational as qa, subtractRational as qs, multiplyRational, compareRational as qc, roundRational, type Rational } from "../../money/rational.ts";
import {
  claimCodeAmount, CPP_EXEMPTION_BY_P, EditionRates, PensionPlanRates, Province, ratesForPayDate,
} from "./rates";

export interface T4127Ytd {
  /** D — CPP/QPP contributions (C, excludes C2) with this employer. */
  cpp?: string;
  /** D2 — second-additional CPP/QPP contributions with this employer. */
  cpp2?: string;
  /** D1 — EI premiums with this employer. */
  ei?: string;
  /** QPIP premiums with this employer (Quebec). */
  qpip?: string;
  /** Employer QPIP premiums with this employer (Quebec). */
  qpipEmployer?: string;
  /** PIYTD — pensionable earnings before this period (drives CPP2's W). */
  pensionable?: string;
  /** Prior YTD non-periodic payments B1 (bonuses, retro). */
  nonPeriodic?: string;
  /** F4 — RPP/RRSP/union dues deducted from those YTD non-periodic payments. */
  nonPeriodicPensionDeductions?: string;
  /** F5B applied against YTD non-periodic payments. */
  nonPeriodicCppEnhancedDeductions?: string;
}

/** Prior committed inputs in the elected averaging window. Contribution
 * ceilings remain calendar-year inputs in ytd and are never reset here. */
export interface T4127Averaging {
  elapsedPeriods:number
  income:string
  pensionDeductions:string
  alimonyDeductions:string
  unionDues:string
  f5A:string
  pensionablePeriodic:string
  insurablePeriodic:string
  qpipPeriodic:string
  pensionableNonPeriodic:string
  insurableNonPeriodic:string
  qpipNonPeriodic:string
  periodicTax:string
  bonusTax:string
}

export interface T4127Input {
  /** Pay date — selects the edition (122nd Jan–Jun 2026, 123rd Jul–Dec). */
  payDate: string;
  /** Province of employment; "ZZ" = outside Canada / beyond any province. */
  province: Province;
  /** P — pay periods in the year (52/53, 26/27, 24, 12, …). */
  periodsPerYear: number;
  /** PM — months requiring CPP contributions (proration for turning 18/70, CPT30). Default 12. */
  cppMonths?: number;

  /** I — gross taxable periodic remuneration for this period (excludes the bonus). */
  income: string;
  /** B — non-periodic payment this period (bonus, retro, unused-vacation payout). */
  nonPeriodic?: string;
  /** PI — pensionable income this period. Defaults to income + nonPeriodic. */
  pensionable?: string;
  /** IE — insurable earnings this period. Defaults to income + nonPeriodic. */
  insurable?: string;
  /**
   * The QPIP program's own insurable base this period (the pack's declared
   * contribution program, accumulated per stub). Absent (undefined) only on
   * unit-constructed inputs, where it reads the EI leg (legacy math,
   * bit-identical); the engine always provides it. QPIP premiums price off
   * this base, never EI's: EI-excluded earnings can be QPIP-insurable and
   * the reverse.
   */
  qpipInsurable?: string;

  /** F — period RPP/RRSP/PRPP/RCA deductions (from periodic pay). */
  pensionDeductions?: string;
  /** F2 — pre-May-1997 alimony/maintenance deducted at source. */
  alimonyDeductions?: string;
  /** F3 — RPP/RRSP deducted from the non-periodic payment itself. */
  nonPeriodicPensionDeductions?: string;
  /** U1 — union dues for the period. */
  unionDues?: string;
  /** HD — annual prescribed-zone deduction (TD1). */
  prescribedZoneDeduction?: string;
  /** F1 — annual deductions authorized by a tax services office. */
  authorizedAnnualDeductions?: string;
  /** K3 — annual federal non-refundable credits authorized by a TSO. */
  authorizedFederalCredits?: string;
  /** K3P — provincial analogue of K3. */
  authorizedProvincialCredits?: string;
  /** L — additional tax per period requested on TD1. */
  additionalTaxPerPeriod?: string;
  /** LCF — per-period federal labour-sponsored funds credit (pre-capped basis). */
  labourFundsCreditFederal?: string;
  /** LCP — provincial analogue. */
  labourFundsCreditProvincial?: string;
  /**
   * Employer EI multiple for this employee's payroll program account: 1.4
   * unless a CRA-approved reduced rate (wage-loss plan) applies. Entered as
   * a decimal with up to 4 places, validated 1.0000–1.4000. Absent prices
   * the statutory 1.4.
   */
  eiEmployerMultiple?: string;

  /** TC — federal TD1 total claim. Omit to use the BPAF formula default. */
  federalClaim?: string;
  /** TCP — provincial TD1 total claim. Omit to use the jurisdiction default. */
  provincialClaim?: string;
  /** TD1 claim code shorthand (0–10); ignored when the amount is given. */
  federalClaimCode?: number;
  provincialClaimCode?: number;
  /** Claim code E / letter from CRA: no income tax (statutory still applies). */
  taxExempt?: boolean;

  cppExempt?: boolean;
  eiExempt?: boolean;
  /** Ontario tax-reduction dependant counts (factor Y). */
  disabledDependants?: number;
  dependantsUnder19?: number;
  /**
   * K2 basis. "annualized" is the guide's base formula (P × C), with the
   * stated max-reached override. "ytd" is the guide's optional YTD method —
   * more accurate for uneven pay; both are CRA-sanctioned.
   */
  k2Method?: "annualized" | "ytd";
  /** PR — pay periods remaining including this one (YTD K2 method). Default P. */
  periodsRemaining?: number;

  /** An explicit election enables Option 2; absent preserves Option 1. */
  averaging?:T4127Averaging;
  pensionableNonPeriodic?:string;
  insurableNonPeriodic?:string;
  qpipNonPeriodic?:string;
  /**
   * CPP/EI/QPIP actually withheld on THIS run, for the K2 credits and the F5
   * deduction. A supplemental-period share prices contributions on the
   * period-to-date base but taxes each run as its own periodic pay, so the
   * credits price off this run's withheld share rather than the period
   * total. Absent, each reads the computed amount and every formula below
   * is byte-identical to the guide path.
   */
  cppWithheld?: string;
  cpp2Withheld?: string;
  eiWithheld?: string;
  qpipWithheld?: string;
  ytd?: T4127Ytd;
}

export interface T4127Result {
  edition: number;
  // Every money leg below is a D() (fromUnits-fixed) output: canonical Money.
  /** C — CPP/QPP employee contribution this period (base + first additional). */
  cpp: Money;
  /** C2 — second-additional CPP/QPP this period. */
  cpp2: Money;
  /** Employer CPP/QPP (match of C + C2). */
  cppEmployer: Money;
  /** EI employee premium this period. */
  ei: Money;
  /** EI employer premium (employee × multiple). */
  eiEmployer: Money;
  /** QPIP employee / employer premiums (Quebec only, else "0.0000"). */
  qpip: Money;
  qpipEmployer: Money;
  /** F5 and its periodic / non-periodic split. */
  f5: Money;
  f5A: Money;
  f5B: Money;
  /** T — tax on the periodic remuneration for this period (includes L). */
  periodicTax: Money;
  /** TB — tax payable now on the non-periodic payment. */
  bonusTax: Money;
  /** periodicTax + bonusTax. */
  totalTax: Money;
  /** Every intermediate factor, for the explainability trace. */
  factors: Record<string, Money>;
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the trace
 * keys above (including the annualTax parts). Every letter is the CRA T4127
 * guide's own factor notation — see the module header.
 */
export const T4127_FACTOR_LABELS: Readonly<Record<string, string>> = {
  S1_NUM: "Averaging projection periods",
  S1_DEN: "Elapsed scheduled periods in the averaging window",
  M: "Periodic tax already withheld, excluding additional tax",
  M1: "Bonus tax already withheld",
  L: "Additional tax requested this pay",
  A: "Annual taxable income",
  A_step2: "Annual taxable income excluding this bonus",
  C: "CPP/QPP contribution",
  C2: "Second additional CPP/QPP (CPP2)",
  EI: "EI premium",
  QPIP: "QPIP premium",
  F5: "Enhanced-CPP tax deduction",
  F5A: "Enhanced-CPP deduction on periodic pay",
  F5B: "Enhanced-CPP deduction on the bonus",
  TC: "Federal TD1 claim amount",
  TCP: "Provincial TD1 claim amount",
  K1: "Federal personal credit",
  K2: "Federal CPP/EI credit",
  K4: "Canada employment amount credit",
  K1P: "Provincial personal credit",
  K2P: "Provincial CPP/EI credit",
  K4P: "Provincial employment amount credit",
  K5P: "Provincial supplemental credit",
  T3: "Basic federal tax (annual)",
  T1: "Federal tax (annual)",
  T4: "Basic provincial tax (annual)",
  V1: "Ontario surtax",
  V2: "Ontario Health Premium",
  S: "Provincial tax reduction",
  T2: "Provincial tax (annual)",
  T: "Income tax this period",
  TB: "Tax on the bonus (payable now)",
  TF: "Federal tax this period",
  TP: "Provincial tax this period",
};

const ZERO = 0n;

function opt(value: string | undefined): bigint {
  return value === undefined || value === "" ? ZERO : U(value);
}

const QZERO = Q(0n);
const qmin = (a: Rational, b: Rational): Rational => qc(a, b) < 0 ? a : b;
const qmax = (a: Rational, b: Rational): Rational => qc(a, b) > 0 ? a : b;
const qmax0 = (value: Rational): Rational => qmax(value, QZERO);
const qsum = (...values: Rational[]): Rational => values.reduce(qa, QZERO);
const qratio = (value: Rational, numerator: bigint, denominator: bigint): Rational => {
  if (denominator <= 0n) throw new PayrollError("ratio denominator must be greater than zero");
  return multiplyRational(value, Q(numerator, denominator));
};
const qrate = (value: Rational, rate: string): Rational => qratio(value, rate6(rate), 1_000_000n);
const qint = (value: Rational, count: number): Rational => Q(mulInt(value.numerator, count), value.denominator);

function bracketFor(brackets: { upTo: string | null; rate: string; k: string }[], annual: Rational) {
  for (const bracket of brackets) {
    if (bracket.upTo === null || qc(annual, Q(U(bracket.upTo))) <= 0) return bracket;
  }
  return brackets[brackets.length - 1]!;
}

function bpaPhaseOut(
  netIncome: Rational,
  phase: { max: string; min: string; phaseStart: string; phaseEnd: string; slopeNum: string; slopeDen: string },
): Rational {
  if (qc(netIncome, Q(U(phase.phaseStart))) <= 0) return Q(U(phase.max));
  if (qc(netIncome, Q(U(phase.phaseEnd))) >= 0) return Q(U(phase.min));
  const reduction = qratio(qs(netIncome, Q(U(phase.phaseStart))), BigInt(phase.slopeNum), BigInt(phase.slopeDen));
  // T4127 explicitly rounds the resulting personal amount to the cent.
  return Q(roundRational(qs(Q(U(phase.max)), reduction), 100n));
}

function bpamb(netIncome: Rational): Rational {
  const cap = Q(U("15780"));
  if (qc(netIncome, Q(U("200000"))) <= 0) return cap;
  if (qc(netIncome, Q(U("400000"))) >= 0) return QZERO;
  return Q(roundRational(qs(cap, qratio(qs(netIncome, Q(U("200000"))), 15780n, 200000n)), 100n));
}

/**
 * The employer EI multiple for one payroll program account: the statutory
 * 1.4 unless a CRA-approved reduced rate (wage-loss plan) was entered.
 * Entered rates carry up to 4 decimal places inside 1.0000–1.4000; anything
 * else refuses by name rather than pricing a guessed multiple.
 */
function assertEiEmployerMultiple(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const raw = value.trim();
  const inRange = (candidate: string): boolean => {
    const multiple = rate6(candidate);
    return multiple >= rate6("1") && multiple <= rate6("1.4");
  };
  let valid = canonicalNonNegativeDecimal(raw, 4) !== null;
  if (valid) {
    try {
      valid = inRange(raw);
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    throw new PayrollError(
      `employer EI multiple "${value}" must be a decimal with up to 4 places from 1.0000 to 1.4000 `
      + "— enter the CRA-approved reduced rate for the payroll program account, or omit it for the statutory 1.4",
    );
  }
  return raw;
}

function cppExemptionForP(periods: number): bigint {
  const canonical = CPP_EXEMPTION_BY_P[periods];
  if (canonical) return U(canonical);
  // $3,500 / P, truncated (never rounded) to the cent.
  return truncCents(U("3500") / BigInt(periods));
}

/** Statutory credit share of C (base CPP via the unrounded rate ratio). */
function baseShare(amount: bigint, plan: PensionPlanRates): Rational {
  return qratio(Q(amount), rate6(plan.baseRate), rate6(plan.totalRate));
}

export function calculateT4127(input: T4127Input): T4127Result {
  const rates = ratesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) throw new PayrollError(`invalid pay periods per year: ${P}`);
  const PM = input.cppMonths ?? 12;
  if (!Number.isInteger(PM) || PM < 0 || PM > 12) throw new PayrollError(`invalid CPP months: ${PM}`);
  const province = input.province;
  const isQuebec = province === "QC";
  const isOutside = province === "ZZ";
  const prov = rates.provinces[province];
  if (!prov && !isQuebec && !isOutside) throw new PayrollError(`unknown province: ${province}`);

  const factors: Record<string, Money> = {};
  // D() emits fromUnits-fixed: every traced factor is canonical Money.
  const trace = (key: string, value: bigint) => { factors[key] = D(value) as Money; };

  const averaging=input.averaging;
  if(averaging && (!Number.isInteger(averaging.elapsedPeriods)||averaging.elapsedPeriods<1||averaging.elapsedPeriods>P))
    throw new PayrollError('Cumulative averaging requires elapsed scheduled periods from 1 through the schedule’s periods per year — review the withholding method window');
  const project = (amount: Rational): Rational => averaging
    ? qratio(amount, BigInt(P), BigInt(averaging.elapsedPeriods))
    : qint(amount, P);
  const traceExact = (key: string, value: Rational) => trace(key, roundRational(value));
  const income = U(input.income);
  const bonus = opt(input.nonPeriodic);
  if(averaging&&bonus>ZERO&&[input.pensionableNonPeriodic,input.insurableNonPeriodic,input.qpipNonPeriodic].some(value=>value===undefined))
    throw new PayrollError('Cumulative averaging requires the pensionable, EI and QPIP bases of non-periodic pay — review its earning-component classifications before calculating');
  const PI = input.pensionable === undefined ? income + bonus : U(input.pensionable);
  const IE = input.insurable === undefined ? income + bonus : U(input.insurable);
  const ytd = input.ytd ?? {};

  // ---- CPP / QPP -----------------------------------------------------------
  const plan = isQuebec ? rates.qpp : rates.cpp;
  const priorCpp = opt(ytd.cpp);
  const priorCpp2 = opt(ytd.cpp2);
  const priorPensionable = opt(ytd.pensionable);
  const exemption = cppExemptionForP(P);
  const maxTotalProrated = mulRatioCents(U(plan.maxTotal), BigInt(PM), 12n);
  let C = ZERO;
  if (!input.cppExempt && PM > 0) {
    const roomI = maxTotalProrated - priorCpp;
    const periodII = mulRateCents(PI - exemption, plan.totalRate);
    C = max0(bmin(roomI, periodII));
  }
  let C2 = ZERO;
  if (!input.cppExempt && PM > 0) {
    const maxCpp2Prorated = mulRatioCents(U(plan.maxCpp2), BigInt(PM), 12n);
    const W = bmax(priorPensionable, mulRatioCents(U(plan.ympe), BigInt(PM), 12n));
    const band = priorPensionable + PI - W;
    C2 = max0(bmin(maxCpp2Prorated - priorCpp2, mulRateCents(band, plan.cpp2Rate)));
  }
  trace("C", C);
  trace("C2", C2);

  // ---- EI ------------------------------------------------------------------
  const eiRate = isQuebec ? rates.ei.qcEmployeeRate : rates.ei.employeeRate;
  const eiMax = U(isQuebec ? rates.ei.qcMaxEmployee : rates.ei.maxEmployee);
  const priorEi = opt(ytd.ei);
  const EI = input.eiExempt ? ZERO : max0(bmin(eiMax - priorEi, mulRateCents(IE, eiRate)));
  const eiEmployer = mulRateCents(EI, assertEiEmployerMultiple(input.eiEmployerMultiple, rates.ei.employerMultiple));
  trace("EI", EI);

  // ---- QPIP (Quebec) -------------------------------------------------------
  // Priced off the program's OWN insurable base, never the EI leg (see the
  // input): the two bases can differ in either direction.
  let qpip = ZERO;
  let qpipEmployer = ZERO;
  if (isQuebec) {
    const IE_QPIP = input.qpipInsurable === undefined ? IE : U(input.qpipInsurable);
    const priorQpip = opt(ytd.qpip);
    qpip = max0(bmin(U(rates.qpip.maxEmployee) - priorQpip, mulRateCents(IE_QPIP, rates.qpip.employeeRate)));
    const priorQpipEr = opt(ytd.qpipEmployer);
    qpipEmployer = max0(
      bmin(U(rates.qpip.maxEmployer) - priorQpipEr, mulRateCents(IE_QPIP, rates.qpip.employerRate)),
    );
    trace("QPIP", qpip);
  }

  // Rate ratios remain exact through the income and credit calculations.
  // Only statutory contributions and expressly rounded factors are quantized.
  const creditCpp = input.cppWithheld === undefined ? C : U(input.cppWithheld);
  const creditCpp2 = input.cpp2Withheld === undefined ? C2 : U(input.cpp2Withheld);
  const creditEi = input.eiWithheld === undefined ? EI : U(input.eiWithheld);
  const creditQpip = input.qpipWithheld === undefined ? qpip : U(input.qpipWithheld);
  const F5 = qa(qratio(Q(creditCpp), rate6(plan.addlRate), rate6(plan.totalRate)), Q(creditCpp2));
  let F5A = F5;
  let F5B = QZERO;
  const pensionableBonus = input.pensionableNonPeriodic === undefined ? bonus : U(input.pensionableNonPeriodic);
  if (pensionableBonus > ZERO && PI > ZERO) {
    F5A = qratio(F5, max0(PI - pensionableBonus), PI);
    F5B = qs(F5, F5A);
  }
  traceExact("F5", F5); traceExact("F5A", F5A); traceExact("F5B", F5B);

  const F = opt(input.pensionDeductions);
  const F2 = opt(input.alimonyDeductions);
  const F3 = opt(input.nonPeriodicPensionDeductions);
  const U1 = opt(input.unionDues);
  const HD = opt(input.prescribedZoneDeduction);
  const F1 = opt(input.authorizedAnnualDeductions);
  const B1 = opt(ytd.nonPeriodic);
  const F4 = opt(ytd.nonPeriodicPensionDeductions);
  const F5BYtd = opt(ytd.nonPeriodicCppEnhancedDeductions);

  const accumulatedPeriodic = qa(qs(Q(income - F - F2 - U1), F5A), Q(averaging
    ? U(averaging.income) - U(averaging.pensionDeductions) - U(averaging.alimonyDeductions) - U(averaging.f5A) - U(averaging.unionDues)
    : ZERO));
  const annualPeriodic = qmax0(qs(project(accumulatedPeriodic), Q(HD + F1)));
  const bonusNet = qmax0(qs(Q(bonus - F3), F5B));
  const bonusYtdNet = Q(max0(B1 - F4 - F5BYtd));
  const aWithBonus = qsum(annualPeriodic, bonusNet, bonusYtdNet);
  const aWithoutBonus = qa(annualPeriodic, bonusYtdNet);
  traceExact("A", aWithBonus);
  traceExact("A_step2", aWithoutBonus);

  // Each bonus-method tax pass resolves its own income-phased claims.
  const claimsFor = (A: Rational): { TC: Rational; TCP: Rational } => {
    const netIncomeForBpa = qa(A, Q(HD));
    let TC: Rational;
    if (input.federalClaim !== undefined) TC = Q(U(input.federalClaim));
    else if (input.federalClaimCode !== undefined) {
      TC = Q(U(claimCodeAmount(rates.federal.claimCodes, input.federalClaimCode)));
    } else TC = bpaPhaseOut(netIncomeForBpa, rates.federal.bpaf);

    let TCP = QZERO;
    if (prov) {
      if (input.provincialClaim !== undefined) TCP = Q(U(input.provincialClaim));
      else if (input.provincialClaimCode !== undefined) {
        TCP = Q(U(claimCodeAmount(prov.claimCodes, input.provincialClaimCode)));
      } else if (prov.tcpDefault === "BPAF") TCP = bpaPhaseOut(netIncomeForBpa, rates.federal.bpaf);
      else if (prov.tcpDefault === "BPAMB") TCP = prov.bpamb ? bpaPhaseOut(netIncomeForBpa, prov.bpamb) : bpamb(netIncomeForBpa);
      else if (prov.tcpIncomePhaseOut) {
        const phase = prov.tcpIncomePhaseOut;
        const phaseStart = Q(U(phase.phaseStart));
        const phaseEnd = Q(U(phase.phaseEnd));
        if (qc(A, phaseStart) <= 0) TCP = Q(U(phase.max));
        else if (qc(A, phaseEnd) >= 0) TCP = Q(U(phase.min));
        else TCP = qmax(Q(U(phase.min)), qs(Q(U(phase.max)), Q(roundRational(qrate(qs(A, phaseStart), phase.rate), 100n))));
      } else TCP = Q(U(prov.tcpDefault));
    }
    return { TC, TCP };
  };
  const { TC, TCP } = claimsFor(aWithBonus);
  traceExact("TC", TC); traceExact("TCP", TCP);

  const maxBaseProrated = qratio(Q(U(plan.maxBase)), BigInt(PM), 12n);
  const k2Ytd = input.k2Method === "ytd";
  const PR = input.periodsRemaining ?? P;
  let cppCreditBasis: Rational;
  let eiCreditBasis: Rational;
  if (averaging) {
    const projectedPe = qa(project(Q(PI - opt(input.pensionableNonPeriodic) + U(averaging.pensionablePeriodic))), Q(U(averaging.pensionableNonPeriodic)));
    const projectedIe = qa(project(Q(IE - opt(input.insurableNonPeriodic) + U(averaging.insurablePeriodic))), Q(U(averaging.insurableNonPeriodic)));
    cppCreditBasis = input.cppExempt || PM === 0 ? QZERO : qmin(maxBaseProrated,
      qrate(qmax0(qs(projectedPe, qratio(Q(U("3500")), BigInt(PM), 12n))), plan.baseRate));
    eiCreditBasis = input.eiExempt ? QZERO : qmin(Q(eiMax), qrate(qmax0(projectedIe), eiRate));
  } else if (k2Ytd) {
    cppCreditBasis = qmin(maxBaseProrated, qa(baseShare(priorCpp, plan), baseShare(mulInt(creditCpp, PR), plan)));
    eiCreditBasis = qmin(Q(eiMax), Q(priorEi + mulInt(creditEi, PR)));
  } else {
    const maxReached = priorCpp + creditCpp >= maxTotalProrated && maxTotalProrated > ZERO;
    cppCreditBasis = input.cppExempt || PM === 0 ? QZERO
      : maxReached ? maxBaseProrated : qmin(baseShare(mulInt(creditCpp, P), plan), maxBaseProrated);
    const eiMaxReached = priorEi + creditEi >= eiMax;
    eiCreditBasis = input.eiExempt ? QZERO : eiMaxReached ? Q(eiMax) : qmin(Q(mulInt(creditEi, P)), Q(eiMax));
  }
  const projectedQpip = averaging
    ? qa(project(Q((input.qpipInsurable === undefined ? IE : U(input.qpipInsurable)) - opt(input.qpipNonPeriodic) + U(averaging.qpipPeriodic))), Q(U(averaging.qpipNonPeriodic)))
    : QZERO;
  const qpipCreditBasis = isQuebec ? qmin(averaging
    ? qrate(qmax0(projectedQpip), rates.qpip.employeeRate) : Q(mulInt(creditQpip, P)), Q(U(rates.qpip.maxEmployee))) : QZERO;

  function k2At(lowestRate: string): Rational {
    return qrate(qsum(cppCreditBasis, eiCreditBasis, isQuebec ? qpipCreditBasis : QZERO), lowestRate);
  }

  const K3 = Q(opt(input.authorizedFederalCredits));
  const K3P = Q(opt(input.authorizedProvincialCredits));
  const LCF = Q(bmin(mulInt(opt(input.labourFundsCreditFederal), P), U(rates.federal.lcf.cap)));
  const LCP = Q(prov?.lcp ? bmin(mulInt(opt(input.labourFundsCreditProvincial), P), U(prov.lcp.cap)) : ZERO);
  const Y = Q(prov?.ontarioReduction ? mulInt(U(prov.ontarioReduction.perDependant),
    (input.disabledDependants ?? 0) + (input.dependantsUnder19 ?? 0)) : ZERO);

  const annualTax = (A: Rational): { t1: Rational; t2: Rational; parts: Record<string, Rational> } => {
    const parts: Record<string, Rational> = {};
    const { TC, TCP } = claimsFor(A);
    const fed = bracketFor(rates.federal.brackets, A);
    const K1 = qrate(TC, rates.federal.lowestRate);
    const K2 = k2At(rates.federal.lowestRate);
    const K4 = qmin(qrate(qmax0(A), rates.federal.lowestRate), qrate(Q(U(rates.federal.cea)), rates.federal.lowestRate));
    let T3 = qmax0(qs(qrate(A, fed.rate), qsum(Q(U(fed.k)), K1, K2, K3, K4)));
    if (input.taxExempt) T3 = QZERO;
    let T1: Rational;
    if (isQuebec) T1 = qmax0(qs(qs(T3, LCF), qrate(T3, rates.federal.abatementQc)));
    else if (isOutside) T1 = qmax0(qs(qa(T3, qrate(T3, rates.federal.outsideCanadaSurtax)), LCF));
    else T1 = qmax0(qs(T3, LCF));
    parts.K1 = K1; parts.K2 = K2; parts.K4 = K4; parts.T3 = T3; parts.T1 = T1;

    let T2 = QZERO;
    if (prov) {
      const pb = bracketFor(prov.brackets, A);
      const K1P = qrate(TCP, prov.lowestRate);
      const K2P = k2At(prov.lowestRate);
      const K4P = prov.hasK4p ? qmin(qrate(qmax0(A), prov.lowestRate), qrate(Q(U(rates.federal.cea)), prov.lowestRate)) : QZERO;
      const K5Basis = prov.k5p ? qmax0(qs(qa(K1P, K2P), Q(U(prov.k5p.threshold)))) : QZERO;
      const K5P = prov.k5p ? prov.k5p.ratio
        ? qratio(K5Basis, BigInt(prov.k5p.ratio.numerator), BigInt(prov.k5p.ratio.denominator))
        : qrate(K5Basis, prov.k5p.rate) : QZERO;
      let T4 = qmax0(qs(qrate(A, pb.rate), qsum(Q(U(pb.k)), K1P, K2P, K3P, K4P, K5P)));
      if (input.taxExempt) T4 = QZERO;

      let V1 = QZERO;
      if (prov.surtax) {
        const [th1, th2] = prov.surtax.thresholds.map(value => Q(U(value))) as [Rational, Rational];
        const [r1, sr2] = prov.surtax.rates;
        if (qc(T4, th1) > 0) V1 = qa(V1, qrate(qs(T4, th1), r1));
        if (qc(T4, th2) > 0) V1 = qa(V1, qrate(qs(T4, th2), sr2));
      }
      let V2 = QZERO;
      if (prov.healthPremium && !input.taxExempt) {
        if (qc(A, Q(U("200000"))) > 0) V2 = qmin(Q(U("900")), qa(Q(U("750")), qrate(qs(A, Q(U("200000"))), "0.25")));
        else if (qc(A, Q(U("72000"))) > 0) V2 = qmin(Q(U("750")), qa(Q(U("600")), qrate(qs(A, Q(U("72000"))), "0.25")));
        else if (qc(A, Q(U("48000"))) > 0) V2 = qmin(Q(U("600")), qa(Q(U("450")), qrate(qs(A, Q(U("48000"))), "0.25")));
        else if (qc(A, Q(U("36000"))) > 0) V2 = qmin(Q(U("450")), qa(Q(U("300")), qrate(qs(A, Q(U("36000"))), "0.06")));
        else if (qc(A, Q(U("20000"))) > 0) V2 = qmin(Q(U("300")), qrate(qs(A, Q(U("20000"))), "0.06"));
      }
      let S = QZERO;
      if (prov.ontarioReduction) {
        const basis = qa(T4, V1);
        S = qmin(basis, qmax0(qs(qint(qa(Q(U(prov.ontarioReduction.basic)), Y), 2), basis)));
      } else if (prov.bcReduction) {
        const red = prov.bcReduction;
        if (qc(A, Q(U(red.phaseStart))) <= 0) S = qmin(T4, Q(U(red.basic)));
        else if (qc(A, Q(U(red.phaseEnd))) <= 0) S = qmin(T4, qmax0(qs(Q(U(red.basic)), qrate(qs(A, Q(U(red.phaseStart))), red.phaseRate))));
      }
      T2 = qmax0(qs(qsum(T4, V1, V2), qa(S, LCP)));
      parts.K1P = K1P; parts.K2P = K2P; parts.K4P = K4P; parts.K5P = K5P;
      parts.T4 = T4; parts.V1 = V1; parts.V2 = V2; parts.S = S; parts.T2 = T2;
    }
    return { t1: T1, t2: T2, parts };
  };

  const L = opt(input.additionalTaxPerPeriod);
  const withBonus = annualTax(aWithBonus);
  const withoutBonus = bonus > ZERO ? annualTax(aWithoutBonus) : withBonus;
  for (const [key, value] of Object.entries(withBonus.parts)) traceExact(key, value);

  let periodicTax: bigint;
  if (averaging) {
    const M = Q(U(averaging.periodicTax)), M1 = Q(U(averaging.bonusTax));
    const beforeCurrent = qs(qratio(qs(qa(withoutBonus.t1, withoutBonus.t2), M1), BigInt(averaging.elapsedPeriods), BigInt(P)), M);
    periodicTax = roundRational(qmax0(beforeCurrent), 100n) + L;
    trace("S1_NUM", U(String(P))); trace("S1_DEN", U(String(averaging.elapsedPeriods))); trace("M", roundRational(M)); trace("M1", roundRational(M1));
  } else if (qc(aWithoutBonus, QZERO) <= 0) periodicTax = L;
  else {
    const legs = periodTaxLegs(withoutBonus.t1, withoutBonus.t2, P);
    trace("TF", legs.federal); trace("TP", legs.provincial);
    periodicTax = legs.federal + legs.provincial + L;
  }

  let bonusTax = ZERO;
  if (bonus > ZERO && !input.taxExempt) {
    if (!averaging && qc(aWithBonus, Q(U("5000"))) <= 0) {
      bonusTax = mulRateCents(bonus, isQuebec ? "0.10" : "0.15");
    } else {
      bonusTax = roundRational(qmax0(qs(qa(withBonus.t1, withBonus.t2), qa(withoutBonus.t1, withoutBonus.t2))), 100n);
    }
  }
  trace("L", L); trace("T", periodicTax); trace("TB", bonusTax);

  return {
    edition: rates.edition,
    cpp: D(C) as Money,
    cpp2: D(C2) as Money,
    cppEmployer: D(C + C2) as Money,
    ei: D(EI) as Money,
    eiEmployer: D(eiEmployer) as Money,
    qpip: D(qpip) as Money,
    qpipEmployer: D(qpipEmployer) as Money,
    f5: D(roundRational(F5, 100n)) as Money,
    f5A: D(roundRational(F5A, 100n)) as Money,
    f5B: D(roundRational(F5, 100n) - roundRational(F5A, 100n)) as Money,
    periodicTax: D(periodicTax) as Money,
    bonusTax: D(bonusTax) as Money,
    totalTax: D(periodicTax + bonusTax) as Money,
    factors,
  };

}

/** Federal and provincial income tax are withheld as separate per-period
 * amounts, each rounded half-up to the cent from its exact annual liability,
 * as CRA's Payroll Deductions Online Calculator and bureau payroll do. The
 * period's tax is the sum of the rounded legs; rounding (T1 + T2) / P once
 * differs by a cent whenever both remainders straddle the half cent. */
export function periodTaxLegs(t1: bigint | Rational, t2: bigint | Rational, P: number): { federal: bigint; provincial: bigint } {
  if (!Number.isInteger(P) || P <= 0) throw new PayrollError(`not a positive integer: ${P}`);
  const annualFederal = typeof t1 === "bigint" ? Q(t1) : t1;
  const annualProvincial = typeof t2 === "bigint" ? Q(t2) : t2;
  return {
    federal: roundRational(qratio(annualFederal, 1n, BigInt(P)), 100n),
    provincial: roundRational(qratio(annualProvincial, 1n, BigInt(P)), 100n),
  };
}

export type { EditionRates };
