/**
 * CRA T4127 payroll deductions engine — Option 1 (periodic method), Option 2
 * cumulative averaging, plus the bonus /
 * retroactive (non-periodic) method.
 *
 * Faithful to the guide's factor notation (A, C, C2, EI, F5, K1..K4, T1..T4,
 * V1, V2, S, TB…) and its rounding discipline: results round half-up to the
 * cent as each parenthesis resolves; rate ratios are never rounded; the CPP
 * per-period exemption truncates. All arithmetic is exact bigint via
 * money.ts primitives — no floats anywhere.
 *
 * Methods outside this calculator: TD1X commission employees, mid-year province-transfer credit
 * variants (K2R/K2RQ), and Quebec *provincial* income tax (TP-1015, which
 * Revenu Québec administers — QPP/QPIP and the federal abatement side of
 * Quebec employment ARE implemented).
 */
import { PayrollError } from "../error.ts";
import type { Money } from "../../money/brands.ts";
import {
  bmax, bmin, D, divIntCents, max0, mulInt, mulRatioCents, mulRateCents, r2, rate6, truncCents, U,
} from "../../money/payroll-decimal.ts";
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

function bracketFor(brackets: { upTo: string | null; rate: string; k: string }[], annual: bigint) {
  for (const bracket of brackets) {
    if (bracket.upTo === null || annual <= U(bracket.upTo)) return bracket;
  }
  return brackets[brackets.length - 1]!;
}

function bpaPhaseOut(
  netIncome: bigint,
  phase: { max: string; min: string; phaseStart: string; phaseEnd: string; slopeNum: string; slopeDen: string },
): bigint {
  if (netIncome <= U(phase.phaseStart)) return U(phase.max);
  if (netIncome >= U(phase.phaseEnd)) return U(phase.min);
  const reduction = mulRatioCents(
    netIncome - U(phase.phaseStart),
    BigInt(phase.slopeNum),
    BigInt(phase.slopeDen),
  );
  return U(phase.max) - reduction;
}

function bpamb(netIncome: bigint): bigint {
  const cap = U("15780");
  if (netIncome <= U("200000")) return cap;
  if (netIncome >= U("400000")) return ZERO;
  return cap - mulRatioCents(netIncome - U("200000"), 15780n, 200000n);
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
  let valid = /^\d(\.\d{1,4})?$/.test(raw);
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
function baseShare(amount: bigint, plan: PensionPlanRates): bigint {
  return mulRatioCents(amount, rate6(plan.baseRate), rate6(plan.totalRate));
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
  const project=(amount:bigint)=>averaging?mulRatioCents(amount,BigInt(P),BigInt(averaging.elapsedPeriods)):mulInt(amount,P);
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

  // ---- F5: enhanced-CPP income deduction and its periodic/bonus split ------
  // The credit bases below price off what was actually withheld on this run
  // (the supplemental-period share); every other caller leaves the overrides
  // absent and prices off the computed amounts, exactly as the guide states.
  const creditCpp = input.cppWithheld === undefined ? C : U(input.cppWithheld);
  const creditCpp2 = input.cpp2Withheld === undefined ? C2 : U(input.cpp2Withheld);
  const creditEi = input.eiWithheld === undefined ? EI : U(input.eiWithheld);
  const creditQpip = input.qpipWithheld === undefined ? qpip : U(input.qpipWithheld);
  const F5 = r2(mulRatioCents(creditCpp, rate6(plan.addlRate), rate6(plan.totalRate)) + creditCpp2);
  let F5A = F5;
  let F5B = ZERO;
  const pensionableBonus=input.pensionableNonPeriodic===undefined?bonus:U(input.pensionableNonPeriodic);
  if (pensionableBonus > ZERO && PI > ZERO) {
    F5A = mulRatioCents(F5, max0(PI - pensionableBonus), PI);
    F5B = F5 - F5A;
  }
  trace("F5", F5); trace("F5A", F5A); trace("F5B", F5B);

  // ---- Annual taxable income: Step 1 (with bonus) and Step 2 (without) -----
  const F = opt(input.pensionDeductions);
  const F2 = opt(input.alimonyDeductions);
  const F3 = opt(input.nonPeriodicPensionDeductions);
  const U1 = opt(input.unionDues);
  const HD = opt(input.prescribedZoneDeduction);
  const F1 = opt(input.authorizedAnnualDeductions);
  const B1 = opt(ytd.nonPeriodic);
  const F4 = opt(ytd.nonPeriodicPensionDeductions);
  const F5BYtd = opt(ytd.nonPeriodicCppEnhancedDeductions);

  const accumulatedPeriodic=income-F-F2-F5A-U1+(averaging?
    U(averaging.income)-U(averaging.pensionDeductions)-U(averaging.alimonyDeductions)-U(averaging.f5A)-U(averaging.unionDues):ZERO);
  const annualPeriodic = max0(project(accumulatedPeriodic) - HD - F1);
  const bonusNet = max0(bonus - F3 - F5B);
  const bonusYtdNet = max0(B1 - F4 - F5BYtd);
  const aWithBonus = annualPeriodic + bonusNet + bonusYtdNet;
  const aWithoutBonus = annualPeriodic + bonusYtdNet;
  trace("A", aWithBonus);
  trace("A_step2", aWithoutBonus);

  // ---- Claims --------------------------------------------------------------
  const netIncomeForBpa = aWithBonus + HD;
  let TC: bigint;
  if (input.federalClaim !== undefined) TC = U(input.federalClaim);
  else if (input.federalClaimCode !== undefined) {
    TC = U(claimCodeAmount(rates.federal.claimCodes, input.federalClaimCode));
  } else TC = bpaPhaseOut(netIncomeForBpa, rates.federal.bpaf);

  let TCP = ZERO;
  if (prov) {
    if (input.provincialClaim !== undefined) TCP = U(input.provincialClaim);
    else if (input.provincialClaimCode !== undefined) {
      TCP = U(claimCodeAmount(prov.claimCodes, input.provincialClaimCode));
    } else if (prov.tcpDefault === "BPAF") TCP = bpaPhaseOut(netIncomeForBpa, rates.federal.bpaf);
    else if (prov.tcpDefault === "BPAMB") TCP = prov.bpamb ? bpaPhaseOut(netIncomeForBpa, prov.bpamb) : bpamb(netIncomeForBpa);
    else if (prov.tcpIncomePhaseOut) {
      const phase = prov.tcpIncomePhaseOut;
      const phaseStart = U(phase.phaseStart);
      const phaseEnd = U(phase.phaseEnd);
      if (aWithBonus <= phaseStart) TCP = U(phase.max);
      else if (aWithBonus >= phaseEnd) TCP = U(phase.min);
      else TCP = bmax(U(phase.min), U(phase.max) - mulRateCents(aWithBonus - phaseStart, phase.rate));
    }
    else TCP = U(prov.tcpDefault);
  }
  trace("TC", TC); trace("TCP", TCP);

  // ---- K2 credits (base CPP + EI [+ QPIP], at the lowest rate) -------------
  const maxBaseProrated = mulRatioCents(U(plan.maxBase), BigInt(PM), 12n);
  const k2Ytd = input.k2Method === "ytd";
  const PR = input.periodsRemaining ?? P;
  let cppCreditBasis: bigint;
  let eiCreditBasis: bigint;
  if (averaging) {
    const projectedPe=project(PI-opt(input.pensionableNonPeriodic)+U(averaging.pensionablePeriodic))+U(averaging.pensionableNonPeriodic);
    const projectedIe=project(IE-opt(input.insurableNonPeriodic)+U(averaging.insurablePeriodic))+U(averaging.insurableNonPeriodic);
    cppCreditBasis=input.cppExempt||PM===0?ZERO:bmin(maxBaseProrated,mulRateCents(max0(projectedPe-mulRatioCents(U("3500"),BigInt(PM),12n)),plan.baseRate));
    eiCreditBasis=input.eiExempt?ZERO:bmin(eiMax,mulRateCents(max0(projectedIe),eiRate));
  } else if (k2Ytd) {
    // (D × base/total) + (PR × C × base/total): two parentheses, each rounded once.
    cppCreditBasis = bmin(
      maxBaseProrated,
      baseShare(priorCpp, plan) + baseShare(mulInt(creditCpp, PR), plan),
    );
    eiCreditBasis = bmin(eiMax, priorEi + mulInt(creditEi, PR));
  } else {
    // (P × C × base/total): one parenthesis — multiply through, round once.
    const maxReached = priorCpp + creditCpp >= maxTotalProrated && maxTotalProrated > ZERO;
    cppCreditBasis = input.cppExempt || PM === 0
      ? ZERO
      : maxReached ? maxBaseProrated : bmin(baseShare(mulInt(creditCpp, P), plan), maxBaseProrated);
    const eiMaxReached = priorEi + creditEi >= eiMax;
    eiCreditBasis = input.eiExempt ? ZERO : eiMaxReached ? eiMax : bmin(mulInt(creditEi, P), eiMax);
  }
  const projectedQpip=averaging?project((input.qpipInsurable===undefined?IE:U(input.qpipInsurable))-opt(input.qpipNonPeriodic)+U(averaging.qpipPeriodic))+U(averaging.qpipNonPeriodic):ZERO;
  const qpipCreditBasis = isQuebec ? bmin(averaging?mulRateCents(max0(projectedQpip),rates.qpip.employeeRate):mulInt(creditQpip,P), U(rates.qpip.maxEmployee)) : ZERO;

  function k2At(lowestRate: string): bigint {
    let credit = mulRateCents(cppCreditBasis, lowestRate) + mulRateCents(eiCreditBasis, lowestRate);
    if (isQuebec) credit += mulRateCents(qpipCreditBasis, lowestRate);
    return credit;
  }

  // ---- Annual tax passes ---------------------------------------------------
  const K3 = opt(input.authorizedFederalCredits);
  const K3P = opt(input.authorizedProvincialCredits);
  // LCF/LCP inputs are per-period credit amounts. Annualize before applying
  // the statutory annual caps; the tax formulas below consume annual credits.
  const LCF = bmin(mulInt(opt(input.labourFundsCreditFederal), P), U(rates.federal.lcf.cap));
  const LCP = prov?.lcp
    ? bmin(mulInt(opt(input.labourFundsCreditProvincial), P), U(prov.lcp.cap))
    : ZERO;
  const Y = prov?.ontarioReduction
    ? mulInt(U(prov.ontarioReduction.perDependant),
        (input.disabledDependants ?? 0) + (input.dependantsUnder19 ?? 0))
    : ZERO;

  const annualTax = (A: bigint): { t1: bigint; t2: bigint; parts: Record<string, bigint> } => {
    const parts: Record<string, bigint> = {};
    // Federal
    const fed = bracketFor(rates.federal.brackets, A);
    const K1 = mulRateCents(TC, rates.federal.lowestRate);
    const K2 = k2At(rates.federal.lowestRate);
    const K4 = bmin(
      mulRateCents(max0(A), rates.federal.lowestRate),
      mulRateCents(U(rates.federal.cea), rates.federal.lowestRate),
    );
    let T3 = max0(mulRateCents(A, fed.rate) - U(fed.k) - K1 - K2 - K3 - K4);
    if (input.taxExempt) T3 = ZERO;
    let T1: bigint;
    if (isQuebec) T1 = max0(T3 - LCF - mulRateCents(T3, rates.federal.abatementQc));
    else if (isOutside) T1 = max0(T3 + mulRateCents(T3, rates.federal.outsideCanadaSurtax) - LCF);
    else T1 = max0(T3 - LCF);
    parts.K1 = K1; parts.K2 = K2; parts.K4 = K4; parts.T3 = T3; parts.T1 = T1;

    // Provincial / territorial
    let T2 = ZERO;
    if (prov) {
      const pb = bracketFor(prov.brackets, A);
      const K1P = mulRateCents(TCP, prov.lowestRate);
      const K2P = k2At(prov.lowestRate);
      const K4P = prov.hasK4p
        ? bmin(mulRateCents(max0(A), prov.lowestRate), mulRateCents(U(rates.federal.cea), prov.lowestRate))
        : ZERO;
      const K5P = prov.k5p
        ? mulRateCents(max0(K1P + K2P - U(prov.k5p.threshold)), prov.k5p.rate)
        : ZERO;
      let T4 = max0(mulRateCents(A, pb.rate) - U(pb.k) - K1P - K2P - K3P - K4P - K5P);
      if (input.taxExempt) T4 = ZERO;

      let V1 = ZERO;
      if (prov.surtax) {
        const [th1, th2] = prov.surtax.thresholds.map(U) as [bigint, bigint];
        const [r1, sr2] = prov.surtax.rates;
        if (T4 > th1) V1 += mulRateCents(T4 - th1, r1);
        if (T4 > th2) V1 += mulRateCents(T4 - th2, sr2);
      }

      let V2 = ZERO;
      if (prov.healthPremium) {
        if (A > U("200000")) V2 = bmin(U("900"), U("750") + mulRateCents(A - U("200000"), "0.25"));
        else if (A > U("72000")) V2 = bmin(U("750"), U("600") + mulRateCents(A - U("72000"), "0.25"));
        else if (A > U("48000")) V2 = bmin(U("600"), U("450") + mulRateCents(A - U("48000"), "0.25"));
        else if (A > U("36000")) V2 = bmin(U("450"), U("300") + mulRateCents(A - U("36000"), "0.06"));
        else if (A > U("20000")) V2 = bmin(U("300"), mulRateCents(A - U("20000"), "0.06"));
      }

      let S = ZERO;
      if (prov.ontarioReduction) {
        const basis = T4 + V1;
        S = bmin(basis, max0(mulInt(U(prov.ontarioReduction.basic) + Y, 2) - basis));
      } else if (prov.bcReduction) {
        const red = prov.bcReduction;
        if (A <= U(red.phaseStart)) S = bmin(T4, U(red.basic));
        else if (A <= U(red.phaseEnd)) {
          S = bmin(T4, max0(U(red.basic) - mulRateCents(A - U(red.phaseStart), red.phaseRate)));
        }
      }

      T2 = max0(T4 + V1 + V2 - S - LCP);
      parts.K1P = K1P; parts.K2P = K2P; parts.K4P = K4P; parts.K5P = K5P;
      parts.T4 = T4; parts.V1 = V1; parts.V2 = V2; parts.S = S; parts.T2 = T2;
    }
    return { t1: T1, t2: T2, parts };
  };

  const L = opt(input.additionalTaxPerPeriod);
  const withBonus = annualTax(aWithBonus);
  const withoutBonus = bonus > ZERO ? annualTax(aWithoutBonus) : withBonus;
  for (const [key, value] of Object.entries(withBonus.parts)) trace(key, value);

  // ---- Per-period tax ------------------------------------------------------
  let periodicTax: bigint;
  if (averaging) {
    const M=U(averaging.periodicTax),M1=U(averaging.bonusTax);
    periodicTax=max0(mulRatioCents(withoutBonus.t1+withoutBonus.t2-M1,BigInt(averaging.elapsedPeriods),BigInt(P))-M)+L;
    trace("S1_NUM",U(String(P)));trace("S1_DEN",U(String(averaging.elapsedPeriods)));trace("M",M);trace("M1",M1);
  } else if (aWithoutBonus <= ZERO) periodicTax = L;
  else {
    const legs = periodTaxLegs(withoutBonus.t1, withoutBonus.t2, P);
    trace("TF", legs.federal); trace("TP", legs.provincial);
    periodicTax = legs.federal + legs.provincial + L;
  }

  let bonusTax = ZERO;
  if (bonus > ZERO) {
    if (!averaging && aWithBonus <= U("5000")) {
      bonusTax = mulRateCents(bonus, isQuebec ? "0.10" : "0.15");
    } else {
      bonusTax = max0(withBonus.t1 + withBonus.t2 - (withoutBonus.t1 + withoutBonus.t2));
    }
  }
  trace("L",L);
  trace("T", periodicTax);
  trace("TB", bonusTax);

  // Every leg is a D() (fromUnits-fixed) output: canonical Money.
  return {
    edition: rates.edition,
    cpp: D(C) as Money,
    cpp2: D(C2) as Money,
    cppEmployer: D(C + C2) as Money,
    ei: D(EI) as Money,
    eiEmployer: D(eiEmployer) as Money,
    qpip: D(qpip) as Money,
    qpipEmployer: D(qpipEmployer) as Money,
    f5: D(F5) as Money,
    f5A: D(F5A) as Money,
    f5B: D(F5B) as Money,
    periodicTax: D(periodicTax) as Money,
    bonusTax: D(bonusTax) as Money,
    totalTax: D(periodicTax + bonusTax) as Money,
    factors,
  };
}

/**
 * The per-period federal and provincial tax, each rounded half-up to the
 * cent on its own. CRA's payroll deductions calculator and bureau payroll
 * withhold the two as separate amounts, so the period's tax is the sum of
 * the rounded legs; rounding (T1 + T2) / P once drifts by a cent whenever
 * both remainders sit at or above the half cent.
 */
export function periodTaxLegs(t1: bigint, t2: bigint, P: number): { federal: bigint; provincial: bigint } {
  return { federal: divIntCents(t1, P), provincial: divIntCents(t2, P) };
}

export type { EditionRates };
