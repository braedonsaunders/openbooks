import { sql } from "drizzle-orm";
import { PayrollError } from "../error.ts";
import { sum } from "../../money/money.ts";
import { empFact } from "../employee-facts.ts";
// Side effect: registers US_EMPLOYEE_FACTS, so every read below resolves
// through the declaration in every import graph — never via a transitive
// side effect of the pack registry.
import "./employee-facts.ts";
import {
  certificateSubRegions,
  packCertificates,
} from "../certificates.ts";
import { advisoryGaps, blockingGaps, resolveWithholding } from "../withholding-resolution.ts";
import { subRegionLevy } from "../withholding-jurisdictions.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { calculatePub15T } from "./pub15t.ts";
import {
  computeUsEmployerWithholding, computeUsWithholding, usSubRegionRateIndex,
} from "./withholding.ts";
import { usPayrollConfig } from "./config.ts";
import { US_OPENING_YTD_FIELDS } from "./opening-ytd.ts";

export type UsYtdRow = {
  fica: string;
  futa: string;
  suiCurrentRegion: string;
  suiOtherRegions: string;
  suiOpeningUnscoped: boolean;
  supplemental: string;
  fica_tax: string;
};

/** Resolve the SUI wage-base history only when every prior wage has known
 * state provenance. Transfer credits differ by state: Oregon permits prior
 * taxable wages from other states to limit its base (UI PUB 217,
 * https://www.oregon.gov/employ/Businesses/Documents/Tax/uipub217.pdf), and
 * California has a same-year out-of-state wage credit on employee transfer
 * (EDD Employer's Guide, https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de44.pdf).
 * The shared FUTA base cannot determine either state's SUI credit. */
export function resolveUsSuiYtd(
  region: string,
  ytd: Pick<UsYtdRow, "suiCurrentRegion" | "suiOtherRegions" | "suiOpeningUnscoped">,
): string {
  if (ytd.suiOtherRegions || ytd.suiOpeningUnscoped) {
    const priorStates = ytd.suiOtherRegions || "an opening balance without state allocation";
    throw new PayrollError(
      `US SUI cannot be calculated for ${region}: prior insurable wages are recorded in ${priorStates}, ` +
      "and state transfer credits require state-account wage history and eligibility. Complete the state-scoped SUI wage history before calculating this run; FUTA wages are not an SUI substitute.",
    );
  }
  return ytd.suiCurrentRegion;
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass stamps itself (the payroll inputs plus the withholding
 * resolution it resolved). The engine trace keys live beside their engines
 * (Pub 15-T, the state files, withholding.ts).
 */
export const US_COMPUTE_FACTOR_LABELS: Readonly<Record<string, string>> = {
  B: "Bonus / non-periodic pay this period",
  I: "Periodic income this period",
  PI: "Pensionable earnings this period",
  IE: "Insurable earnings this period",
  WITHHOLDING_RESIDENCE: "Withholding residence region",
  WITHHOLDING_RESIDENCE_SOURCE: "Withholding residence source",
  WITHHOLDING_ADVISORY: "Withholding advisory — collect the named form",
};

/**
 * Read the employee's year-to-date statutory inputs from committed payroll.
 * Calculated runs are drafts and may be abandoned; counting them would let
 * unpaid figures consume FICA/FUTA/SUI room in a later run.
 */
export async function usEmployeeYtd(
  ctx: Pick<PayrollStatutoryComputeContext, "tx" | "orgId" | "employeePartyId" | "taxYear" | "documentId">,
  region: string,
): Promise<UsYtdRow> {
  const { tx, orgId, employeePartyId, taxYear, documentId } = ctx;
  const ficaWithheldColumn = US_OPENING_YTD_FIELDS.find((field) => field.key === "ficaWithheldYtd")!.column;
  const r = (await tx.execute<UsYtdRow>(sql`
    select
      coalesce((select pensionable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.pensionable_earnings), 0) as fica,
      coalesce((select insurable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.insurable_earnings), 0) as futa,
      coalesce((select insurable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0) > 0 as "suiOpeningUnscoped",
      coalesce(sum(s.insurable_earnings) filter (where s.province = ${region}), 0)::text as "suiCurrentRegion",
      coalesce(string_agg(distinct s.province, ', ' order by s.province)
        filter (where s.province <> ${region} and s.insurable_earnings > 0), '') as "suiOtherRegions",
      coalesce((select non_periodic_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'B')::numeric), 0) as supplemental,
      coalesce((select ${sql.raw(ficaWithheldColumn)} from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'SS')::numeric), 0)
      + coalesce(sum((s.factors->>'MED')::numeric), 0)
      + coalesce(sum((s.factors->>'MED2')::numeric), 0) as fica_tax
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

/** Phase 9 — US pack statutory pass (Pub 15-T + state/local withholding). */
export async function computeUsStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const {
    tx, orgId, documentId, employeePartyId, employeeName, taxYear, country, region,
    run, emp, filingAccountId, periodsPerYear: P, income, nonPeriodic, pensionable,
    insurable, employerEmployeeCount, reducedBases, deduction, pushStatutory, storedCertificates, certificateFor, bool,
    assertRegionSupported,
  } = ctx;

  assertRegionSupported(region);
  // FIT prices the income leg AFTER pack-declared pre-tax treatments:
  // §125 cafeteria and 401(k) elective deferrals reduce FIT-able wages but
  // NOT Social Security or Medicare wages, so the Pub 15-T wages leg reads
  // the reduced base while the FICA/FUTA legs below pass through untouched
  // (the AU salary-sacrifice shape: PAYG moves, superannuation does not).
  const fitWages = reducedBases.income;
  const config = await usPayrollConfig(orgId, taxYear, run.pay_date);
  const ytd = await usEmployeeYtd({ tx, orgId, employeePartyId, taxYear, documentId }, region);
  const sui = config.sui(region, filingAccountId);
  const suiWagesYtd = sui ? resolveUsSuiYtd(region, ytd) : "0";
  const filingStatus = (empFact("US", emp, "filing_status") ?? "single") as "single" | "married_joint" | "head_household";
  const statutory = calculatePub15T({
    payDate: run.pay_date!, periodsPerYear: P,
    wages: fitWages, supplemental: nonPeriodic,
    ficaWages: pensionable, futaWages: insurable,
    filingStatus,
    multipleJobs: bool(empFact("US", emp, "multiple_jobs")),
    dependentCredits: empFact("US", emp, "dependent_credits") ?? undefined,
    otherIncomeAnnual: empFact("US", emp, "other_income_annual") ?? undefined,
    deductionsAnnual: empFact("US", emp, "deductions_annual") ?? undefined,
    extraPerPeriod: empFact("US", emp, "additional_tax_per_period") ?? undefined,
    pre2020: bool(empFact("US", emp, "w4_pre_2020"))
      ? { allowances: Number(empFact("US", emp, "w4_allowances") ?? 0), married: filingStatus === "married_joint" }
      : undefined,
    fitExempt: bool(empFact("US", emp, "tax_exempt")),
    ficaExempt: bool(empFact("US", emp, "fica_exempt")),
    futaExempt: bool(empFact("US", emp, "futa_exempt")),
    futaEffectiveRate: config.futaRate(region) ?? undefined,
    sui,
    ytd: {
      ssWages: ytd.fica, medicareWages: ytd.fica,
      futaWages: ytd.futa, suiWages: suiWagesYtd,
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
    // The trace factor moves with the base it prices: I is the FIT-able
    // periodic wage, so it reads the reduced leg, not the reported gross.
    B: nonPeriodic, I: fitWages, PI: pensionable, IE: insurable,
  };

  const certificateKeysOnFile = (): string[] =>
    storedCertificates
      .filter((row) => !row.effectiveFrom || row.effectiveFrom <= run.pay_date!)
      .filter((row) => !row.supersededOn || row.supersededOn > run.pay_date!)
      .map((row) => row.certificateKey);

  const subRegionsOnFile = (side: "work" | "residence"): string[] => {
    const sideRegion = side === "work"
      ? region
      : ((empFact("US", emp, "residence_region") as string | null) || region);
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
  const residenceRegion = (empFact("US", emp, "residence_region") as string | null) || region;
  const resolution = resolveWithholding({
    country,
    workRegion: region,
    residenceRegion: (empFact("US", emp, "residence_region") as string | null) ?? null,
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
  const advisory = advisoryGaps(resolution);
  if (blocking.length > 0) {
    // The operator hitting a blocking refusal on a cross-border employee
    // still needs the missing reciprocity form named: the refusal teaches the
    // blocking rule, and without this the form that changes the answer stays
    // hidden. Worded for the refused run — no claim about what is withheld,
    // because nothing was.
    const unclaimed = advisory.length > 0
      && resolution.agreement?.taxedBy === "residence"
      && resolution.agreement.certificateKey
      ? ` In addition, the ${resolution.workRegion}/${resolution.residenceRegion} reciprocity`
        + ` agreement is unclaimed (${resolution.agreement.certificateKey} is not on file): once`
        + " the above is resolved, collecting the form moves withholding to the residence region."
      : "";
    throw new PayrollError(
      `${employeeName}: ${blocking.map((gap) => gap.message).join(" ")}${unclaimed}`,
    );
  }
  // Advisory gaps reach the operator as named, non-blocking run warnings and
  // on the employee's stub trace — never as silence, and never as a refusal.
  for (const gap of advisory) ctx.noteAdvisory?.(gap.message);
  if (advisory.length > 0) {
    factors.WITHHOLDING_ADVISORY = advisory.map((gap) => gap.message).join(" ");
  }

  let regionTax: string | undefined;
  let sequence = 140;
  // Nebraska's special minimum is measured on gross wages after tax-qualified
  // deductions. The pack's deduction treatment is the authoritative source
  // for which current-period lines qualify; no state-specific component query
  // or floating-point recomputation is introduced here.
  const taxQualifiedDeductions = sum([
    deduction("pension_f"), deduction("union_dues"), deduction("alimony"),
  ]);
  // Employer-pocket levies post below the deduction loop's sequence range:
  // federal employer lines take 210–250, so transit starts at 260.
  let transitSequence = 260;
  for (const levy of resolution.levies) {
    if (levy.level === "sub_region"
      && subRegionLevy(country, levy.region, levy.subRegion!)?.pocket === "employer") {
      // Employer-pocket levies (Oregon transit) accrue at the employer's
      // cost — never out of the cheque. The base is the period's total
      // state-taxable compensation, the same convention the deduction loop
      // prices its levies on; the rate is the district's employer-entered
      // figure, refused by name when absent.
      const employerTax = computeUsEmployerWithholding({
        levy,
        wages: sum([income, nonPeriodic]),
        tenantRates: (rateKey, subRegion) =>
          config.subRegionRates(rateKey, levy.region, subRegion),
      });
      pushStatutory(
        "transit_payroll_tax",
        "employer_contribution", employerTax.label, employerTax.tax, transitSequence++,
      );
      factors = {
        ...factors,
        ...employerTax.factors,
        [`EPT_${employerTax.code}`]: employerTax.tax,
      };
      continue;
    }
    const withheld = computeUsWithholding({
      levy,
      payDate: run.pay_date!,
      periodStart: run.period_start!,
      employerEmployeeCount,
      periodEnd: run.period_end!,
      periodsPerYear: P,
      // State engines price the reported wage under their own transcribed
      // treatment (conformity differs by state — Pennsylvania taxes 401(k)
      // deferrals, most states do not), so only the FIT leg above reads the
      // reduced base. States that honor qualified deductions take them
      // explicitly through taxQualifiedDeductions (the Nebraska minimum).
      wages: income,
      supplemental: nonPeriodic,
      federalIncomeTax: statutory.fit,
      taxQualifiedDeductions,
      certificateFor,
      regionTax,
      // State engines annualize against the year's earlier supplemental pay
      // (Massachusetts' surtax threshold is the live case); without this
      // every bonus withholds as the year's first.
      ytd: { supplemental: ytd.supplemental },
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
