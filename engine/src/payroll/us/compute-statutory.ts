import { sql } from "drizzle-orm";
import { PayrollError } from "../error.ts";
import { U } from "../canada/decimal.ts";
import { add, sum } from "../../money/money.ts";
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
import { regionWithholding, subRegionLevy } from "../withholding-jurisdictions.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { calculatePub15T } from "./pub15t.ts";
import {
  computeUsEmployerWithholding, computeUsWithholding, usSubRegionRateIndex,
} from "./withholding.ts";
import { usPayrollConfig } from "./config.ts";
import { US_OPENING_YTD_FIELDS } from "./opening-ytd.ts";
import { applySuiTransferCredits, suiTransferRuleFor, type SuiPriorStateWages } from "./sui-transfer.ts";
import { w2LocalWageTraceKey } from "./local-wage-trace.ts";
import { resolveUsResidentWithholdingFacts } from "./states/types.ts";
import { requireUsFederalAlienStatus } from "./employee-facts.ts";
import { paUcEmployeeWithholding } from "./states/pa.ts";
import { caEttWithholding } from "./states/ca.ts";
import { coFamliWithholding } from "./states/co.ts";
import { dcOpflWithholding } from "./states/dc.ts";
import { ctPaidLeaveWithholding } from "./states/ct.ts";

export type UsYtdRow = {
  fica: string;
  futa: string;
  suiCurrentRegion: string;
  suiOtherRegions: string;
  suiOpeningUnscoped: boolean;
  /** Other-state committed stub wages by state (exact money), for the gaining state's transfer rule. */
  suiOtherStateWages: Record<string, string>;
  /** Entered per-state SUI carry-in (exact money by state); empty when none was entered. */
  suiOpeningStates: Record<string, string>;
  /** Entered SUI carry-in for the run's own region (exact money, "0" when none). */
  suiOpeningCurrentRegion: string;
  /** Covered Minnesota Paid Leave base priced on committed stubs this year. */
  mnPaidLeaveWages: string;
  supplemental: string;
  regularWageTaxWithheldThisYear: boolean;
  regularWageTaxWithheldKeys: string[];
  fica_tax: string;
  /** LST withheld this year by stub factor key (`LIT_PA-<worksite PSD>-LST`). */
  lstWithheldYtd: Record<string, string>;
};

/** Resolve the SUI wage-base year-to-date for one region.
 *
 * Same-employer wages already in the system — committed stubs in other
 * states, plus the entered per-state carry-in — price automatically under
 * the gaining state's declared transfer rule (see ./sui-transfer.ts): most
 * states credit other-state wages toward the new state's taxable wage base
 * instead of restarting it at zero. Entering a state carry-in row asserts
 * the transfer determination for those wages, so the engine never guesses
 * it. Once any state row exists for the employee-year, SUI reads ONLY the
 * scoped sources; the unscoped opening amount keeps feeding FUTA, which is
 * nationwide and needs no state split.
 *
 * Refusals are input-driven, never permanent: an unscoped opening with no
 * state rows names the carry-in screen as the remedy, and wages a rule does
 * not credit name the state, the rule and its citation. */
export function resolveUsSuiYtd(
  region: string,
  taxYear: number,
  ytd: Pick<
    UsYtdRow,
    "suiCurrentRegion" | "suiOpeningCurrentRegion" | "suiOpeningUnscoped" | "suiOtherStateWages" | "suiOpeningStates"
  >,
): string {
  const openingStates = ytd.suiOpeningStates ?? {};
  const hasOpeningStates = Object.keys(openingStates).length > 0;
  if (ytd.suiOpeningUnscoped && !hasOpeningStates) {
    throw new PayrollError(
      `US SUI cannot be calculated for ${region}: prior insurable wages sit in an opening balance without state allocation. ` +
      `Enter the per-state SUI carry-in in Payroll → Opening balances (one row per state) before calculating this run; FUTA wages are not an SUI substitute.`,
    );
  }
  // Current-region base: committed stubs plus the entered carry-in for this state.
  let base = add(ytd.suiCurrentRegion ?? "0", ytd.suiOpeningCurrentRegion ?? "0");
  // Prior-state wages, stub and carried, price under the gaining state's rule.
  const priors: SuiPriorStateWages[] = [];
  for (const [state, wages] of Object.entries(ytd.suiOtherStateWages ?? {})) {
    if (state === region) continue; // defensive: the map is other-states by construction
    priors.push({ state, wages, year: taxYear });
  }
  for (const [state, wages] of Object.entries(openingStates)) {
    if (state === region) continue; // already in the base above
    priors.push({ state, wages, year: taxYear });
  }
  const { credited, uncreditedStates } = applySuiTransferCredits(region, taxYear, priors);
  base = add(base, credited);
  if (uncreditedStates.length > 0) {
    const rule = suiTransferRuleFor(region);
    throw new PayrollError(
      `US SUI cannot be calculated for ${region}: ${rule.citation} does not credit prior wages paid in ${uncreditedStates.join(", ")}. ` +
      `Record the transfer determination for those wages before calculating this run.`,
    );
  }
  return base;
}

/** Exempt employees owe no SUI, so cross-state history must not refuse their run. */
export function resolveUsSuiYtdForCoverage(
  region: string,
  taxYear: number,
  ytd: Pick<
    UsYtdRow,
    "suiCurrentRegion" | "suiOpeningCurrentRegion" | "suiOpeningUnscoped" | "suiOtherStateWages" | "suiOpeningStates"
  >,
  suiExempt: boolean,
): string {
  return suiExempt ? "0" : resolveUsSuiYtd(region, taxYear, ytd);
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
  STATUTORY_LEVY_RATE: "Published flat rate for a declared levy",
  STATUTORY_LEVY_BASE: "Wage base the declared flat rate applies to",
  STATUTORY_LEVY_TAX: "Tax from the declared flat rate",
  US_RESIDENT_WITHHOLDING_OUTCOME: "Resident withholding outcome vs work-region tax",
  US_RESIDENT_WORK_REGION_TAX_CREDIT: "Work-region tax credited to the residence state",
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
      coalesce((
        select jsonb_object_agg(prior.province, prior.total)
          from (
            select s2.province as province, sum(s2.insurable_earnings)::text as total
              from pay_stubs s2
              join pay_runs r2 on r2.document_id = s2.pay_run_document_id and r2.org_id = s2.org_id
              join documents d2 on d2.id = r2.document_id and d2.org_id = r2.org_id
             where s2.org_id = ${orgId} and s2.employee_party_id = ${employeePartyId}
               and s2.tax_year = ${taxYear} and s2.pay_run_document_id <> ${documentId}
               and r2.run_status = 'committed'
               and d2.status <> 'voided'
               and s2.province <> ${region} and s2.insurable_earnings > 0
             group by s2.province
          ) prior
      ), '{}'::jsonb) as "suiOtherStateWages",
      coalesce((
        select jsonb_object_agg(sw.state, sw.insurable_ytd::text)
          from payroll_opening_sui_wages sw
          join payroll_opening_balances b on b.id = sw.opening_balance_id and b.org_id = sw.org_id
         where b.org_id = ${orgId} and b.employee_party_id = ${employeePartyId} and b.tax_year = ${taxYear}
      ), '{}'::jsonb) as "suiOpeningStates",
      coalesce((
        select sum(sw.insurable_ytd)::text
          from payroll_opening_sui_wages sw
          join payroll_opening_balances b on b.id = sw.opening_balance_id and b.org_id = sw.org_id
         where b.org_id = ${orgId} and b.employee_party_id = ${employeePartyId} and b.tax_year = ${taxYear}
           and sw.state = ${region}
      ), '0') as "suiOpeningCurrentRegion",
      coalesce((select non_periodic_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'B')::numeric), 0) as supplemental,
      coalesce(sum((s.factors->>'mn_paid_leave_BASE')::numeric), 0) as "mnPaidLeaveWages",
      coalesce(bool_or(
        coalesce((s.factors->>'B')::numeric, 0) = 0
        and coalesce((s.factors->>${`SIT_${region}`})::numeric, 0) > 0
      ), false) as "regularWageTaxWithheldThisYear",
      coalesce((
        select array_agg(distinct fact.key)
        from pay_stubs history
        join pay_runs committed_run
          on committed_run.document_id = history.pay_run_document_id
         and committed_run.org_id = history.org_id
        join documents committed_document
          on committed_document.id = committed_run.document_id
         and committed_document.org_id = committed_run.org_id
        cross join lateral jsonb_each_text(history.factors) as fact(key, value)
        where history.org_id = ${orgId}
          and history.employee_party_id = ${employeePartyId}
          and history.tax_year = ${taxYear}
          and history.pay_run_document_id <> ${documentId}
          and committed_run.run_status = 'committed'
          and committed_document.status <> 'voided'
          and coalesce((history.factors->>'B')::numeric, 0) = 0
          and (fact.key like 'SIT_%' or fact.key like 'LIT_%')
          and coalesce(fact.value::numeric, 0) > 0
      ), ARRAY[]::text[]) as "regularWageTaxWithheldKeys",
      coalesce((select ${sql.raw(ficaWithheldColumn)} from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'SS')::numeric), 0)
      + coalesce(sum((s.factors->>'MED')::numeric), 0)
      + coalesce(sum((s.factors->>'MED2')::numeric), 0) as fica_tax,
      coalesce((
        select jsonb_object_agg(key, total::text)
        from (
          select fact.key as key, sum(coalesce(fact.value::numeric, 0)) as total
          from pay_stubs history
          join pay_runs committed_run
            on committed_run.document_id = history.pay_run_document_id
           and committed_run.org_id = history.org_id
          join documents committed_document
            on committed_document.id = committed_run.document_id
           and committed_document.org_id = committed_run.org_id
          cross join lateral jsonb_each_text(history.factors) as fact(key, value)
          where history.org_id = ${orgId}
            and history.employee_party_id = ${employeePartyId}
            and history.tax_year = ${taxYear}
            and history.pay_run_document_id <> ${documentId}
            and committed_run.run_status = 'committed'
            and committed_document.status <> 'voided'
            and fact.key like 'LIT#_PA-%-LST' escape '#'
          group by 1
        ) lst
      ), '{}'::jsonb) as "lstWithheldYtd"
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
    supplementalWageAmounts,
    insurable, employerEmployeeCount, reducedBases, pushStatutory, storedCertificates, certificateFor, bool,
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
  const suiExempt = bool(empFact("US", emp, "sui_exempt"));
  const suiWagesYtd = sui ? resolveUsSuiYtdForCoverage(region, taxYear, ytd, suiExempt) : "0";
  const filingStatus = (empFact("US", emp, "filing_status") ?? "single") as "single" | "married_joint" | "head_household";
  const federalAlienStatus = certificateFor("us_w4_tax_residency")?.answers.alien_status;
  const nonresidentAlien = requireUsFederalAlienStatus(federalAlienStatus);
  const federalAdditionalPerPeriod = empFact("US", emp, "additional_tax_per_period") ?? "0.0000";
  const statutory = calculatePub15T({
    payDate: run.pay_date!, periodsPerYear: P,
    wages: fitWages, supplemental: nonPeriodic,
    ficaWages: pensionable, futaWages: insurable,
    filingStatus,
    multipleJobs: bool(empFact("US", emp, "multiple_jobs")),
    dependentCredits: empFact("US", emp, "dependent_credits") ?? undefined,
    otherIncomeAnnual: empFact("US", emp, "other_income_annual") ?? undefined,
    deductionsAnnual: empFact("US", emp, "deductions_annual") ?? undefined,
    extraPerPeriod: federalAdditionalPerPeriod,
    pre2020: bool(empFact("US", emp, "w4_pre_2020"))
      ? { allowances: Number(empFact("US", emp, "w4_allowances") ?? 0), married: filingStatus === "married_joint" }
      : undefined,
    fitExempt: bool(empFact("US", emp, "tax_exempt")),
    nonresidentAlien,
    ficaExempt: bool(empFact("US", emp, "fica_exempt")),
    futaExempt: bool(empFact("US", emp, "futa_exempt")),
    suiExempt,
    futaEffectiveRate: config.futaRate(ctx.workAllocations?.[0]?.region ?? region) ?? undefined,
    futaRegion: ctx.workAllocations?.[0]?.region ?? region,
    futaWorkAllocations: ctx.workAllocations,
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
  for (const allocation of ctx.workAllocations ?? []) {
    if (allocation.subRegion !== null || allocation.sourceWagesCurrentPeriod == null) continue;
    const key = `work_source_wages:${allocation.region}`;
    factors[key] = key in factors
      ? sum([factors[key]!, allocation.sourceWagesCurrentPeriod])
      : allocation.sourceWagesCurrentPeriod;
  }
  // Connecticut Paid Leave (2026: 0.5% of FICA-taxable wages to the SS
  // base) withholds beside income tax, never inside it — on the FICA leg
  // (pensionable), capped by FICA YTD, beside the federal lines above.
  if (region === "CT") {
    const ctpl = ctPaidLeaveWithholding(run.pay_date!, pensionable, ytd.fica);
    pushStatutory("ct_pl_employee", "deduction", "Connecticut Paid Leave (employee)", ctpl, 150);
    factors = { ...factors, CTPL_EMPLOYEE: ctpl };
  }

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
    const reach = side === "work" ? "nonresident" : "resident";
    for (const declaration of regionWithholding(country, sideRegion).subRegions) {
      if (declaration.automatic && declaration.reaches.includes(reach) && !codes.includes(declaration.code)) {
        codes.push(declaration.code);
      }
    }
    return codes;
  };

  const workSubRegions = subRegionsOnFile("work");
  const residenceSubRegions = subRegionsOnFile("residence");
  const residenceRegion = (empFact("US", emp, "residence_region") as string | null) || region;
  // District Paid Family Leave (2026: 0.75% of covered wages each quarter)
  // accrues beside income tax, never inside it — on the same base the DC
  // levy priced (periodic plus supplemental).
  if (region === "DC") {
    const dcOpfl = dcOpflWithholding(run.pay_date!, sum([income, nonPeriodic]));
    pushStatutory("dc_opfl_employer", "employer_contribution", "DC Paid Family Leave (employer)", dcOpfl, 254);
    factors = { ...factors, DC_OPFL_EMPLOYER: dcOpfl };
  }
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
  const hasDetroitResidentLevy = resolution.levies.some(
    (levy) => levy.region === "MI" && levy.level === "sub_region"
      && levy.subRegion === "DETROIT" && levy.reach === "resident",
  );
  // Every other Michigan taxing city this Detroit resident works in: the
  // resident rate prices per work-city allocation (2.4% minus THAT city's
  // nonresident rate), so first-match `.find` would price every allocation
  // at one city's credit. Rate lookup stays here, beside the tenant rates.
  const detroitOtherCities = hasDetroitResidentLevy
    ? [...new Set(resolution.levies
      .filter((levy) => levy.region === "MI" && levy.level === "sub_region"
        && levy.side === "work" && levy.subRegion !== "DETROIT" && levy.subRegion !== null)
      .map((levy) => levy.subRegion!))]
      .map((code) => {
        const rates = config.subRegionRates("us_mi_city", "MI", code);
        return { code, nonresidentRate: rates?.nonresidentRate ?? rates?.rate ?? null };
      })
    : [];
  const supplementalPaymentTiming = U(income) === 0n && U(nonPeriodic) > 0n
    ? "separate" as const
    : "combined" as const;

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
  // Minnesota Paid Leave prices only base room the stubs establish: an
  // opening balance with unscoped insurable wages (the same provenance gap
  // that refuses SUI) may hide Minnesota base, so a Minnesota premium levy
  // with such history refuses rather than overstating the room.
  const mnPremium = resolution.levies.some((levy) => levy.region === "MN"
    && (levy.subRegion === "PL" || levy.subRegion === "PLE"));
  if (mnPremium && ytd.suiOpeningUnscoped) {
    throw new PayrollError(
      `${employeeName}: Minnesota Paid Leave cannot be calculated: prior insurable wages sit in `
      + "an opening balance without state allocation, and the premium's wage-base room cannot be "
      + "established. Complete the state-scoped wage history before calculating this run; refused by name",
    );
  }
  // Advisory gaps reach the operator as named, non-blocking run warnings and
  // on the employee's stub trace — never as silence, and never as a refusal.
  for (const gap of advisory) ctx.noteAdvisory?.(gap.message);
  if (advisory.length > 0) {
    factors.WITHHOLDING_ADVISORY = advisory.map((gap) => gap.message).join(" ");
  }

  let regionTax: string | undefined;
  const workRegionTaxes: { region: string; amount: string }[] = [];
  let sequence = 140;
  // State withholding consumes the pack-declared reduced bases below;
  // Nebraska's special minimum therefore uses that same statutory wage base.
  // Colorado FAMLI (2026: 0.44% employee plus 0.44% employer on covered
  // wages) posts beside DR 1098 income tax, never inside it — posted here,
  // ahead of the levy loop, because it is region-priced rather than
  // levy-routed. Same base the CO levy priced (periodic plus supplemental).
  if (region === "CO") {
    const famli = coFamliWithholding(run.pay_date!, sum([income, nonPeriodic]));
    pushStatutory("co_famli_employee", "deduction", "Colorado FAMLI (employee)", famli.employee, 149);
    pushStatutory("co_famli_employer", "employer_contribution", "Colorado FAMLI (employer)", famli.employer, 252);
    factors = {
      ...factors,
      CO_FAMLI_EMPLOYEE: famli.employee,
      CO_FAMLI_EMPLOYER: famli.employer,
    };
  }
  // Employer-pocket levies post below the deduction loop's sequence range:
  // federal employer lines take 210–250, so transit starts at 260.
  let transitSequence = 260;
  for (const levy of resolution.levies) {
    if (levy.level === "sub_region"
      && subRegionLevy(country, levy.region, levy.subRegion!)?.pocket === "employer") {
      // Employer-pocket levies accrue at employer cost — never out of the
      // cheque. Oregon transit's declared base is district-sourced wages from
      // verified work records; its rate is employer-entered and refused by
      // name when absent.
      const employerTax = computeUsEmployerWithholding({
        levy,
        payDate: run.pay_date!,
        wages: sum([income, nonPeriodic]),
        wageAllocations: ctx.workAllocations,
        ytdWages: levy.region === "MN" && levy.subRegion === "PL" ? ytd.mnPaidLeaveWages : undefined,
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
      // Each state engine declares its wage-base keys. The generic treatment
      // reducer supplies those bases from the deduction lines the pack says
      // reduce them; a state's statutory base is never inferred from FIT or
      // from a hard-coded list of component keys.
      wages: income,
      taxableWageBases: reducedBases,
      federalFilingStatus: filingStatus,
      federalLegacyW4: bool(empFact("US", emp, "w4_pre_2020"))
        ? {
          status: filingStatus === "married_joint" ? "married" : "single",
          allowances: Number(empFact("US", emp, "w4_allowances") ?? 0),
        }
        : undefined,
      federalTaxExempt: bool(empFact("US", emp, "tax_exempt")),
      federalAdditionalPerPeriod,
      supplemental: nonPeriodic,
      supplementalWageAmounts,
      supplementalPaymentTiming,
      regularWageTaxWithheldThisYear: ytd.regularWageTaxWithheldThisYear,
      regularWageTaxWithheldFor: ytd.regularWageTaxWithheldKeys,
      wageAllocations: ctx.workAllocations,
      residentWithholdingFacts: levy.basis === "resident_out_of_region"
        && levy.residentWithholdingMethod?.kind !== "full"
        ? resolveUsResidentWithholdingFacts(
          sum([income, nonPeriodic]),
          ctx.workAllocations,
          workRegionTaxes,
          residenceRegion,
        )
        : undefined,
      federalIncomeTax: statutory.fit,
      federalWithholdingExempt: bool(empFact("US", emp, "tax_exempt")),
      // `wages` and `supplemental` are already the declared reduced bases;
      // subtracting the deductions again would double-exclude them in NE's
      // special-procedure floor.
      taxQualifiedDeductions: "0.0000",
      certificateFor,
      residenceRegion,
      regionTax,
      // State engines annualize against the year's earlier supplemental pay
      // (Massachusetts' surtax threshold is the live case); without this
      // every bonus withholds as the year's first. A base-capped flat levy
      // (Minnesota Paid Leave) additionally reads its priced base history
      // off ytd.wages — its own documented field, not a repurposed one.
      ytd: {
        supplemental: ytd.supplemental,
        lstWithheldYtd: ytd.lstWithheldYtd,
        ...(levy.region === "MN" && levy.subRegion === "PLE" ? { wages: ytd.mnPaidLeaveWages } : {}),
      },
      socialInsuranceDeducted: {
        period: sum([statutory.ss, statutory.medicare, statutory.additionalMedicare]),
        yearToDate: ytd.fica_tax,
      },
      tenantRates: (rateKey, subRegion) =>
        config.subRegionRates(rateKey, levy.region, subRegion),
      detroitOtherCities,
    });
    if (!withheld) continue;
    if (levy.level === "region" && levy.side === "work") {
      workRegionTaxes.push({ region: levy.region, amount: withheld.statutoryTax ?? withheld.tax });
    }
    if (levy.level === "region") regionTax = withheld.tax;
    const lineSequence = sequence++;
    pushStatutory(
      levy.statutoryComponent?.systemKey
        ?? (levy.level === "region" ? "state_income_tax" : "local_income_tax"),
      levy.statutoryComponent?.kind ?? "deduction",
      withheld.label, withheld.tax, lineSequence,
    );
    if (levy.level === "sub_region" && withheld.localTaxableWages !== undefined) {
      factors[w2LocalWageTraceKey(lineSequence)] = withheld.localTaxableWages;
    }
    factors = {
      ...factors,
      ...withheld.factors,
      [levy.statutoryComponent
        ? `STATUTORY_${levy.statutoryComponent.systemKey}`
        : `${levy.level === "region" ? "SIT" : "LIT"}_${withheld.code}`]: withheld.tax,
    };
    // A levy assessing a second tax (the PA worksite LST rides the settled
    // Act 32 levy) posts it as its own line under the shared local component,
    // with its own mirror factor — never folded into the first tax's amount.
    for (const extra of withheld.additionalLines ?? []) {
      const extraSequence = sequence++;
      pushStatutory("local_income_tax", "deduction", extra.label, extra.tax, extraSequence);
      factors = {
        ...factors,
        ...extra.factors,
        [`LIT_${extra.code}`]: extra.tax,
      };
    }
  }
  // Pennsylvania UC employee withholding (2026: 0.07% of all gross wages,
  // no cap) is an employee deduction, not income tax: the state engine only
  // traces it, so the pass posts it here through the declared slot. Same
  // base the PA levy priced (periodic plus supplemental), keeping the posted
  // line and the PA_UC_EMPLOYEE trace identical by construction.
  if (region === "PA") {
    const paUc = paUcEmployeeWithholding(run.pay_date!, sum([income, nonPeriodic]));
    pushStatutory("pa_uc_employee", "deduction", "Pennsylvania UC (employee)", paUc, 147);
    factors.PA_UC_EMPLOYEE = paUc;
  }
  factors.WITHHOLDING_RESIDENCE = resolution.residenceRegion;
  factors.WITHHOLDING_RESIDENCE_SOURCE = resolution.residenceSource;
  // California ETT (2026: 0.1% on the first $7,000, positive UI-reserve
  // employers only): the unconfigured-balance refusal fires at run
  // readiness, so a null here is unreachable in a run — it throws by name
  // rather than assuming an exempt account. The cap tracks the UI-covered
  // wage base, the same first-$7,000 the SUI base measures.
  if (region === "CA") {
    const reserve = config.ettReserveBalance(region);
    if (reserve == null) {
      throw new PayrollError(
        "California Employment Training Tax needs the employer's UI reserve account balance "
        + "(positive balance owes 0.1% on the first $7,000; a deficit balance is exempt). "
        + "Enter it on the us_ca_ett rate before calculating — refused by name",
      );
    }
    if (U(reserve) > 0n) {
      const caEtt = caEttWithholding(run.pay_date!, sum([income, nonPeriodic]), ytd.suiCurrentRegion);
      pushStatutory("ca_ett", "employer_contribution", "CA employment training tax", caEtt, 251);
      factors.CA_ETT_EMPLOYEE = caEtt;
    } else {
      factors.CA_ETT_EXEMPT = "1";
    }
  }
  return factors;
}
