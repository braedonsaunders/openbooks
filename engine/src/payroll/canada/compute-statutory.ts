import { sql } from "drizzle-orm";
import type { db } from "../../platform/db.ts";
import { add, cmp, div, fromUnits, mulDecimal, mulPercent, neg, sum, toUnits } from "../../money/money.ts";
import { certificateCount, type ResolvedCertificate } from "../certificates.ts";
import { empFact } from "../employee-facts.ts";
import { findStoredEmployerFactValue } from "../employer-fact-store.ts";
import { resolveEmployerFact } from "../employer-facts.ts";
import { PayrollError } from "../error.ts";
// Side effect: registers CA_EMPLOYEE_FACTS, so every read below resolves
// through the declaration in every import graph — never via a transitive
// side effect of the pack registry.
import "./employee-facts.ts";
import { calculateT4127, type T4127Input } from "./t4127.ts";
import { calculateTp1015 } from "./quebec/tp1015.ts";
import { qcRatesForPayDate } from "./quebec/rates.ts";
import { ratesForPayDate, type Province } from "./rates.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { CA_SUPPLEMENTAL_PAY_TREATMENT } from "./supplemental-pay.ts";
import { EMPTY_PERIOD_PRIORS, periodPriorsEmpty } from "../period-priors.ts";
import { cumulativeHistory } from "./cumulative-history.ts";
import { CA_OPENING_YTD_FIELDS } from "./opening-ytd.ts";
import { PayrollPackError } from "../payroll-error.ts";

/** TD1ON dependant claims that drive Ontario's T4127 factor Y. */
export function t4127OntarioDependantInputs(
  certificate: ResolvedCertificate | null,
): Pick<T4127Input, "disabledDependants" | "dependantsUnder19"> {
  if (!certificate) {
    throw new PayrollPackError(
      "Ontario income tax requires the TD1ON certificate declaration — restore the Ontario "
      + "certificate in the Canada payroll pack before calculating",
    );
  }
  return {
    disabledDependants: certificateCount(certificate, "disabled_dependants") ?? 0,
    dependantsUnder19: certificateCount(certificate, "dependants_under_19") ?? 0,
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass stamps itself (the payroll inputs, the employer-side
 * shares, and the employer-levy factors). The T4127 and TP-1015 letters
 * live beside their engines.
 */
export const CA_COMPUTE_FACTOR_LABELS: Readonly<Record<string, string>> = {
  F:"Periodic pension deductions", F2:"Alimony deducted at source",U1:"Periodic union dues",F3:"Pension deductions from a bonus",
  CA_PE:"Periodic pensionable earnings",CA_IE:"Periodic EI insurable earnings",CA_QPIP_PE:"Periodic QPIP insurable earnings",
  CA_BPE:"Bonus pensionable earnings",CA_BIE:"Bonus EI insurable earnings",CA_BQPIP:"Bonus QPIP insurable earnings",
  CA_T_BASE:"Periodic income tax excluding additional tax",
  B: "Bonus / non-periodic pay this period",
  I: "Periodic income this period",
  PI: "Pensionable earnings this period",
  IE: "Insurable earnings this period",
  QPIP: "QPIP premium",
  EI_ER: "EI premium (employer)",
  QPIP_ER: "QPIP premium (employer)",
  WCB: "Workers' compensation premium (employer)",
  WCB_EARN: "Workers' compensation assessable earnings",
  EHT: "Employer Health Tax",
  EHT_EARN: "EHT remuneration (Ontario)",
  HSF: "Health Services Fund (employer)",
  HSF_EARN: "HSF remuneration subject",
  CNT: "Contribution related to labour standards (employer)",
  CNT_EARN: "CNT remuneration subject",
};

export type CanadaYtdRow = {
  pensionable: string;
  insurable: string;
  cpp: string;
  cpp2: string;
  ei: string;
  qpip: string;
  /** Employer QPIP has its own annual maximum, so it needs its own YTD. */
  qpip_employer: string;
  non_periodic: string;
  pension_deductions_bonus:string;
  f5b: string;
  qc_csb: string;
};

/**
 * Read the employee's year-to-date statutory inputs from committed payroll.
 * Calculated runs are drafts and may be abandoned; counting them would let
 * unpaid figures consume CPP/EI/tax room in a later run.
 */
export async function employeeYtd(
  ctx: Pick<PayrollStatutoryComputeContext, "tx" | "orgId" | "employeePartyId" | "taxYear" | "documentId">,
): Promise<CanadaYtdRow> {
  const { tx, orgId, employeePartyId, taxYear, documentId } = ctx;
  const cpp2BonusColumn = CA_OPENING_YTD_FIELDS.find((field) => field.key === "cpp2BonusYtd")!.column;
  const qcCsbColumn = CA_OPENING_YTD_FIELDS.find((field) => field.key === "qcCsbYtd")!.column;
  const qpipEmployerColumn = CA_OPENING_YTD_FIELDS.find((field) => field.key === "qpipEmployerYtd")!.column;
  const r = (await tx.execute<CanadaYtdRow>(sql`
    select
      coalesce((select pensionable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.pensionable_earnings), 0) as pensionable,
      coalesce((select insurable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.insurable_earnings), 0) as insurable,
      coalesce((select cpp_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'C')::numeric), 0) as cpp,
      coalesce((select cpp2_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'C2')::numeric), 0) as cpp2,
      coalesce((select ei_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'EI')::numeric), 0) as ei,
      coalesce((select qpip_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'QPIP')::numeric), 0) as qpip,
      coalesce((select ${sql.raw(qpipEmployerColumn)} from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'QPIP_ER')::numeric), 0) as qpip_employer,
      coalesce((select non_periodic_pension_deductions_ytd from payroll_opening_balances
                 where org_id=${orgId} and employee_party_id=${employeePartyId} and tax_year=${taxYear}),0)
      + coalesce(sum((s.factors->>'F3')::numeric),0) as pension_deductions_bonus,
      coalesce((select non_periodic_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'B')::numeric), 0) as non_periodic,
      coalesce((select ${sql.raw(cpp2BonusColumn)} from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'F5B')::numeric), 0) as f5b,
      coalesce((select ${sql.raw(qcCsbColumn)} from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'QC_CSB')::numeric), 0) as qc_csb
    from pay_stubs s
    join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
    join documents d on d.id = r.document_id and d.org_id = r.org_id
    where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
      and s.tax_year = ${taxYear} and s.pay_run_document_id <> ${documentId}
      and r.run_status = 'committed'
      and d.status <> 'voided'
  `));
  return r.rows[0]!;
}

/**
 * The employer EI multiple for one employee's payroll program account.
 *
 * An employee with no filing account prices the statutory 1.4 — no
 * reduced-rate program is in play. An employee on a CRA payroll program
 * (RP) account prices that account's multiple effective on the pay date. An
 * account that never recorded a multiple prices the statutory 1.4; an
 * account whose multiples leave the pay date uncovered refuses by name,
 * because the configured rate history cannot price this stub and guessing
 * the standard rate past an approval would understate the liability.
 */
export async function resolveEiEmployerMultiple(input: {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  filingAccountId: string | null;
  employeeName: string;
  payDate: string;
}): Promise<string> {
  const { tx, orgId, filingAccountId, employeeName, payDate } = input;
  if (filingAccountId == null) return "1.4";
  const account = (await tx.execute<{ country: string; program_type: string }>(sql`
    select country, program_type from payroll_filing_accounts
     where org_id = ${orgId} and id = ${filingAccountId} and is_active
  `)).rows[0];
  if (!account || account.country !== "CA" || account.program_type !== "ca_rp") return "1.4";
  const stored = await findStoredEmployerFactValue({
    tx, orgId, filingAccountId, country: "CA",
    factKey: "ei_employer_multiplier", asOf: payDate,
  });
  if (stored != null) {
    return resolveEmployerFact("CA", "ei_employer_multiplier", stored)!;
  }
  const configured = (await tx.execute<{ configured: boolean }>(sql`
    select exists (
      select 1 from payroll_employer_facts
       where org_id = ${orgId} and filing_account_id = ${filingAccountId}::uuid
         and country = 'CA' and fact_key = 'ei_employer_multiplier'
    ) as configured
  `)).rows[0]!.configured;
  if (!configured) return "1.4";
  throw new PayrollError(
    `${employeeName} is on a payroll program account with no employer EI multiple effective on ${payDate} `
    + "— record the CRA-approved rate (or the standard 1.4) in Payroll Setup → Employer facts before calculating",
  );
}

/** Phase 9 — CA pack statutory pass (T4127 + Québec TP-1015). */
export async function computeCaStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const {
    tx, orgId, documentId, employeePartyId, employeeName, taxYear, region, run, emp,
    periodsPerYear: P, income, nonPeriodic, pensionable, insurable, deduction,
    pushStatutory, bool, assertRegionSupported, employerLevies,
  } = ctx;
  // The employee's payroll program account prices the employer share: the
  // statutory 1.4 by default, the CRA-approved reduced rate where one is
  // recorded, or a named refusal when the account's rate history leaves
  // the pay date uncovered.
  const eiEmployerMultiple = await resolveEiEmployerMultiple({
    tx, orgId,
    filingAccountId: ctx.filingAccountId ?? null,
    employeeName,
    payDate: run.pay_date!,
  });
  // The QPIP program's own insurable base — never the EI leg. Absent only on
  // unit-constructed contexts, where it reads the `insurable` leg (legacy
  // math, bit-identical); the engine always provides it via the pack's
  // declared contribution program.
  const qpipInsurable = ctx.programBases?.["qpip"] ?? insurable;
  const { wcbAmount, wcbAssessable, ehtAmount, ehtEarnings, hsfAmount, hsfEarnings, cntAmount, cntEarnings } = employerLevies;

  assertRegionSupported(region);

  const ytd = await employeeYtd({ tx, orgId, employeePartyId, taxYear, documentId });
  const ontarioDependantInputs = region === "ON"
    ? t4127OntarioDependantInputs(ctx.certificateFor("ca_td1_ON"))
    : {};
  const qcCertificate = region === "QC" ? ctx.certificateFor("ca_td1_QC") : null;
  const sharePurchases = qcCertificate?.answers ?? {};
  const requestedFtqSharesPerPeriod = sharePurchases.ftq_shares_per_period ?? "0";
  const requestedFondactionSharesPerPeriod = sharePurchases.fondaction_shares_per_period ?? "0";
  const fundPurchaseCap = region === "QC"
    ? toUnits(qcRatesForPayDate(run.pay_date!).labourFundsAnnualPurchaseCap)
    : null;
  const annualFtqShares = toUnits(requestedFtqSharesPerPeriod) * BigInt(P);
  const annualFondactionShares = toUnits(requestedFondactionSharesPerPeriod) * BigInt(P);
  const annualFundShares = annualFtqShares + annualFondactionShares;
  const annualEligibleShares = fundPurchaseCap === null || annualFundShares <= fundPurchaseCap
    ? annualFundShares : fundPurchaseCap;
  const eligibleAnnualFtqShares = annualEligibleShares === annualFundShares
    ? annualFtqShares
    : (annualFtqShares * annualEligibleShares + annualFundShares / 2n) / annualFundShares;
  const ftqSharesPerPeriod = region === "QC"
    ? div(fromUnits(eligibleAnnualFtqShares), String(P))
    : requestedFtqSharesPerPeriod;
  const fondactionSharesPerPeriod = region === "QC"
    ? div(fromUnits(annualEligibleShares - eligibleAnnualFtqShares), String(P))
    : requestedFondactionSharesPerPeriod;

  // ---- Supplemental-period priors ----------------------------------------
  // Earlier runs of the same period and schedule already paid and withheld
  // part of this period. Contributions always price on the period-to-date
  // base (a per-period exemption applies once per period); income tax
  // follows the org's supplemental method. With no priors every combined leg
  // below equals its current leg and every subtraction is zero, so the first
  // run of a period prices exactly as a standalone run.
  const priors = ctx.periodPriors ?? EMPTY_PERIOD_PRIORS;
  const priorFactor = (key: string): string => priors.factors[key] ?? "0";
  const priorWithheld = (keys: readonly string[]): string =>
    sum(keys.map((key) => priors.withheldBySystemKey[key] ?? "0"));
  const hasPriors = !periodPriorsEmpty(priors);
  const supplementalMethod = ctx.supplementalTaxMethod ?? "per_run";
  const runType = (run.run_type as string) ?? "regular";
  // A supplemental run IS periodic pay for tax (that is what distinguishes it
  // from a bonus run), so under the cumulative method its own non-periodic
  // lines join the period's single periodic pay too. A regular run keeps its
  // bonus method until a second run actually shares the period — otherwise
  // every existing bonus-carrying regular run would reprice.
  const foldBonus = supplementalMethod === "period_cumulative" && (hasPriors || runType === "supplemental");
  const priorFederalTax = priorWithheld(CA_SUPPLEMENTAL_PAY_TREATMENT.federalTaxSystemKeys);
  const priorProvincialTax = priorWithheld(CA_SUPPLEMENTAL_PAY_TREATMENT.provincialTaxSystemKeys);
  // A share is never negative: annual maxima that moved under an already-paid
  // period (a mid-year edition change) floor this run at zero rather than
  // booking a refund through payroll.
  const nonNegative = (value: string): string => (cmp(value, "0") < 0 ? "0" : value);

  // Period-to-date legs: earlier runs' traced factors rejoin the current
  // legs. The stub keeps tracing its OWN legs (B, I, PI, IE, F, … below), so
  // a later run's priors telescope: each run adds its share, never the total.
  const periodPensionable = add(priors.pensionable, pensionable);
  const periodInsurable = add(priors.insurable, insurable);
  const periodQpipInsurable = add(add(priorFactor("CA_QPIP_PE"), priorFactor("CA_BQPIP")), qpipInsurable);
  const taxIncome = foldBonus
    ? add(add(add(priorFactor("I"), priorFactor("B")), income), nonPeriodic)
    : income;
  const taxNonPeriodic = foldBonus ? "0" : nonPeriodic;
  const taxPensionDeductions = foldBonus
    ? add(add(add(priorFactor("F"), priorFactor("F3")), deduction("pension_f")), deduction("pension_f_bonus"))
    : deduction("pension_f");
  const taxAlimony = foldBonus ? add(priorFactor("F2"), deduction("alimony")) : deduction("alimony");
  const taxUnionDues = foldBonus ? add(priorFactor("U1"), deduction("union_dues")) : deduction("union_dues");
  const taxNonPeriodicPension = foldBonus ? "0" : deduction("pension_f_bonus");
  // Annual-room year-to-date legs exclude the current period's earlier runs
  // (they rejoin through the period legs above); the non-periodic history
  // legs exclude them too, since the combined call already counts them.
  // Unit-constructed contexts omit year-to-date legs the engine always
  // provides; absent reads as zero, exactly as the guide engine does.
  const roomYtd = (value: string | undefined, prior: string): string => add(value ?? "0", neg(prior));
  const ytdCpp = roomYtd(ytd.cpp, priorFactor("C"));
  const ytdCpp2 = roomYtd(ytd.cpp2, priorFactor("C2"));
  const ytdEi = roomYtd(ytd.ei, priorFactor("EI"));
  const ytdQpip = roomYtd(ytd.qpip, priorFactor("QPIP"));
  const ytdQpipEmployer = roomYtd(ytd.qpip_employer, priorFactor("QPIP_ER"));
  const ytdPensionable = roomYtd(ytd.pensionable, priors.pensionable);
  const ytdNonPeriodic = roomYtd(ytd.non_periodic, priorFactor("B"));
  const ytdNonPeriodicPension = roomYtd(ytd.pension_deductions_bonus, priorFactor("F3"));
  const ytdNonPeriodicEnhanced = roomYtd(ytd.f5b, priorFactor("F5B"));

  const cumulative=await cumulativeHistory(ctx);
  if (cumulative?.averaging && hasPriors) {
    throw new PayrollPackError(
      `cumulative averaging cannot combine with a supplemental-period share for ${employeePartyId} — `
      + "process the period's pay in a single run while cumulative averaging is elected",
    );
  }
  const t4127Input: T4127Input = {
    averaging:cumulative?.averaging,
    pensionableNonPeriodic: foldBonus ? "0" : ctx.pensionableNonPeriodic,
    insurableNonPeriodic: foldBonus ? "0" : ctx.insurableNonPeriodic,
    qpipNonPeriodic: foldBonus ? "0" : ctx.programNonPeriodicBases?.qpip,
    payDate: run.pay_date!, province: region as Province, periodsPerYear: P,
    income: taxIncome, nonPeriodic: taxNonPeriodic,
    pensionable: periodPensionable, insurable: periodInsurable, qpipInsurable: periodQpipInsurable, eiEmployerMultiple,
    pensionDeductions: taxPensionDeductions,
    alimonyDeductions: taxAlimony,
    nonPeriodicPensionDeductions: taxNonPeriodicPension,
    unionDues: taxUnionDues,
    labourFundsCreditFederal: region === "QC"
      ? mulPercent(
        add(ftqSharesPerPeriod, fondactionSharesPerPeriod),
        mulDecimal(ratesForPayDate(run.pay_date!).federal.lcf.rate, "100"), 2,
      )
      : undefined,
    prescribedZoneDeduction: empFact("CA", emp, "prescribed_zone_deduction") ?? undefined,
    authorizedAnnualDeductions: empFact("CA", emp, "authorized_annual_deductions") ?? undefined,
    authorizedFederalCredits: empFact("CA", emp, "authorized_federal_credits") ?? undefined,
    authorizedProvincialCredits: empFact("CA", emp, "authorized_provincial_credits") ?? undefined,
    additionalTaxPerPeriod: empFact("CA", emp, "additional_tax_per_period") ?? undefined,
    ...ontarioDependantInputs,
    federalClaim: empFact("CA", emp, "federal_claim_amount") ?? undefined,
    federalClaimCode: empFact("CA", emp, "federal_claim_amount") == null && empFact("CA", emp, "federal_claim_code") != null
      ? Number(empFact("CA", emp, "federal_claim_code")) : undefined,
    provincialClaim: empFact("CA", emp, "provincial_claim_amount") ?? undefined,
    provincialClaimCode: empFact("CA", emp, "provincial_claim_amount") == null && empFact("CA", emp, "provincial_claim_code") != null
      ? Number(empFact("CA", emp, "provincial_claim_code")) : undefined,
    taxExempt: bool(empFact("CA", emp, "tax_exempt")),
    cppExempt: bool(empFact("CA", emp, "cpp_exempt")),
    eiExempt: bool(empFact("CA", emp, "ei_exempt")),
    ytd: {
      cpp: ytdCpp, cpp2: ytdCpp2, ei: ytdEi, qpip: ytdQpip, qpipEmployer: ytdQpipEmployer,
      pensionable: ytdPensionable, nonPeriodic: ytdNonPeriodic,
      nonPeriodicPensionDeductions: ytdNonPeriodicPension,
      nonPeriodicCppEnhancedDeductions: ytdNonPeriodicEnhanced,
      ...(cumulative?.bonusYtd??{}),
    },
  };
  // Call 1 — contributions on the period-to-date base (always). Its tax
  // outputs serve the cumulative method; the per-run method prices tax in
  // call 2 below and discards these.
  const statutory = calculateT4127(t4127Input);

  // This run's share of each combined amount: the period total minus what
  // earlier runs of the period already withheld. Each stub traces its share,
  // so the next run's priors telescope to the period total exactly.
  const cpp = nonNegative(add(statutory.cpp, neg(priorFactor("C"))));
  const cpp2 = nonNegative(add(statutory.cpp2, neg(priorFactor("C2"))));
  const cppEmployer = add(cpp, cpp2);
  const ei = nonNegative(add(statutory.ei, neg(priorFactor("EI"))));
  const eiEmployer = nonNegative(add(statutory.eiEmployer, neg(priorFactor("EI_ER"))));
  const qpip = nonNegative(add(statutory.qpip, neg(priorFactor("QPIP"))));
  const qpipEmployer = nonNegative(add(statutory.qpipEmployer, neg(priorFactor("QPIP_ER"))));

  // Call 2 — income tax with each run taxed as its own periodic pay (T4127
  // Option 1 on this run's income alone, annualized by P). The K2 credits
  // and the F5 deduction price off what this run actually withheld (the
  // shares above), not a standalone recomputation: only the credits follow
  // the period, never the income. Annual maxima still read the full
  // year-to-date, so a max reached with this run caps the credit exactly as
  // the guide states.
  const standaloneTax = supplementalMethod === "per_run" && hasPriors
    ? calculateT4127({
      ...t4127Input,
      averaging: undefined,
      income, nonPeriodic,
      pensionable, insurable, qpipInsurable,
      pensionableNonPeriodic: ctx.pensionableNonPeriodic,
      insurableNonPeriodic: ctx.insurableNonPeriodic,
      qpipNonPeriodic: ctx.programNonPeriodicBases?.qpip,
      pensionDeductions: deduction("pension_f"),
      alimonyDeductions: deduction("alimony"),
      nonPeriodicPensionDeductions: deduction("pension_f_bonus"),
      unionDues: deduction("union_dues"),
      cppWithheld: cpp,
      cpp2Withheld: cpp2,
      eiWithheld: ei,
      qpipWithheld: qpip,
      ytd: {
        cpp: ytd.cpp, cpp2: ytd.cpp2, ei: ytd.ei, qpip: ytd.qpip,
        qpipEmployer: ytd.qpip_employer, pensionable: ytd.pensionable,
        nonPeriodic: ytd.non_periodic,
        nonPeriodicPensionDeductions: ytd.pension_deductions_bonus,
        nonPeriodicCppEnhancedDeductions: ytd.f5b,
        ...(cumulative?.bonusYtd ?? {}),
      },
    })
    : null;
  // The enhanced-CPP deduction splits periodic/bonus by the CURRENT call's
  // bonus share; this run traces its own share so a third run telescopes.
  // Under the fold the whole period is periodic, so this run absorbs the
  // earlier runs' bonus share into its periodic share.
  const f5a = nonNegative(add(add(statutory.f5A, neg(priorFactor("F5A"))), neg(foldBonus ? priorFactor("F5B") : "0")));
  const f5b = foldBonus ? "0" : nonNegative(add(statutory.f5B, neg(priorFactor("F5B"))));
  const f5 = add(f5a, f5b);
  const federalTax = standaloneTax !== null
    ? standaloneTax.totalTax
    : hasPriors && supplementalMethod === "period_cumulative"
      ? nonNegative(add(statutory.totalTax, neg(priorFederalTax)))
      : statutory.totalTax;

  pushStatutory("income_tax", "deduction", "Income tax", federalTax, 110);
  pushStatutory("cpp", "deduction", region === "QC" ? "QPP" : "CPP", cpp, 120);
  pushStatutory("cpp2", "deduction", region === "QC" ? "QPP2" : "CPP2", cpp2, 130);
  pushStatutory("ei", "deduction", "EI", ei, 140);
  pushStatutory("qpip", "deduction", "QPIP", qpip, 150);
  pushStatutory("cpp", "employer_contribution",
    region === "QC" ? "QPP (employer)" : "CPP (employer)", cppEmployer, 210);
  pushStatutory("ei", "employer_contribution", "EI (employer)", eiEmployer, 220);
  pushStatutory("qpip", "employer_contribution", "QPIP (employer)", qpipEmployer, 230);

  let qcFactors: Record<string, string> = {};
  if (region === "QC") {
    const qc = calculateTp1015({
      payDate: run.pay_date!, periodsPerYear: P,
      income: taxIncome, nonPeriodic: taxNonPeriodic,
      pensionDeductions: taxPensionDeductions,
      nonPeriodicPensionDeductions: taxNonPeriodicPension,
      // The period's QPP under the fold (the whole period is one pay);
      // this run's share otherwise, which keeps a standalone provincial
      // calculation on its own contributions. The pensionable salary follows
      // the same split: the period's under the fold, this run's otherwise.
      qpp: foldBonus ? statutory.cpp : cpp, qpp2: foldBonus ? statutory.cpp2 : cpp2,
      pensionable: foldBonus ? periodPensionable : pensionable,
      personalCredits: empFact("CA", emp, "provincial_claim_amount") ?? undefined,
      ftqSharesPerPeriod,
      fondactionSharesPerPeriod,
      authorizedAnnualCredits: empFact("CA", emp, "authorized_provincial_credits") ?? undefined,
      taxExempt: bool(empFact("CA", emp, "tax_exempt")),
      ytd: {
        nonPeriodic: foldBonus ? roomYtd(ytd.non_periodic, priorFactor("B")) : ytd.non_periodic,
        csb: foldBonus ? roomYtd(ytd.qc_csb, priorFactor("QC_CSB")) : ytd.qc_csb,
      },
    });
    const provincialTax = supplementalMethod === "per_run"
      ? qc.totalTax
      : hasPriors
        ? nonNegative(add(qc.totalTax, neg(priorProvincialTax)))
        : qc.totalTax;
    pushStatutory("qc_income_tax", "deduction", "Québec income tax", provincialTax, 115);
    qcFactors = qc.factors;
  }

  // The trace shows the tax computation's own factors (the standalone call
  // under the per-run method), with this run's contribution shares swapped
  // in: each stub traces its share, never the period total.
  const taxFactors = standaloneTax?.factors ?? statutory.factors;
  return {
    ...taxFactors,
    ...qcFactors,
    B: nonPeriodic, I: income, PI: pensionable, IE: insurable,
    F:deduction("pension_f"),F2:deduction("alimony"),U1:deduction("union_dues"),F3:deduction("pension_f_bonus"),
    C: cpp, C2: cpp2, EI: ei, QPIP: qpip, QPIP_ER: qpipEmployer, EI_ER: eiEmployer,
    F5: f5, F5A: f5a, F5B: f5b,
    ...(hasPriors || foldBonus ? { T: federalTax } : {}),
    CA_PE:add(pensionable,neg(ctx.pensionableNonPeriodic??"0")),CA_IE:add(insurable,neg(ctx.insurableNonPeriodic??"0")),
    CA_QPIP_PE:add(qpipInsurable,neg(ctx.programNonPeriodicBases?.qpip??"0")),
    CA_BPE:ctx.pensionableNonPeriodic??"0",CA_BIE:ctx.insurableNonPeriodic??"0",CA_BQPIP:ctx.programNonPeriodicBases?.qpip??"0",
    CA_T_BASE: (hasPriors || foldBonus)
      ? nonNegative(add(federalTax, neg(t4127Input.additionalTaxPerPeriod ?? "0")))
      : add(statutory.periodicTax,neg(t4127Input.additionalTaxPerPeriod??"0")),
    ...(cmp(wcbAssessable, "0") > 0 ? { WCB: wcbAmount, WCB_EARN: wcbAssessable } : {}),
    ...(cmp(ehtEarnings, "0") > 0 ? { EHT: ehtAmount, EHT_EARN: ehtEarnings } : {}),
    ...(cmp(hsfEarnings, "0") > 0 ? { HSF: hsfAmount, HSF_EARN: hsfEarnings } : {}),
    ...(cmp(cntEarnings, "0") > 0 ? { CNT: cntAmount, CNT_EARN: cntEarnings } : {}),
  };
}
