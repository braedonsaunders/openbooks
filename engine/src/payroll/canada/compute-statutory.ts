import { sql } from "drizzle-orm";
import { cmp } from "../../money/money.ts";
import { empFact } from "../employee-facts.ts";
// Side effect: registers CA_EMPLOYEE_FACTS, so every read below resolves
// through the declaration in every import graph — never via a transitive
// side effect of the pack registry.
import "./employee-facts.ts";
import { calculateT4127, type T4127Input } from "./t4127.ts";
import { calculateTp1015 } from "./quebec/tp1015.ts";
import type { Province } from "./rates.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { CA_OPENING_YTD_FIELDS } from "./opening-ytd.ts";

/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass stamps itself (the payroll inputs, the employer-side
 * shares, and the employer-levy factors). The T4127 and TP-1015 letters
 * live beside their engines.
 */
export const CA_COMPUTE_FACTOR_LABELS: Readonly<Record<string, string>> = {
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

/** Phase 9 — CA pack statutory pass (T4127 + Québec TP-1015). */
export async function computeCaStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const {
    tx, orgId, documentId, employeePartyId, taxYear, region, run, emp,
    periodsPerYear: P, income, nonPeriodic, pensionable, insurable, deduction,
    pushStatutory, bool, assertRegionSupported, employerLevies,
  } = ctx;
  // The QPIP program's own insurable base — never the EI leg. Absent only on
  // unit-constructed contexts, where it reads the `insurable` leg (legacy
  // math, bit-identical); the engine always provides it via the pack's
  // declared contribution program.
  const qpipInsurable = ctx.programBases?.["qpip"] ?? insurable;
  const { wcbAmount, wcbAssessable, ehtAmount, ehtEarnings, hsfAmount, hsfEarnings } = employerLevies;

  assertRegionSupported(region);

  const ytd = await employeeYtd({ tx, orgId, employeePartyId, taxYear, documentId });

  const t4127Input: T4127Input = {
    payDate: run.pay_date!, province: region as Province, periodsPerYear: P,
    income, nonPeriodic, pensionable, insurable, qpipInsurable,
    pensionDeductions: deduction("pension_f"),
    alimonyDeductions: deduction("alimony"),
    unionDues: deduction("union_dues"),
    prescribedZoneDeduction: empFact("CA", emp, "prescribed_zone_deduction") ?? undefined,
    authorizedAnnualDeductions: empFact("CA", emp, "authorized_annual_deductions") ?? undefined,
    authorizedFederalCredits: empFact("CA", emp, "authorized_federal_credits") ?? undefined,
    authorizedProvincialCredits: empFact("CA", emp, "authorized_provincial_credits") ?? undefined,
    additionalTaxPerPeriod: empFact("CA", emp, "additional_tax_per_period") ?? undefined,
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
      cpp: ytd.cpp, cpp2: ytd.cpp2, ei: ytd.ei, qpip: ytd.qpip, qpipEmployer: ytd.qpip_employer,
      pensionable: ytd.pensionable, nonPeriodic: ytd.non_periodic,
      nonPeriodicCppEnhancedDeductions: ytd.f5b,
    },
  };
  const statutory = calculateT4127(t4127Input);

  pushStatutory("income_tax", "deduction", "Income tax", statutory.totalTax, 110);
  pushStatutory("cpp", "deduction", region === "QC" ? "QPP" : "CPP", statutory.cpp, 120);
  pushStatutory("cpp2", "deduction", region === "QC" ? "QPP2" : "CPP2", statutory.cpp2, 130);
  pushStatutory("ei", "deduction", "EI", statutory.ei, 140);
  pushStatutory("qpip", "deduction", "QPIP", statutory.qpip, 150);
  pushStatutory("cpp", "employer_contribution",
    region === "QC" ? "QPP (employer)" : "CPP (employer)", statutory.cppEmployer, 210);
  pushStatutory("ei", "employer_contribution", "EI (employer)", statutory.eiEmployer, 220);
  pushStatutory("qpip", "employer_contribution", "QPIP (employer)", statutory.qpipEmployer, 230);

  let qcFactors: Record<string, string> = {};
  if (region === "QC") {
    const qc = calculateTp1015({
      payDate: run.pay_date!, periodsPerYear: P,
      income, nonPeriodic,
      pensionDeductions: deduction("pension_f"),
      qpp: statutory.cpp, qpp2: statutory.cpp2,
      pensionable,
      personalCredits: empFact("CA", emp, "provincial_claim_amount") ?? undefined,
      authorizedAnnualCredits: empFact("CA", emp, "authorized_provincial_credits") ?? undefined,
      taxExempt: bool(empFact("CA", emp, "tax_exempt")),
      ytd: { nonPeriodic: ytd.non_periodic, csb: ytd.qc_csb },
    });
    pushStatutory("qc_income_tax", "deduction", "Québec income tax", qc.totalTax, 115);
    qcFactors = qc.factors;
  }

  return {
    ...statutory.factors,
    ...qcFactors,
    B: nonPeriodic, I: income, PI: pensionable, IE: insurable,
    QPIP: statutory.qpip, EI_ER: statutory.eiEmployer, QPIP_ER: statutory.qpipEmployer,
    ...(cmp(wcbAssessable, "0") > 0 ? { WCB: wcbAmount, WCB_EARN: wcbAssessable } : {}),
    ...(cmp(ehtEarnings, "0") > 0 ? { EHT: ehtAmount, EHT_EARN: ehtEarnings } : {}),
    ...(cmp(hsfEarnings, "0") > 0 ? { HSF: hsfAmount, HSF_EARN: hsfEarnings } : {}),
  };
}
