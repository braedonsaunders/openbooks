/**
 * CRA T4127 payroll deductions engine — Option 1 (periodic method), the
 * method used by every major Canadian payroll provider, plus the bonus /
 * retroactive (non-periodic) method.
 *
 * Faithful to the guide's factor notation (A, C, C2, EI, F5, K1..K4, T1..T4,
 * V1, V2, S, TB…) and its rounding discipline: results round half-up to the
 * cent as each parenthesis resolves; rate ratios are never rounded; the CPP
 * per-period exemption truncates. All arithmetic is exact bigint via
 * money.ts primitives — no floats anywhere.
 *
 * Out of scope in v1 (documented, not forgotten): Option 2 cumulative
 * averaging, TD1X commission employees, mid-year province-transfer credit
 * variants (K2R/K2RQ), and Quebec *provincial* income tax (TP-1015, which
 * Revenu Québec administers — QPP/QPIP and the federal abatement side of
 * Quebec employment ARE implemented).
 */
import {
  bmax, bmin, D, divIntCents, max0, mulInt, mulRatioCents, mulRateCents, r2, rate6, truncCents, U,
} from "./decimal";
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

  ytd?: T4127Ytd;
}

export interface T4127Result {
  edition: number;
  /** C — CPP/QPP employee contribution this period (base + first additional). */
  cpp: string;
  /** C2 — second-additional CPP/QPP this period. */
  cpp2: string;
  /** Employer CPP/QPP (match of C + C2). */
  cppEmployer: string;
  /** EI employee premium this period. */
  ei: string;
  /** EI employer premium (employee × multiple). */
  eiEmployer: string;
  /** QPIP employee / employer premiums (Quebec only, else "0.0000"). */
  qpip: string;
  qpipEmployer: string;
  /** F5 and its periodic / non-periodic split. */
  f5: string;
  f5A: string;
  f5B: string;
  /** T — tax on the periodic remuneration for this period (includes L). */
  periodicTax: string;
  /** TB — tax payable now on the non-periodic payment. */
  bonusTax: string;
  /** periodicTax + bonusTax. */
  totalTax: string;
  /** Every intermediate factor, for the explainability trace. */
  factors: Record<string, string>;
}

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
  if (!Number.isInteger(P) || P < 1 || P > 2000) throw new Error(`invalid pay periods per year: ${P}`);
  const PM = input.cppMonths ?? 12;
  if (!Number.isInteger(PM) || PM < 0 || PM > 12) throw new Error(`invalid CPP months: ${PM}`);
  const province = input.province;
  const isQuebec = province === "QC";
  const isOutside = province === "ZZ";
  const prov = rates.provinces[province];
  if (!prov && !isQuebec && !isOutside) throw new Error(`unknown province: ${province}`);

  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  const income = U(input.income);
  const bonus = opt(input.nonPeriodic);
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
  const eiEmployer = mulRateCents(EI, rates.ei.employerMultiple);
  trace("EI", EI);

  // ---- QPIP (Quebec) -------------------------------------------------------
  let qpip = ZERO;
  let qpipEmployer = ZERO;
  if (isQuebec) {
    const priorQpip = opt(ytd.qpip);
    qpip = max0(bmin(U(rates.qpip.maxEmployee) - priorQpip, mulRateCents(IE, rates.qpip.employeeRate)));
    const priorQpipEr = opt(ytd.qpipEmployer);
    qpipEmployer = max0(
      bmin(U(rates.qpip.maxEmployer) - priorQpipEr, mulRateCents(IE, rates.qpip.employerRate)),
    );
    trace("QPIP", qpip);
  }

  // ---- F5: enhanced-CPP income deduction and its periodic/bonus split ------
  const F5 = r2(mulRatioCents(C, rate6(plan.addlRate), rate6(plan.totalRate)) + C2);
  let F5A = F5;
  let F5B = ZERO;
  if (bonus > ZERO && PI > ZERO) {
    F5A = mulRatioCents(F5, max0(PI - bonus), PI);
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

  const annualPeriodic = max0(mulInt(income - F - F2 - F5A - U1, P) - HD - F1);
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
    else if (prov.tcpDefault === "BPAMB") TCP = bpamb(netIncomeForBpa);
    else TCP = U(prov.tcpDefault);
  }
  trace("TC", TC); trace("TCP", TCP);

  // ---- K2 credits (base CPP + EI [+ QPIP], at the lowest rate) -------------
  const maxBaseProrated = mulRatioCents(U(plan.maxBase), BigInt(PM), 12n);
  const k2Ytd = input.k2Method === "ytd";
  const PR = input.periodsRemaining ?? P;
  let cppCreditBasis: bigint;
  let eiCreditBasis: bigint;
  if (k2Ytd) {
    // (D × base/total) + (PR × C × base/total): two parentheses, each rounded once.
    cppCreditBasis = bmin(
      maxBaseProrated,
      baseShare(priorCpp, plan) + baseShare(mulInt(C, PR), plan),
    );
    eiCreditBasis = bmin(eiMax, priorEi + mulInt(EI, PR));
  } else {
    // (P × C × base/total): one parenthesis — multiply through, round once.
    const maxReached = priorCpp + C >= maxTotalProrated && maxTotalProrated > ZERO;
    cppCreditBasis = input.cppExempt || PM === 0
      ? ZERO
      : maxReached ? maxBaseProrated : bmin(baseShare(mulInt(C, P), plan), maxBaseProrated);
    const eiMaxReached = priorEi + EI >= eiMax;
    eiCreditBasis = input.eiExempt ? ZERO : eiMaxReached ? eiMax : bmin(mulInt(EI, P), eiMax);
  }
  const qpipCreditBasis = isQuebec ? bmin(mulInt(qpip, P), U(rates.qpip.maxEmployee)) : ZERO;

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
  if (aWithoutBonus <= ZERO) periodicTax = L;
  else periodicTax = divIntCents(withoutBonus.t1 + withoutBonus.t2, P) + L;

  let bonusTax = ZERO;
  if (bonus > ZERO) {
    if (aWithBonus <= U("5000")) {
      bonusTax = mulRateCents(bonus, isQuebec ? "0.10" : "0.15");
    } else {
      bonusTax = max0(withBonus.t1 + withBonus.t2 - (withoutBonus.t1 + withoutBonus.t2));
    }
  }
  trace("T", periodicTax);
  trace("TB", bonusTax);

  return {
    edition: rates.edition,
    cpp: D(C),
    cpp2: D(C2),
    cppEmployer: D(C + C2),
    ei: D(EI),
    eiEmployer: D(eiEmployer),
    qpip: D(qpip),
    qpipEmployer: D(qpipEmployer),
    f5: D(F5),
    f5A: D(F5A),
    f5B: D(F5B),
    periodicTax: D(periodicTax),
    bonusTax: D(bonusTax),
    totalTax: D(periodicTax + bonusTax),
    factors,
  };
}

export type { EditionRates };
