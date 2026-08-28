import { sql } from "drizzle-orm";
import { PayrollError } from "../../payroll-error.ts";
import { sum } from "../../money.ts";
import {
  certificateSubRegions,
  packCertificates,
} from "../certificates.ts";
import { blockingGaps, resolveWithholding } from "../withholding-resolution.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { calculatePub15T } from "./pub15t.ts";
import { computeUsWithholding, usSubRegionRateIndex } from "./withholding.ts";
import { usPayrollConfig } from "./config.ts";

type UsYtdRow = {
  fica: string;
  futa: string;
  supplemental: string;
  fica_tax: string;
};

async function usEmployeeYtd(
  ctx: Pick<PayrollStatutoryComputeContext, "tx" | "orgId" | "employeePartyId" | "taxYear" | "documentId">,
): Promise<UsYtdRow> {
  const { tx, orgId, employeePartyId, taxYear, documentId } = ctx;
  const r = (await tx.execute<UsYtdRow>(sql`
    select
      coalesce((select pensionable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.pensionable_earnings), 0) as fica,
      coalesce((select insurable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.insurable_earnings), 0) as futa,
      coalesce((select non_periodic_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'B')::numeric), 0) as supplemental,
      coalesce(sum((s.factors->>'SS')::numeric), 0)
      + coalesce(sum((s.factors->>'MED')::numeric), 0)
      + coalesce(sum((s.factors->>'MED2')::numeric), 0) as fica_tax
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

/** Phase 9 — US pack statutory pass (Pub 15-T + state/local withholding). */
export async function computeUsStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const {
    tx, orgId, documentId, employeePartyId, employeeName, taxYear, country, region,
    run, emp, filingAccountId, periodsPerYear: P, income, nonPeriodic, pensionable,
    insurable, pushStatutory, storedCertificates, certificateFor, bool, assertRegionSupported,
  } = ctx;

  assertRegionSupported(region);
  const config = await usPayrollConfig(orgId, taxYear);
  const ytd = await usEmployeeYtd({ tx, orgId, employeePartyId, taxYear, documentId });
  const filingStatus = (emp.filing_status ?? "single") as "single" | "married_joint" | "head_household";
  const statutory = calculatePub15T({
    payDate: run.pay_date!, periodsPerYear: P,
    wages: income, supplemental: nonPeriodic,
    ficaWages: pensionable, futaWages: insurable,
    filingStatus,
    multipleJobs: bool(emp.multiple_jobs),
    dependentCredits: emp.dependent_credits ?? undefined,
    otherIncomeAnnual: emp.other_income_annual ?? undefined,
    deductionsAnnual: emp.deductions_annual ?? undefined,
    extraPerPeriod: emp.additional_tax_per_period ?? undefined,
    pre2020: bool(emp.w4_pre_2020)
      ? { allowances: Number(emp.w4_allowances ?? 0), married: filingStatus === "married_joint" }
      : undefined,
    fitExempt: bool(emp.tax_exempt),
    ficaExempt: bool(emp.fica_exempt),
    futaExempt: bool(emp.futa_exempt),
    futaEffectiveRate: config.futaRate(region) ?? undefined,
    sui: config.sui(region, filingAccountId),
    ytd: {
      ssWages: ytd.fica, medicareWages: ytd.fica,
      futaWages: ytd.futa, suiWages: ytd.futa,
      supplemental: ytd.supplemental,
    },
  });
  pushStatutory("fit", "deduction", "Federal income tax", statutory.fit, 110);
  pushStatutory("ss", "deduction", "Social Security", statutory.ss, 120);
  pushStatutory("medicare", "deduction", "Medicare", statutory.medicare, 130);
  pushStatutory("medicare_addl", "deduction", "Additional Medicare", statutory.additionalMedicare, 135);
  pushStatutory("ss", "employer_contribution", "Social Security (employer)", statutory.ssEmployer, 210);
  pushStatutory("medicare", "employer_contribution", "Medicare (employer)", statutory.medicareEmployer, 220);
  pushStatutory("futa", "employer_contribution", "Federal unemployment (FUTA)", statutory.futa, 230);
  pushStatutory("suta", "employer_contribution", "State unemployment (SUI)", statutory.suta, 250);
  let factors: Record<string, string> = {
    ...statutory.factors,
    B: nonPeriodic, I: income, PI: pensionable, IE: insurable,
  };

  const certificateKeysOnFile = (): string[] =>
    storedCertificates
      .filter((row) => !row.effectiveFrom || row.effectiveFrom <= run.pay_date!)
      .filter((row) => !row.supersededOn || row.supersededOn > run.pay_date!)
      .map((row) => row.certificateKey);

  const subRegionsOnFile = (side: "work" | "residence"): string[] => {
    const sideRegion = side === "work"
      ? region
      : ((emp.residence_region as string | null) || region);
    const codes: string[] = [];
    for (const certificate of packCertificates(country).certificates) {
      if (!certificate.fields.some((field) => field.subRegion?.side === side)) continue;
      if ((certificate.scope.region ?? sideRegion) !== sideRegion) continue;
      const resolved = certificateFor(certificate.key);
      if (!resolved) continue;
      for (const found of certificateSubRegions(resolved)) {
        if (found.side === side && !codes.includes(found.code)) codes.push(found.code);
      }
    }
    return codes;
  };

  const workSubRegions = subRegionsOnFile("work");
  const residenceSubRegions = subRegionsOnFile("residence");
  const residenceRegion = (emp.residence_region as string | null) || region;
  const resolution = resolveWithholding({
    country,
    workRegion: region,
    residenceRegion: (emp.residence_region as string | null) ?? null,
    workSubRegions,
    residenceSubRegions,
    certificatesOnFile: certificateKeysOnFile(),
    subRegionRates: usSubRegionRateIndex({
      codes: [
        ...workSubRegions.map((code) => ({ region, code })),
        ...residenceSubRegions.map((code) => ({ region: residenceRegion, code })),
      ],
      tenantRates: config.subRegionRates,
    }),
  });

  const blocking = blockingGaps(resolution);
  if (blocking.length > 0) {
    throw new PayrollError(
      `${employeeName}: ${blocking.map((gap) => gap.message).join(" ")}`,
    );
  }

  let regionTax: string | undefined;
  let sequence = 140;
  for (const levy of resolution.levies) {
    const withheld = computeUsWithholding({
      levy,
      payDate: run.pay_date!,
      periodStart: run.period_start!,
      periodEnd: run.period_end!,
      periodsPerYear: P,
      wages: income,
      supplemental: nonPeriodic,
      certificateFor,
      regionTax,
      socialInsuranceDeducted: {
        period: sum([statutory.ss, statutory.medicare, statutory.additionalMedicare]),
        yearToDate: ytd.fica_tax,
      },
      tenantRates: (rateKey, subRegion) =>
        config.subRegionRates(rateKey, levy.region, subRegion),
    });
    if (!withheld) continue;
    if (levy.level === "region") regionTax = withheld.tax;
    pushStatutory(
      levy.level === "region" ? "state_income_tax" : "local_income_tax",
      "deduction", withheld.label, withheld.tax, sequence++,
    );
    factors = {
      ...factors,
      ...withheld.factors,
      [`${levy.level === "region" ? "SIT" : "LIT"}_${withheld.code}`]: withheld.tax,
    };
  }
  factors.WITHHOLDING_RESIDENCE = resolution.residenceRegion;
  factors.WITHHOLDING_RESIDENCE_SOURCE = resolution.residenceSource;
  return factors;
}
