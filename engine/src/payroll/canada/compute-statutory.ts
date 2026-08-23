import { sql } from "drizzle-orm";
import { cmp, sum } from "../../money.ts";
import { calculateT4127, type T4127Input } from "./t4127.ts";
import { calculateTp1015 } from "./quebec/tp1015.ts";
import type { Province } from "./rates.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";

type YtdRow = {
  pensionable: string;
  insurable: string;
  cpp: string;
  cpp2: string;
  ei: string;
  qpip: string;
  non_periodic: string;
  f5b: string;
  qc_csb: string;
};

async function employeeYtd(
  ctx: Pick<PayrollStatutoryComputeContext, "tx" | "orgId" | "employeePartyId" | "taxYear" | "documentId">,
): Promise<YtdRow> {
  const { tx, orgId, employeePartyId, taxYear, documentId } = ctx;
  const r = (await tx.execute<YtdRow>(sql`
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
      coalesce((select non_periodic_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'B')::numeric), 0) as non_periodic,
      coalesce(sum((s.factors->>'F5B')::numeric), 0) as f5b,
      coalesce(sum((s.factors->>'QC_CSB')::numeric), 0) as qc_csb
    from pay_stubs s
    join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
    join documents d on d.id = r.document_id and d.org_id = r.org_id
    where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
      and s.tax_year = ${taxYear} and s.pay_run_document_id <> ${documentId}
      and r.run_status in ('calculated', 'committed')
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
  const { wcbAmount, wcbAssessable, ehtAmount, ehtEarnings } = employerLevies;

  assertRegionSupported(region);

  const ytd = await employeeYtd({ tx, orgId, employeePartyId, taxYear, documentId });

  const t4127Input: T4127Input = {
    payDate: run.pay_date, province: region as Province, periodsPerYear: P,
    income, nonPeriodic, pensionable, insurable,
    pensionDeductions: deduction("pension_f"),
    alimonyDeductions: deduction("alimony"),
    unionDues: deduction("union_dues"),
    prescribedZoneDeduction: emp.prescribed_zone_deduction ?? undefined,
    authorizedAnnualDeductions: emp.authorized_annual_deductions ?? undefined,
    authorizedFederalCredits: emp.authorized_federal_credits ?? undefined,
    authorizedProvincialCredits: emp.authorized_provincial_credits ?? undefined,
    additionalTaxPerPeriod: emp.additional_tax_per_period ?? undefined,
    federalClaim: emp.federal_claim_amount ?? undefined,
    federalClaimCode: emp.federal_claim_amount == null && emp.federal_claim_code != null
      ? Number(emp.federal_claim_code) : undefined,
    provincialClaim: emp.provincial_claim_amount ?? undefined,
    provincialClaimCode: emp.provincial_claim_amount == null && emp.provincial_claim_code != null
      ? Number(emp.provincial_claim_code) : undefined,
    taxExempt: bool(emp.tax_exempt),
    cppExempt: bool(emp.cpp_exempt),
    eiExempt: bool(emp.ei_exempt),
    ytd: {
      cpp: ytd.cpp, cpp2: ytd.cpp2, ei: ytd.ei, qpip: ytd.qpip,
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
      payDate: run.pay_date, periodsPerYear: P,
      income, nonPeriodic,
      pensionDeductions: deduction("pension_f"),
      qpp: statutory.cpp, qpp2: statutory.cpp2,
      pensionable,
      personalCredits: emp.provincial_claim_amount ?? undefined,
      authorizedAnnualCredits: emp.authorized_provincial_credits ?? undefined,
      taxExempt: bool(emp.tax_exempt),
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
  };
}
