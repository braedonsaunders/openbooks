import {
  resolveCaBonusIncomeReference,
  type CaBonusIncomeReferenceSource,
} from "./bonus-income-reference.ts";
import { sql } from "drizzle-orm";
import type { db } from "../../platform/db.ts";
import {
  add,
  cmp,
  div,
  fromUnits,
  mulDecimal,
  mulPercent,
  neg,
  sum,
  toUnits,
} from "../../money/money.ts";
import { certificateCount, type ResolvedCertificate } from "../certificates.ts";
import { empFact } from "../employee-facts.ts";
import { findStoredEmployerFactValue } from "../employer-fact-store.ts";
import { resolveEmployerFact } from "../employer-facts.ts";
import { PayrollError } from "../error.ts";
// Side effect: registers CA_EMPLOYEE_FACTS, so every read below resolves
// through the declaration in every import graph — never via a transitive
// side effect of the pack registry.
import "./employee-facts.ts";
import { assertCaContributionBases, calculateT4127, type T4127Input } from "./t4127.ts";
import { calculateTp1015 } from "./quebec/tp1015.ts";
import { qcRatesForPayDate } from "./quebec/rates.ts";
import { ratesForPayDate, type Province } from "./rates.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { CA_SUPPLEMENTAL_PAY_TREATMENT } from "./supplemental-pay.ts";
import { periodPriorsEmpty } from "../period-priors.ts";
import { cumulativeHistory } from "./cumulative-history.ts";
import { CA_OPENING_YTD_FIELDS } from "./opening-ytd.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { canonicalDecimal } from "../../money/exact-decimal.ts";
import { isUuid } from "../../platform/uuid.ts";
import { readEmployeeOpeningLevySources } from "../opening-levy-source-reader.ts";

/** TD1ON dependant claims that drive Ontario's T4127 factor Y. */
export function t4127OntarioDependantInputs(
  certificate: ResolvedCertificate | null,
): Pick<T4127Input, "disabledDependants" | "dependantsUnder19"> {
  if (!certificate) {
    throw new PayrollPackError(
      "Ontario income tax requires the TD1ON certificate declaration — restore the Ontario " +
        "certificate in the Canada payroll pack before calculating",
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
  F: "Periodic pension deductions",
  F2: "Alimony deducted at source",
  U1: "Periodic union dues",
  F3: "Pension deductions from a bonus",
  CA_PE: "Periodic pensionable earnings",
  CA_IE: "Periodic EI insurable earnings",
  CA_QPIP_PE: "Periodic QPIP insurable earnings",
  CA_BPE: "Bonus pensionable earnings",
  CA_BIE: "Bonus EI insurable earnings",
  CA_BQPIP: "Bonus QPIP insurable earnings",
  CA_T_BASE: "Periodic income tax excluding additional tax",
  CA_TAX_OVERRIDE: "Operator-entered total income-tax withholding for this cheque",
  CA_BONUS_I_REFERENCE: "Regular pay per period used to tax a bonus paid on its own",
  B: "Bonus / non-periodic pay this period",
  I: "Periodic income this period",
  PI: "Pensionable earnings this period",
  IE: "Insurable earnings this period",
  QPIP: "QPIP premium",
  EI_ER: "EI premium (employer)",
  QPIP_ER: "QPIP premium (employer)",
  WCB: "Workers' compensation premium (employer)",
  WCB_EARN: "Workers' compensation assessable earnings",
  WCB_ADJ:
    "Workers' compensation issued operator-entered amount recorded as issued (not native assessment)",
  EHT: "Employer Health Tax",
  EHT_EARN: "EHT remuneration (Ontario)",
  EHT_ADJ:
    "Employer Health Tax issued operator-entered amount recorded as issued (not native assessment)",
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
  pension_deductions_bonus: string;
  f5b: string;
  qc_csb: string;
};

const CA_STATUTORY_OPENING_COLUMNS: Readonly<Record<keyof CanadaYtdRow, string>> = {
  pensionable: "pensionable_ytd",
  insurable: "insurable_ytd",
  cpp: "cpp_ytd",
  cpp2: "cpp2_ytd",
  ei: "ei_ytd",
  qpip: "qpip_ytd",
  qpip_employer: CA_OPENING_YTD_FIELDS.find((field) => field.key === "qpipEmployerYtd")!.column,
  non_periodic: "non_periodic_ytd",
  pension_deductions_bonus: "non_periodic_pension_deductions_ytd",
  f5b: CA_OPENING_YTD_FIELDS.find((field) => field.key === "cpp2BonusYtd")!.column,
  qc_csb: CA_OPENING_YTD_FIELDS.find((field) => field.key === "qcCsbYtd")!.column,
};

/** Canadian annual room consumes only the exact, certified original Canadian source. */
export function canadaOriginalOpeningYtd(
  source: Awaited<ReturnType<typeof readEmployeeOpeningLevySources>>,
): CanadaYtdRow {
  const result = Object.fromEntries(
    Object.keys(CA_STATUTORY_OPENING_COLUMNS).map((key) => [key, "0.0000"]),
  ) as CanadaYtdRow;
  if (!source.hasOpening || !source.hasMaterialHistory) return result;
  if (!source.facts || !source.authority || !source.openingSnapshot || !source.openingChildren) {
    throw new PayrollError(
      "Canadian opening contributions require the exact original country, legal employer and source report — qualify the original opening in Payroll → Opening balances → Levy source before calculating",
    );
  }
  if (source.facts.originalCountry !== "CA") return result;
  if (source.facts.originalCurrency !== "CAD") {
    throw new PayrollError(
      "Canadian opening contributions require a certified original Canadian-dollar source — qualify the original opening in Payroll → Opening balances → Levy source before calculating",
    );
  }
  for (const key of Object.keys(CA_STATUTORY_OPENING_COLUMNS) as (keyof CanadaYtdRow)[]) {
    const column = CA_STATUTORY_OPENING_COLUMNS[key];
    const amount = canonicalDecimal(source.openingSnapshot[column], 4);
    if (amount === null || cmp(amount, "0") < 0) {
      throw new PayrollError(
        `The original ${column} opening is not an exact non-negative decimal — qualify its original source before calculating`,
      );
    }
    result[key] = fromUnits(toUnits(amount));
  }
  return result;
}

/**
 * Read the employee's year-to-date statutory inputs from committed payroll.
 * Calculated runs are drafts and may be abandoned; counting them would let
 * unpaid figures consume CPP/EI/tax room in a later run.
 */
export async function employeeYtd(
  ctx: Pick<
    PayrollStatutoryComputeContext,
    "tx" | "orgId" | "employeePartyId" | "taxYear" | "documentId" | "subsidiaryId"
  >,
): Promise<CanadaYtdRow> {
  const { tx, orgId, employeePartyId, taxYear, documentId } = ctx;
  const employer = await tx.execute<{ id: string; currency: string; payDate: string | null }>(
    sql`select d.subsidiary_id as id,d.currency,r.pay_date::text as "payDate" from documents d
    join pay_runs r on r.org_id=d.org_id and r.document_id=d.id
    where d.org_id=${orgId} and d.id=${documentId} and d.kind='pay_run'`,
    "objects",
  );
  if (
    employer.length !== 1 ||
    !employer[0]!.id ||
    (ctx.subsidiaryId !== undefined && ctx.subsidiaryId !== employer[0]!.id)
  )
    throw new PayrollError(
      "Canadian annual contribution history requires the actual pay-run legal employer",
    );
  if (employer[0]!.currency !== "CAD")
    throw new PayrollError(
      "Canadian annual contribution calculation requires a qualified Canadian-dollar pay-run basis",
    );
  if (!employer[0]!.payDate)
    throw new PayrollError(
      "Canadian annual contribution history requires the actual pay-run pay date",
    );
  const subsidiaryId = employer[0]!.id;
  const unknownHistory = await tx.execute(
    sql`select s.id from pay_stubs s
    join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    where s.org_id=${orgId} and s.employee_party_id=${employeePartyId} and s.tax_year=${taxYear}
      and s.pay_run_document_id<>${documentId} and r.run_status='committed' and d.status<>'voided'
      and d.subsidiary_id=${subsidiaryId}
      and (s.country is null or (s.country='CA' and (s.currency_code<>'CAD' or d.currency<>'CAD'))) limit 1`,
    "objects",
  );
  if (unknownHistory.length)
    throw new PayrollError(
      "Canadian annual contribution history has unknown country or currency attribution — qualify the original retained payroll source before calculating",
    );
  const opening = canadaOriginalOpeningYtd(
    await readEmployeeOpeningLevySources(tx, {
      orgId,
      employeePartyId,
      taxYear,
      subsidiaryId,
      beforeDate: employer[0]!.payDate,
    }),
  );
  const r = await tx.execute<CanadaYtdRow>(
    sql`
    select
      coalesce(sum(s.pensionable_earnings), 0)::text as pensionable,
      coalesce(sum(s.insurable_earnings), 0)::text as insurable,
      coalesce(sum((s.factors->>'C')::numeric), 0)::text as cpp,
      coalesce(sum((s.factors->>'C2')::numeric), 0)::text as cpp2,
      coalesce(sum((s.factors->>'EI')::numeric), 0)::text as ei,
      coalesce(sum((s.factors->>'QPIP')::numeric), 0)::text as qpip,
      coalesce(sum((s.factors->>'QPIP_ER')::numeric), 0)::text as qpip_employer,
      coalesce(sum((s.factors->>'F3')::numeric), 0)::text as pension_deductions_bonus,
      coalesce(sum((s.factors->>'B')::numeric), 0)::text as non_periodic,
      coalesce(sum((s.factors->>'F5B')::numeric), 0)::text as f5b,
      coalesce(sum((s.factors->>'QC_CSB')::numeric), 0)::text as qc_csb
    from pay_stubs s
    join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
    join documents d on d.id = r.document_id and d.org_id = r.org_id
    where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
      and s.tax_year = ${taxYear} and s.pay_run_document_id <> ${documentId}
      and r.run_status = 'committed'
      and d.status <> 'voided' and d.subsidiary_id=${subsidiaryId} and s.country='CA' and s.currency_code='CAD'
  `,
    "objects",
  );
  const priors = r[0]!;
  return Object.fromEntries(
    (Object.keys(CA_STATUTORY_OPENING_COLUMNS) as (keyof CanadaYtdRow)[]).map((key) => [
      key,
      add(opening[key], priors[key]),
    ]),
  ) as CanadaYtdRow;
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
  const account = (
    await tx.execute<{ country: string; program_type: string }>(
      sql`
    select country, program_type from payroll_filing_accounts
     where org_id = ${orgId} and id = ${filingAccountId} and is_active
  `,
      "objects",
    )
  )[0];
  if (!account || account.country !== "CA" || account.program_type !== "ca_rp") return "1.4";
  const stored = await findStoredEmployerFactValue({
    tx,
    orgId,
    filingAccountId,
    country: "CA",
    factKey: "ei_employer_multiplier",
    asOf: payDate,
  });
  if (stored != null) {
    return resolveEmployerFact("CA", "ei_employer_multiplier", stored)!;
  }
  const configured = (
    await tx.execute<{ configured: boolean }>(
      sql`
    select exists (
      select 1 from payroll_employer_facts
       where org_id = ${orgId} and filing_account_id = ${filingAccountId}::uuid
         and country = 'CA' and fact_key = 'ei_employer_multiplier'
    ) as configured
  `,
      "objects",
    )
  )[0]!.configured;
  if (!configured) return "1.4";
  throw new PayrollError(
    `${employeeName} is on a payroll program account with no employer EI multiple effective on ${payDate} ` +
      "— record the CRA-approved rate (or the standard 1.4) in Payroll Setup → Employer facts before calculating",
  );
}

/** Phase 9 — CA pack statutory pass (T4127 + Québec TP-1015). */
export async function computeCaStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const {
    tx,
    orgId,
    documentId,
    employeePartyId,
    employeeName,
    taxYear,
    region,
    run,
    emp,
    periodsPerYear: P,
    income,
    nonPeriodic,
    pensionable,
    insurable,
    deduction,
    pushStatutory,
    bool,
    assertRegionSupported,
    employerLevies,
  } = ctx;
  // The employee's payroll program account prices the employer share: the
  // statutory 1.4 by default, the CRA-approved reduced rate where one is
  // recorded, or a named refusal when the account's rate history leaves
  // the pay date uncovered.
  const eiEmployerMultiple = await resolveEiEmployerMultiple({
    tx,
    orgId,
    filingAccountId: ctx.filingAccountId ?? null,
    employeeName,
    payDate: run.pay_date!,
  });
  const contributionBases = {
    pensionable: ctx.pensionable,
    insurable: ctx.insurable,
    qpipInsurable: ctx.programBases?.qpip,
    pensionableNonPeriodic: ctx.pensionableNonPeriodic,
    insurableNonPeriodic: ctx.insurableNonPeriodic,
    qpipNonPeriodic: ctx.programNonPeriodicBases?.qpip,
  };
  assertCaContributionBases(contributionBases);
  const qpipInsurable = contributionBases.qpipInsurable;
  const {
    wcbAmount,
    wcbAssessable,
    ehtAmount,
    ehtEarnings,
    hsfAmount,
    hsfEarnings,
    cntAmount,
    cntEarnings,
  } = employerLevies;
  const wcbAdjustmentAmount = employerLevies.wcbAdjustmentAmount;
  const ehtAdjustmentAmount = employerLevies.ehtAdjustmentAmount;

  assertRegionSupported(region);

  const ytd = await employeeYtd({
    tx,
    orgId,
    employeePartyId,
    taxYear,
    documentId,
    subsidiaryId: ctx.subsidiaryId,
  });
  const taxAdjustments = await tx.execute<{
    amount: string | null;
    replace_component: boolean;
    note: string | null;
  }>(
    sql`
    select a.amount::text as amount, a.replace_component, a.note from pay_run_adjustments a
      join pay_components c on c.org_id=a.org_id and c.id=a.component_id
     where a.org_id=${orgId} and a.pay_run_document_id=${documentId} and a.employee_party_id=${employeePartyId}
       and a.adjustment_type='line' and c.system_key='income_tax'
     order by a.created_at, a.id`,
    "objects",
  );
  const overrideAdjustments = taxAdjustments.filter((adjustment) => adjustment.replace_component);
  if (overrideAdjustments.length > 1) {
    throw new PayrollError(
      "this employee has multiple income-tax overrides on the run — remove the duplicate adjustment before recalculating",
    );
  }
  const incomeTaxOverride = overrideAdjustments[0] ?? null;
  let incomeTaxOverrideReason: string | null = null;
  let incomeTaxOverrideSourceReference: string | null = null;
  if (incomeTaxOverride && region === "QC") {
    throw new PayrollError(
      "a single total cannot override Québec federal and provincial withholding separately — remove the override to use native Québec calculation",
    );
  }
  if (incomeTaxOverride) {
    let evidence: unknown;
    try {
      evidence = JSON.parse(incomeTaxOverride.note ?? "null");
    } catch {
      evidence = null;
    }
    const exactAmount = canonicalDecimal(canonicalDecimal(incomeTaxOverride.amount, 4), 2);
    if (
      exactAmount === null ||
      cmp(exactAmount, "0") < 0 ||
      !evidence ||
      typeof evidence !== "object" ||
      Array.isArray(evidence) ||
      (evidence as { kind?: unknown }).kind !== "income_tax_override" ||
      typeof (evidence as { reason?: unknown }).reason !== "string" ||
      !(evidence as { reason: string }).reason.trim() ||
      (evidence as { reason: string }).reason.length > 500 ||
      typeof (evidence as { sourceReference?: unknown }).sourceReference !== "string" ||
      !(evidence as { sourceReference: string }).sourceReference.trim() ||
      (evidence as { sourceReference: string }).sourceReference.length > 300 ||
      typeof (evidence as { requestId?: unknown }).requestId !== "string" ||
      !isUuid((evidence as { requestId: string }).requestId)
    ) {
      throw new PayrollError(
        "the saved income-tax override is missing its non-negative amount, reason, source reference or request identity — correct it through the audited override command",
      );
    }
    incomeTaxOverrideReason = (evidence as { reason: string }).reason.trim();
    incomeTaxOverrideSourceReference = (
      evidence as { sourceReference: string }
    ).sourceReference.trim();
  }
  const runAdditionalTax = sum(
    taxAdjustments
      .filter((adjustment) => !adjustment.replace_component)
      .map((adjustment) => {
        if (adjustment.amount === null)
          throw new PayrollError(
            "The saved additional income-tax adjustment has no amount — correct the adjustment before calculating",
          );
        return adjustment.amount;
      }),
  );
  const nonZeroOrUndefined = (value: string): string | undefined =>
    cmp(value, "0") === 0 ? undefined : value;
  const ontarioDependantInputs =
    region === "ON" ? t4127OntarioDependantInputs(ctx.certificateFor("ca_td1_ON")) : {};
  const qcCertificate = region === "QC" ? ctx.certificateFor("ca_td1_QC") : null;
  const sharePurchases = qcCertificate?.answers ?? {};
  const requestedFtqSharesPerPeriod = sharePurchases.ftq_shares_per_period ?? "0";
  const requestedFondactionSharesPerPeriod = sharePurchases.fondaction_shares_per_period ?? "0";
  const fundPurchaseCap =
    region === "QC" ? toUnits(qcRatesForPayDate(run.pay_date!).labourFundsAnnualPurchaseCap) : null;
  const annualFtqShares = toUnits(requestedFtqSharesPerPeriod) * BigInt(P);
  const annualFondactionShares = toUnits(requestedFondactionSharesPerPeriod) * BigInt(P);
  const annualFundShares = annualFtqShares + annualFondactionShares;
  const annualEligibleShares =
    fundPurchaseCap === null || annualFundShares <= fundPurchaseCap
      ? annualFundShares
      : fundPurchaseCap;
  const eligibleAnnualFtqShares =
    annualEligibleShares === annualFundShares
      ? annualFtqShares
      : (annualFtqShares * annualEligibleShares + annualFundShares / 2n) / annualFundShares;
  const ftqSharesPerPeriod =
    region === "QC"
      ? div(fromUnits(eligibleAnnualFtqShares), String(P))
      : requestedFtqSharesPerPeriod;
  const fondactionSharesPerPeriod =
    region === "QC"
      ? div(fromUnits(annualEligibleShares - eligibleAnnualFtqShares), String(P))
      : requestedFondactionSharesPerPeriod;

  // ---- Supplemental-period priors ----------------------------------------
  // Earlier runs of the same period and schedule already paid and withheld
  // part of this period. CPP prices the period-to-date base so its exemption
  // applies once; EI rounds each payment against its annual room. Income tax
  // follows the org's supplemental method. With no priors every combined leg
  // below equals its current leg and every subtraction is zero, so the first
  // run of a period prices exactly as a standalone run.
  if (!ctx.periodPriors || !["per_run", "period_cumulative"].includes(ctx.supplementalTaxMethod)) {
    throw new PayrollError(
      "Canadian payroll requires resolved period history and a supplemental tax method — review payroll settings and recalculate",
    );
  }
  const priors = ctx.periodPriors;
  const priorFactor = (key: string): string => priors.factors[key] ?? "0";
  const priorWithheld = (keys: readonly string[]): string =>
    sum(keys.map((key) => priors.withheldBySystemKey[key] ?? "0"));
  const hasPriors = !periodPriorsEmpty(priors);
  const supplementalMethod = ctx.supplementalTaxMethod;
  const runType = (run.run_type as string) ?? "regular";
  // A supplemental run IS periodic pay for tax (that is what distinguishes it
  // from a bonus run), so under the cumulative method its own non-periodic
  // lines join the period's single periodic pay too. A regular run keeps its
  // bonus method until a second run actually shares the period — otherwise
  // every existing bonus-carrying regular run would reprice.
  const foldBonus =
    supplementalMethod === "period_cumulative" && (hasPriors || runType === "supplemental");
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
  const periodQpipInsurable = add(
    add(priorFactor("CA_QPIP_PE"), priorFactor("CA_BQPIP")),
    qpipInsurable,
  );
  const taxIncome = foldBonus
    ? add(add(add(priorFactor("I"), priorFactor("B")), income), nonPeriodic)
    : income;
  const taxNonPeriodic = foldBonus ? "0" : nonPeriodic;
  const taxPensionDeductions = foldBonus
    ? add(
        add(add(priorFactor("F"), priorFactor("F3")), deduction("pension_f")),
        deduction("pension_f_bonus"),
      )
    : deduction("pension_f");
  const taxAlimony = foldBonus
    ? add(priorFactor("F2"), deduction("alimony"))
    : deduction("alimony");
  const taxUnionDues = foldBonus
    ? add(priorFactor("U1"), deduction("union_dues"))
    : deduction("union_dues");
  const taxNonPeriodicPension = foldBonus ? "0" : deduction("pension_f_bonus");
  // Annual-room year-to-date legs exclude the current period's earlier runs
  // (they rejoin through the period legs above); the non-periodic history
  // legs exclude them too, since the combined call already counts them.
  // Unit-constructed contexts omit year-to-date legs the engine always
  // provides; absent reads as zero, exactly as the guide engine does.
  const roomYtd = (value: string | undefined, prior: string): string =>
    add(value ?? "0", neg(prior));
  const ytdCpp = roomYtd(ytd.cpp, priorFactor("C"));
  const ytdCpp2 = roomYtd(ytd.cpp2, priorFactor("C2"));
  const ytdEi = roomYtd(ytd.ei, priorFactor("EI"));
  const ytdQpip = roomYtd(ytd.qpip, priorFactor("QPIP"));
  const ytdQpipEmployer = roomYtd(ytd.qpip_employer, priorFactor("QPIP_ER"));
  const ytdPensionable = roomYtd(ytd.pensionable, priors.pensionable);
  const ytdNonPeriodic = roomYtd(ytd.non_periodic, priorFactor("B"));
  const ytdNonPeriodicPension = roomYtd(ytd.pension_deductions_bonus, priorFactor("F3"));
  const ytdNonPeriodicEnhanced = roomYtd(ytd.f5b, priorFactor("F5B"));

  const cumulative = await cumulativeHistory(ctx);
  if (cumulative?.averaging && hasPriors) {
    throw new PayrollPackError(
      `cumulative averaging cannot combine with a supplemental-period share for ${employeePartyId} — ` +
        "process the period's pay in a single run while cumulative averaging is elected",
    );
  }
  // Contribution payment classification uses actual current and prior
  // remuneration, before supplemental tax folding or a bonus I reference.
  const periodNonPeriodicPensionable = add(priorFactor("CA_BPE"), ctx.pensionableNonPeriodic);
  const separateNonPeriodicPayment =
    cmp(add(priorFactor("I"), income), "0") === 0 &&
    (cmp(add(priorFactor("B"), nonPeriodic), "0") > 0 ||
      cmp(periodNonPeriodicPensionable, "0") > 0) &&
    cmp(periodPensionable, periodNonPeriodicPensionable) <= 0;
  const t4127Input: T4127Input = {
    separateNonPeriodicPayment,
    averaging: cumulative?.averaging,
    pensionableNonPeriodic: foldBonus ? "0" : ctx.pensionableNonPeriodic,
    insurableNonPeriodic: foldBonus ? "0" : ctx.insurableNonPeriodic,
    qpipNonPeriodic: foldBonus ? "0" : contributionBases.qpipNonPeriodic,
    payDate: run.pay_date!,
    province: region as Province,
    periodsPerYear: P,
    income: taxIncome,
    nonPeriodic: taxNonPeriodic,
    pensionable: periodPensionable,
    insurable: periodInsurable,
    qpipInsurable: periodQpipInsurable,
    eiEmployerMultiple,
    pensionDeductions: taxPensionDeductions,
    alimonyDeductions: taxAlimony,
    nonPeriodicPensionDeductions: taxNonPeriodicPension,
    unionDues: taxUnionDues,
    labourFundsCreditFederal:
      region === "QC"
        ? mulPercent(
            add(ftqSharesPerPeriod, fondactionSharesPerPeriod),
            mulDecimal(ratesForPayDate(run.pay_date!).federal.lcf.rate, "100"),
            2,
          )
        : undefined,
    prescribedZoneDeduction: empFact("CA", emp, "prescribed_zone_deduction") ?? undefined,
    authorizedAnnualDeductions: empFact("CA", emp, "authorized_annual_deductions") ?? undefined,
    authorizedFederalCredits: empFact("CA", emp, "authorized_federal_credits") ?? undefined,
    authorizedProvincialCredits: empFact("CA", emp, "authorized_provincial_credits") ?? undefined,
    // The TD1 additional deduction is requested once per pay period and is
    // withheld through the period's regular or final pay; a supplemental run
    // sharing the period never withholds it a second time. Additional tax the
    // employee requested for this run alone adds to it on any run.
    additionalTaxPerPeriod: nonZeroOrUndefined(
      add(
        runType === "supplemental" ? "0" : (empFact("CA", emp, "additional_tax_per_period") ?? "0"),
        runAdditionalTax,
      ),
    ),
    ...ontarioDependantInputs,
    federalClaim: empFact("CA", emp, "federal_claim_amount") ?? undefined,
    federalClaimCode:
      empFact("CA", emp, "federal_claim_amount") == null &&
      empFact("CA", emp, "federal_claim_code") != null
        ? Number(empFact("CA", emp, "federal_claim_code"))
        : undefined,
    provincialClaim: empFact("CA", emp, "provincial_claim_amount") ?? undefined,
    provincialClaimCode:
      empFact("CA", emp, "provincial_claim_amount") == null &&
      empFact("CA", emp, "provincial_claim_code") != null
        ? Number(empFact("CA", emp, "provincial_claim_code"))
        : undefined,
    taxExempt: bool(empFact("CA", emp, "tax_exempt")),
    cppExempt: bool(empFact("CA", emp, "cpp_exempt")),
    eiExempt: bool(empFact("CA", emp, "ei_exempt")),
    ytd: {
      cpp: ytdCpp,
      cpp2: ytdCpp2,
      ei: ytdEi,
      qpip: ytdQpip,
      qpipEmployer: ytdQpipEmployer,
      pensionable: ytdPensionable,
      nonPeriodic: ytdNonPeriodic,
      nonPeriodicPensionDeductions: ytdNonPeriodicPension,
      nonPeriodicCppEnhancedDeductions: ytdNonPeriodicEnhanced,
      ...(cumulative?.bonusYtd ?? {}),
    },
  };
  // EI has no per-period exemption: each payment rounds its own premium,
  // constrained by the full committed annual history. Combining payments
  // before rounding can shift a cent onto the later employee deduction and
  // misprice the employer's multiple. CPP still shares one period exemption.
  const paymentPremiums = hasPriors
    ? calculateT4127({
        ...t4127Input,
        insurable,
        ytd: { ...t4127Input.ytd, ei: ytd.ei },
      })
    : null;
  // The cumulative tax credit uses the premiums actually withheld across
  // the period; the per-run method below credits only this payment.
  const statutory = calculateT4127({
    ...t4127Input,
    ...(paymentPremiums ? { eiWithheld: add(priorFactor("EI"), paymentPremiums.ei) } : {}),
  });

  // This run's share of the combined pension amounts: the period total minus what
  // earlier runs of the period already withheld. Each stub traces its share,
  // so the next run's priors telescope to the period total exactly.
  const cpp = nonNegative(add(statutory.cpp, neg(priorFactor("C"))));
  const cpp2 = nonNegative(add(statutory.cpp2, neg(priorFactor("C2"))));
  const ei = paymentPremiums?.ei ?? statutory.ei;
  const eiEmployer = paymentPremiums?.eiEmployer ?? statutory.eiEmployer;
  const qpip = nonNegative(add(statutory.qpip, neg(priorFactor("QPIP"))));
  const qpipEmployer = nonNegative(add(statutory.qpipEmployer, neg(priorFactor("QPIP_ER"))));

  // Call 2 — income tax with each run taxed as its own periodic pay (T4127
  // Option 1 on this run's income alone, annualized by P). The K2 credits
  // and the F5 deduction price off what this run actually withheld (the
  // shares above), not a standalone recomputation: only the credits follow
  // the period, never the income. Annual maxima still read the full
  // year-to-date, so a max reached with this run caps the credit exactly as
  // the guide states.
  const standaloneTax =
    supplementalMethod === "per_run" && hasPriors
      ? calculateT4127({
          ...t4127Input,
          averaging: undefined,
          income,
          nonPeriodic,
          pensionable,
          insurable,
          qpipInsurable,
          pensionableNonPeriodic: ctx.pensionableNonPeriodic,
          insurableNonPeriodic: ctx.insurableNonPeriodic,
          qpipNonPeriodic: contributionBases.qpipNonPeriodic,
          pensionDeductions: deduction("pension_f"),
          alimonyDeductions: deduction("alimony"),
          nonPeriodicPensionDeductions: deduction("pension_f_bonus"),
          unionDues: deduction("union_dues"),
          cppWithheld: cpp,
          cpp2Withheld: cpp2,
          eiWithheld: ei,
          qpipWithheld: qpip,
          ytd: {
            cpp: ytd.cpp,
            cpp2: ytd.cpp2,
            ei: ytd.ei,
            qpip: ytd.qpip,
            qpipEmployer: ytd.qpip_employer,
            pensionable: ytd.pensionable,
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
  const f5a = nonNegative(
    add(add(statutory.f5A, neg(priorFactor("F5A"))), neg(foldBonus ? priorFactor("F5B") : "0")),
  );
  const f5b = foldBonus ? "0" : nonNegative(add(statutory.f5B, neg(priorFactor("F5B"))));
  const f5 = add(f5a, f5b);
  // CRA's regular bonus method uses the most recent periodic I when a
  // separately paid bonus has no periodic remuneration of its own. The
  // reference affects only bonus tax, never current earnings or premiums.
  let bonusIncomeReference: CaBonusIncomeReferenceSource | null = null;
  let referencedBonusTax: ReturnType<typeof calculateT4127> | null = null;
  if (
    !cumulative?.averaging &&
    !foldBonus &&
    region !== "QC" &&
    !bool(empFact("CA", emp, "tax_exempt")) &&
    cmp(income, "0") === 0 &&
    cmp(nonPeriodic, "0") > 0
  ) {
    if (
      !ctx.employmentId ||
      !ctx.subsidiaryId ||
      !run.doc_currency ||
      !run.pay_schedule_id ||
      !ctx.filingAccountId
    ) {
      throw new PayrollError(
        "A separately paid Canadian bonus requires its native employment, employer, currency, schedule and filing account before resolving regular income",
      );
    }
    const reference = await resolveCaBonusIncomeReference(tx, {
      orgId,
      documentId,
      employeePartyId,
      employmentId: ctx.employmentId,
      subsidiaryId: ctx.subsidiaryId,
      filingAccountId: ctx.filingAccountId,
      currency: run.doc_currency,
      payScheduleId: run.pay_schedule_id,
      taxYear,
      payDate: run.pay_date!,
      periodEnd: run.period_end!,
    });
    bonusIncomeReference = reference;
    ctx.recordBonusIncomeReference?.(reference);
    referencedBonusTax = calculateT4127({
      ...t4127Input,
      averaging: undefined,
      income: reference.income,
      nonPeriodic,
      pensionable,
      insurable,
      qpipInsurable,
      pensionableNonPeriodic: ctx.pensionableNonPeriodic,
      insurableNonPeriodic: ctx.insurableNonPeriodic,
      qpipNonPeriodic: contributionBases.qpipNonPeriodic,
      cppWithheld: cpp,
      cpp2Withheld: cpp2,
      eiWithheld: ei,
      qpipWithheld: qpip,
      pensionDeductions: deduction("pension_f"),
      alimonyDeductions: deduction("alimony"),
      unionDues: deduction("union_dues"),
      nonPeriodicPensionDeductions: deduction("pension_f_bonus"),
      ytd: {
        cpp: ytd.cpp,
        cpp2: ytd.cpp2,
        ei: ytd.ei,
        qpip: ytd.qpip,
        qpipEmployer: ytd.qpip_employer,
        pensionable: ytd.pensionable,
        nonPeriodic: ytd.non_periodic,
        nonPeriodicPensionDeductions: ytd.pension_deductions_bonus,
        nonPeriodicCppEnhancedDeductions: ytd.f5b,
      },
    });
  }
  const currentFederalTax =
    standaloneTax !== null
      ? standaloneTax.totalTax
      : hasPriors && supplementalMethod === "period_cumulative"
        ? nonNegative(add(statutory.totalTax, neg(priorFederalTax)))
        : statutory.totalTax;

  const currentTax = standaloneTax ?? statutory;
  const federalTax = referencedBonusTax
    ? add(add(currentFederalTax, neg(currentTax.bonusTax)), referencedBonusTax.bonusTax)
    : currentFederalTax;
  pushStatutory(
    "income_tax",
    "deduction",
    incomeTaxOverride
      ? `Income tax override — ${incomeTaxOverrideReason}; source ${incomeTaxOverrideSourceReference}`
      : "Income tax",
    incomeTaxOverride ? incomeTaxOverride.amount! : federalTax,
    110,
  );
  pushStatutory("cpp", "deduction", region === "QC" ? "QPP" : "CPP", cpp, 120);
  pushStatutory("cpp2", "deduction", region === "QC" ? "QPP2" : "CPP2", cpp2, 130);
  pushStatutory("ei", "deduction", "EI", ei, 140);
  pushStatutory("qpip", "deduction", "QPIP", qpip, 150);
  pushStatutory(
    "cpp",
    "employer_contribution",
    region === "QC" ? "QPP (employer)" : "CPP (employer)",
    cpp,
    210,
  );
  pushStatutory(
    "cpp2",
    "employer_contribution",
    region === "QC" ? "QPP2 (employer)" : "CPP2 (employer)",
    cpp2,
    215,
  );
  pushStatutory("ei", "employer_contribution", "EI (employer)", eiEmployer, 220);
  pushStatutory("qpip", "employer_contribution", "QPIP (employer)", qpipEmployer, 230);

  let qcFactors: Record<string, string> = {};
  if (region === "QC") {
    const qc = calculateTp1015({
      payDate: run.pay_date!,
      periodsPerYear: P,
      income: taxIncome,
      nonPeriodic: taxNonPeriodic,
      pensionDeductions: taxPensionDeductions,
      nonPeriodicPensionDeductions: taxNonPeriodicPension,
      // The period's QPP under the fold (the whole period is one pay);
      // this run's share otherwise, which keeps a standalone provincial
      // calculation on its own contributions. The pensionable salary follows
      // the same split: the period's under the fold, this run's otherwise.
      qpp: foldBonus ? statutory.cpp : cpp,
      qpp2: foldBonus ? statutory.cpp2 : cpp2,
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
    const provincialTax =
      supplementalMethod === "per_run"
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
    ...(referencedBonusTax && bonusIncomeReference
      ? {
          ...referencedBonusTax.factors,
          // Annual claims and brackets belong to the bonus reference calculation;
          // periodic withholding still belongs to this payment alone.
          A_periodic: currentTax.factors.A_periodic!,
          TC_periodic: currentTax.factors.TC_periodic!,
          TCP_periodic: currentTax.factors.TCP_periodic!,
          T1_periodic: currentTax.factors.T1_periodic!,
          T2_periodic: currentTax.factors.T2_periodic!,
          TF: currentTax.factors.TF ?? "0.0000",
          TP: currentTax.factors.TP ?? "0.0000",
          T: currentTax.factors.T ?? currentTax.periodicTax,
          TB: referencedBonusTax.bonusTax,
          CA_BONUS_I_REFERENCE: bonusIncomeReference.income,
        }
      : {}),
    B: nonPeriodic,
    I: income,
    PI: pensionable,
    IE: insurable,
    F: deduction("pension_f"),
    F2: deduction("alimony"),
    U1: deduction("union_dues"),
    F3: deduction("pension_f_bonus"),
    ...(region !== "QC" ? { CPP_EXEMPTION: statutory.factors.CPP_EXEMPTION! } : {}),
    C: cpp,
    C2: cpp2,
    EI: ei,
    QPIP: qpip,
    QPIP_ER: qpipEmployer,
    EI_ER: eiEmployer,
    F5: f5,
    F5A: f5a,
    F5B: f5b,
    ...(hasPriors || foldBonus ? { T: federalTax } : {}),
    ...(incomeTaxOverride
      ? {
          // The Canadian non-Québec pack withholds federal and provincial tax
          // through one income_tax component, and T4 box 22 aggregates that line.
          // The operator supplies only the combined amount, so TF and TP remain
          // computed reference legs; no unsupported jurisdiction split is claimed.
          T: incomeTaxOverride.amount!,
          CA_TAX_OVERRIDE: incomeTaxOverride.amount!,
        }
      : {}),
    CA_PE: add(pensionable, neg(ctx.pensionableNonPeriodic)),
    CA_IE: add(insurable, neg(ctx.insurableNonPeriodic)),
    CA_QPIP_PE: add(qpipInsurable, neg(contributionBases.qpipNonPeriodic)),
    CA_BPE: ctx.pensionableNonPeriodic,
    CA_BIE: ctx.insurableNonPeriodic,
    CA_BQPIP: contributionBases.qpipNonPeriodic,
    CA_T_BASE: referencedBonusTax
      ? nonNegative(add(currentTax.periodicTax, neg(t4127Input.additionalTaxPerPeriod ?? "0")))
      : hasPriors || foldBonus
        ? nonNegative(add(federalTax, neg(t4127Input.additionalTaxPerPeriod ?? "0")))
        : add(statutory.periodicTax, neg(t4127Input.additionalTaxPerPeriod ?? "0")),
    // An assessed zero is retained history, unlike a missing basis factor.
    // Premium factors and lines remain conditional on assessable earnings.
    ...(cmp(wcbAssessable, "0") > 0 ? { WCB: wcbAmount } : {}),
    WCB_EARN: wcbAssessable,
    ...(wcbAdjustmentAmount !== undefined ? { WCB_ADJ: wcbAdjustmentAmount } : {}),
    ...(cmp(ehtEarnings, "0") > 0 ? { EHT: ehtAmount } : {}),
    EHT_EARN: ehtEarnings,
    ...(ehtAdjustmentAmount !== undefined ? { EHT_ADJ: ehtAdjustmentAmount } : {}),
    ...(cmp(hsfEarnings, "0") > 0 ? { HSF: hsfAmount } : {}),
    HSF_EARN: hsfEarnings,
    ...(cmp(cntEarnings, "0") > 0 ? { CNT: cntAmount } : {}),
    CNT_EARN: cntEarnings,
  };
}
