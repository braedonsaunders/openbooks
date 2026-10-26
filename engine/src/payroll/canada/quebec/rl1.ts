import { assertQpipReportingBasis, qpipReportingBasisColumns } from "../qpip-reporting-basis.ts";
import { withOpeningReportingSnapshot } from "../../opening-reporting-snapshot.ts";
import { readCanadianOpeningYearEndSlices } from "../opening-reporting-yearend.ts";
import { assertPayrollCountryKnown } from "../../country.ts";
import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../../../platform/db.ts";
import { add, cmp, mulPercent, neg } from "../../../money/money.ts";
import { resolveEmployerFact } from "../../employer-facts.ts";
import { canadianYearEndCaps } from "../yearend-caps.ts";
import { PayrollError } from "../../error.ts";
import type { PayrollFilingData } from "../../filing-registry.ts";
import { type OpeningYearEndYtd } from "../../yearend.ts";

/**
 * RL-1 slip data assembly — Revenu Québec's "Revenus d'emploi et revenus
 * divers", the Québec-side year-end slip a QC employee receives ALONGSIDE
 * their T4. Built from committed stubs (the payroll subledger of record)
 * exactly as `t4Slips` is, so every box reconciles to stub factors.
 *
 * Box definitions transcribed from the Guide du relevé 1 (RL-1.G), Part 5
 * ("Comment remplir le relevé 1") — the published RQ guide, not memory:
 *   A    Revenus d'emploi (s. 5.3)
 *   B.A  Cotisation au RRQ — base + first additional (s. 5.4)
 *   B.B  Cotisation supplémentaire au RRQ — second additional (s. 5.4)
 *   C    Cotisation à l'assurance emploi (s. 5.5)
 *   E    Impôt du Québec retenu (s. 5.7)
 *   F    Cotisation syndicale (s. 5.8)
 *   G    Salaire admissible au RRQ (s. 5.9) — capped at the year's maximum
 *        pensionable earnings when only B.A has an amount, and at the
 *        ADDITIONAL maximum pensionable earnings when B.B does too
 *   H    Cotisation au RQAP (s. 5.10)
 *   I    Salaire admissible au RQAP (s. 5.11) — capped at the year's QPIP
 *        maximum insurable earnings
 *
 * Boxes the payroll data cannot honestly populate are OMITTED, not zeroed
 * with a guess, and named in `RL1_UNSUPPORTED_BOXES`:
 *   D (RPP contribution only) — the component model's 'pension_f' treatment
 *     is TP-1015.F-V's whole factor-F class (RPP + RRSP + VRSP/PRPP + FHSA
 *     + …), and box D takes strictly RPP; reporting the class as the box
 *     would overstate D for any employee with an RRSP component. The T4
 *     builder omits its box 20 for the same reason.
 *   J–W and the box-O codes — benefit/commission/tip attributions no stub
 *     line carries today.
 *
 * The RL-1 is filed under the employer's Revenu Québec identification
 * number — a DIFFERENT registration from the CRA payroll (RP) program
 * account every other Canadian filing here groups by. That identity is
 * tenant configuration (see payroll-rl1xml.ts); an org holds one, so the
 * year's slips assemble into ONE return. Employers filing under several RQ
 * numbers need an RQ program type on payroll_filing_accounts first — a named
 * gap, not an approximation.
 */

const num = (value: unknown): string => (value == null ? "0" : String(value));

/** Named for the year-end surface, so omission is published, never implied. */
export const RL1_UNSUPPORTED_BOXES =
  "RL-1 boxes D (RPP-only contributions) and J–W (benefit, commission and tip " +
  "attributions) are not populated: the payroll data cannot attribute them " +
  "without guessing. Enter them on the slips in Revenu Québec's services if " +
  "they apply.";

/**
 * Statutory caps for the RL-1 boxes, per tax year. REFUSES an unknown year —
 * same discipline as `caYearCaps` and `ratesForPayDate`: an uncapped box G/I
 * silently misstates pensionable and insurable salary on every slip.
 *
 * The caps come from the filing year's published T4127 edition, which carries
 * the authoritative QPP and QPIP maximums used by the RL-1 boxes.
 */
export function rl1YearCaps(taxYear: number): {
  ympe: string;
  yampe: string;
  qpipMie: string;
} {
  const caps = canadianYearEndCaps(taxYear);
  return { ympe: caps.qppYmpe, yampe: caps.qppYampe, qpipMie: caps.qpipMie };
}

export interface Rl1Slip {
  employeePartyId: string;
  employeeName: string;
  /** Box A — employment income (taxable earnings on QC stubs). */
  boxA: string;
  /** Box B.A — QPP contribution (base + first additional). */
  boxBA: string;
  /** Box B.B — second additional QPP contribution. */
  boxBB: string;
  /** Box C — EI premium (at the Québec-reduced rate). */
  boxC: string;
  /** Box E — Québec income tax withheld (qc_income_tax lines). */
  boxE: string;
  /** Box F — union dues withheld. */
  boxF: string;
  /** Box G — QPP pensionable salary, capped (YMPE, or YAMPE when B.B > 0). */
  boxG: string;
  /** Box H — QPIP premium. */
  boxH: string;
  /** Box I — QPIP eligible salary, capped at the QPIP maximum. */
  boxI: string;
  stubCount: number;
}

/** The raw per-employee aggregates `rl1Slips` reads from committed stubs. */
export interface Rl1SlipAggregates {
  employeePartyId: string;
  employeeName: string;
  taxableIncome: string;
  qpp: string;
  qpp2: string;
  ei: string;
  qpip: string;
  qcIncomeTax: string;
  unionDues: string;
  pensionable: string;
  insurable: string;
  /** The QPIP program's own insurable base (box I source), never the EI base. */
  qpipInsurable: string;
  stubCount: number;
}

/**
 * Pure box mapping, separated from the SQL so the cap rules are testable
 * without a database (the `capAnnualEarnings` pattern).
 *
 * Box G's cap depends on box B.B (RL-1.G s. 5.9): the maximum pensionable
 * earnings when only B.A has an amount, the ADDITIONAL maximum when B.B does
 * too. Box I caps at the QPIP maximum insurable earnings (s. 5.11). Both are
 * exact string-money comparisons — no floats.
 */
export function assembleRl1Slip(
  row: Rl1SlipAggregates,
  caps: { ympe: string; yampe: string; qpipMie: string },
): Rl1Slip {
  const capMoney = (value: string, cap: string) => (cmp(value, cap) > 0 ? cap : value);
  const hasSecondAdditional = cmp(row.qpp2, "0") > 0;
  return {
    employeePartyId: row.employeePartyId,
    employeeName: row.employeeName,
    boxA: row.taxableIncome,
    boxBA: row.qpp,
    boxBB: row.qpp2,
    boxC: row.ei,
    boxE: row.qcIncomeTax,
    boxF: row.unionDues,
    boxG: capMoney(row.pensionable, hasSecondAdditional ? caps.yampe : caps.ympe),
    boxH: row.qpip,
    // Box I is the QPIP program's OWN insurable base capped at the QPIP
    // maximum — never the EI base (box C's source).
    boxI: capMoney(row.qpipInsurable, caps.qpipMie),
    stubCount: row.stubCount,
  };
}

/**
 * One RL-1 slip per employee with committed Québec-province stubs in the
 * year. `pay_stubs.province` is the per-stub snapshot, so a mid-year
 * QC↔elsewhere mover contributes exactly their Québec periods — the same
 * per-province attribution the T4 builder performs, seen from the RQ side.
 */
async function rl1SlipsInSnapshot(
  runner: SqlExecutor,
  orgId: string,
  taxYear: number,
): Promise<Rl1Slip[]> {
  await assertPayrollCountryKnown(runner, orgId, taxYear);
  const caps = rl1YearCaps(taxYear);
  const rows = await runner.execute<Record<string, unknown>>(
    sql`
    with committed as (
      select s.*
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
        join documents d on d.org_id=r.org_id and d.id=r.document_id and d.status<>'voided'
       where s.org_id = ${orgId} and s.tax_year = ${taxYear}
         and s.country = 'CA' and s.province = 'QC'
    )
    select c.employee_party_id, p.display_name,
           min(c.pay_date)::text as first_pay_date,
           count(*)::int as stub_count,
           sum(c.pensionable_earnings) as pensionable,
           sum(c.insurable_earnings) as insurable,
           sum((c.factors->>'C')::numeric) as qpp,
           sum(coalesce((c.factors->>'C2')::numeric, 0)) as qpp2,
           sum((c.factors->>'EI')::numeric) as ei,
           sum(coalesce((c.factors->>'QPIP')::numeric, 0)) as qpip,
           ${qpipReportingBasisColumns(sql`c.factors`)},
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as taxable_income,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'deduction'
                  and pc.system_key = 'qc_income_tax')) as qc_income_tax,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'deduction'
                  and pc.tax_treatment = 'union_dues')) as union_dues
      from committed c
      join parties p on p.id = c.employee_party_id and p.org_id = ${orgId}
     group by c.employee_party_id, p.display_name
     order by p.display_name
  `,
    "objects",
  );

  for (const row of rows)
    assertQpipReportingBasis(String(row.display_name), Number(row.invalid_qpip_bases));
  const stubAggregates: Rl1SlipAggregates[] = rows.map((row) => ({
    employeePartyId: String(row.employee_party_id),
    employeeName: String(row.display_name),
    taxableIncome: num(row.taxable_income),
    qpp: num(row.qpp),
    qpp2: num(row.qpp2),
    ei: num(row.ei),
    qpip: num(row.qpip),
    qcIncomeTax: num(row.qc_income_tax),
    unionDues: num(row.union_dues),
    pensionable: num(row.pensionable),
    insurable: num(row.insurable),
    qpipInsurable: num(row.qpip_insurable),
    stubCount: Number(row.stub_count ?? 0),
  }));

  const originalSlices = (await readCanadianOpeningYearEndSlices(runner, orgId, taxYear)).filter(
    (slice) => slice.allocation.province === "QC",
  );
  for (const row of rows) {
    const source = originalSlices.find(
      (slice) => slice.employeePartyId === String(row.employee_party_id),
    );
    if (source && String(row.first_pay_date) <= source.coverageEnd)
      throw new PayrollError(
        "Committed Québec payroll overlaps the certified original reporting coverage — reconcile its original carry-in before preparing RL-1 slips",
      );
  }
  const result = new Map(stubAggregates.map((row) => [row.employeePartyId, row]));
  for (const slice of originalSlices) {
    const current = result.get(slice.employeePartyId) ?? {
      employeePartyId: slice.employeePartyId,
      employeeName: slice.employeeName,
      taxableIncome: "0",
      qpp: "0",
      qpp2: "0",
      ei: "0",
      qpip: "0",
      qcIncomeTax: "0",
      unionDues: "0",
      pensionable: "0",
      insurable: "0",
      qpipInsurable: "0",
      stubCount: 0,
    };
    result.set(
      slice.employeePartyId,
      openingYtdIntoRl1Aggregates(current, {
        ...slice.ytd,
        pensionableYtd: slice.allocation.reportableBases.cpp,
        programBasesYtd: {
          ...slice.ytd.programBasesYtd,
          qpip: slice.allocation.reportableBases.qpip,
        },
      }),
    );
  }
  const carried = [...result.values()];
  return carried.map((row) => assembleRl1Slip(row, caps));
}

/**
 * Fold one employee's pre-adoption year-to-date into their RL-1 aggregates —
 * the same carry-in the T4 (`openingYtdIntoT4Slip`) and W-2 builders perform,
 * so a mid-year adopter's RL-1 reconciles to the prior provider's YTD report
 * exactly as their T4 does.
 *
 * Carried: taxable (box A), QPP/QPP2 (boxes B.A/B.B — `cpp_ytd` is the QPP
 * column for Québec employment, as the T4's own box-17 mapping reads it), EI
 * premiums (box C), QPIP premiums (box H), union dues (box F), and the
 * QPP-pensionable base (box G, capped with the stubs by `assembleRl1Slip`
 * below, never after it).
 *
 * Each carried box reads its own carry-in column. Québec income tax (box E)
 * reads only `qc_tax_ytd`: `tax_ytd` is the T4-box-22 federal money, not
 * the Québec slice, so carrying it would invent a Québec return. Union
 * dues (box F) read `union_dues_ytd`. Box I
 * IS carried: the QPIP program's OWN insurable base arrives in
 * `programBasesYtd` under the pack-declared program key and is capped at
 * the QPIP maximum with the stubs below — never the EI base
 * (`insurable_ytd`), which would invent a Québec return. Absent key means
 * no pre-adoption QPIP base, never a guess.
 */
export function openingYtdIntoRl1Aggregates(
  row: Rl1SlipAggregates,
  opening: OpeningYearEndYtd,
): Rl1SlipAggregates {
  return {
    ...row,
    taxableIncome: add(row.taxableIncome, opening.taxableYtd),
    qcIncomeTax: add(row.qcIncomeTax, opening.qcTaxYtd ?? "0"),
    qpp: add(row.qpp, opening.cppYtd),
    qpp2: add(row.qpp2, opening.cpp2Ytd),
    ei: add(row.ei, opening.eiYtd),
    qpip: add(row.qpip, opening.qpipYtd),
    unionDues: add(row.unionDues, opening.unionDuesYtd ?? "0"),
    pensionable: add(row.pensionable, opening.pensionableYtd),
    qpipInsurable: add(row.qpipInsurable, opening.programBasesYtd["qpip"] ?? "0"),
  };
}

/**
 * RL-1 summary (RLZ-1.S worksheet) totals. The employer QPP/QPIP shares come
 * from the employer_contribution stub lines of the same Québec stubs, so the
 * summary always reconciles to the slips it accompanies.
 *
 * `gaps` names the RLZ-1.S lines this product does NOT produce, rather than
 * printing zeros an employer might file: the health services fund annual
 * total (per-stub HSF accrues at the tenant-entered QC rate, but the RLZ-1.S
 * annual reconciliation is not produced), the CNT labour-standards levy
 * annual reconciliation (per-stub CNT accrues at the statutory 2026 rate,
 * but the RLZ-1.S annual reconciliation is not produced), and the year's
 * remittances made to Revenu
 * Québec. The last is a reporting boundary, not a tracking gap: RQ
 * remittance bills are dated and tracked per destination from the RQ schedule
 * (see Payroll → Remittances), but this summary does not reconcile
 * remittances-made totals against them.
 */
export type WsdrfStatus =
  | "below_threshold"
  | "exempt_certificate"
  | "computed"
  | "missing_training_expenditures"
  | "ambiguous_facts";

export interface Rl1SummaryTotals {
  slips: number;
  boxA: string;
  boxBA: string;
  boxBB: string;
  boxC: string;
  boxE: string;
  boxF: string;
  boxG: string;
  boxH: string;
  boxI: string;
  employerQpp: string;
  employerQpip: string;
  /** Eligible Québec payroll: committed QC stub gross, the employer as a whole. */
  wsdrfEligiblePayroll: string;
  /** Declared eligible training expenditures, or null when undeclared. */
  wsdrfTrainingExpenditures: string | null;
  /** A valid certificat de qualité is on file. */
  wsdrfQualityCertificate: boolean;
  /** The 1% shortfall owed, or null when the inputs do not determine it. */
  wsdrfShortfall: string | null;
  /** Last day of next February, when a shortfall is owed. */
  wsdrfDueDate: string | null;
  wsdrfStatus: WsdrfStatus;
  gaps: string[];
}

export const RLZ1S_GAPS = [
  "health services fund annual total is not reconciled on this summary — per-stub HSF accrues " +
    "at the tenant-entered QC rate (TP-1015.F-V s. 5)",
  "labour standards (CNT) annual total is not reconciled on this summary — per-stub CNT accrues " +
    "at the statutory 2026 rate (0.06% to $103,000 per employee)",
  "remittances made to Revenu Québec during the year are not reconciled on this summary — " +
    "Payroll → Remittances dates and tracks each RQ bill from the RQ schedule",
];

/**
 * The WSDRF payroll threshold: employers with $2M or more of Québec payroll
 * owe 1% of payroll less eligible training expenditures (holders of a valid
 * quality certificate are exempt). Revenu Québec, Contribution to the
 * Workforce Skills Development and Recognition Fund.
 */
export const WSDRF_PAYROLL_THRESHOLD = "2000000";
export const WSDRF_RATE_PERCENT = "1";

/** Last day of February following the tax year: the WSDRF payment due date. */
export function wsdrfDueDate(taxYear: number): string {
  const year = taxYear + 1;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return `${year}-02-${leap ? "29" : "28"}`;
}

async function rl1SummaryInSnapshot(
  runner: SqlExecutor,
  orgId: string,
  taxYear: number,
  slips: readonly Rl1Slip[],
): Promise<Rl1SummaryTotals> {
  const employer = await runner.execute<{
    employer_qpp: string | null;
    employer_qpip: string | null;
  }>(
    sql`
    select
      sum(case when pc.system_key in ('cpp', 'cpp2') then l.amount else 0 end) as employer_qpp,
      sum(case when pc.system_key = 'qpip' then l.amount else 0 end) as employer_qpip
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
     where l.org_id = ${orgId} and s.tax_year = ${taxYear} and s.province = 'QC'
       -- A null component country is SHARED baseline, not an unknown to
       -- default: shared rows apply to every pack's employees.
       and l.kind = 'employer_contribution' and (pc.country is null or pc.country = 'CA')
  `,
    "objects",
  );
  const total = (pick: (slip: Rl1Slip) => string) =>
    slips.reduce((acc, slip) => add(acc, pick(slip)), "0");
  const wsdrf = await wsdrfForSummary(runner, orgId, taxYear);
  const gaps = [...RLZ1S_GAPS];
  if (wsdrf.status === "missing_training_expenditures") {
    gaps.push(
      "WSDRF training contribution is not determined — record the year's eligible training " +
        "expenditures (or a valid quality certificate) in Payroll Setup → Employer facts before " +
        "filing; the 1% shortfall is never assumed to be zero",
    );
  } else if (wsdrf.status === "ambiguous_facts") {
    gaps.push(
      "WSDRF training contribution is not determined — the legal employers hold conflicting " +
        "training-expenditure or quality-certificate values for this year; reconcile them in " +
        "Payroll Setup → Employer facts before filing",
    );
  }
  return {
    slips: slips.length,
    boxA: total((s) => s.boxA),
    boxBA: total((s) => s.boxBA),
    boxBB: total((s) => s.boxBB),
    boxC: total((s) => s.boxC),
    boxE: total((s) => s.boxE),
    boxF: total((s) => s.boxF),
    boxG: total((s) => s.boxG),
    boxH: total((s) => s.boxH),
    boxI: total((s) => s.boxI),
    employerQpp: num(employer[0]?.employer_qpp),
    employerQpip: num(employer[0]?.employer_qpip),
    wsdrfEligiblePayroll: wsdrf.eligiblePayroll,
    wsdrfTrainingExpenditures: wsdrf.trainingExpenditures,
    wsdrfQualityCertificate: wsdrf.qualityCertificate,
    wsdrfShortfall: wsdrf.shortfall,
    wsdrfDueDate: wsdrf.dueDate,
    wsdrfStatus: wsdrf.status,
    gaps,
  };
}

/**
 * The WSDRF training-levy position for the RL-1 summary: 1% of the
 * employer's eligible Québec payroll less declared eligible training
 * expenditures, due the last day of next February — or the named reason it
 * cannot be determined. Eligible payroll is the committed QC stub gross,
 * the employer as a whole, from the same subledger the boxes reconcile to
 * (pre-adoption payroll before OpenBooks is not in that subledger and is
 * not estimated). Facts resolve org-wide across legal employers: one value
 * wins, conflicting values refuse as ambiguous rather than picking one.
 */
async function wsdrfForSummary(
  runner: SqlExecutor,
  orgId: string,
  taxYear: number,
): Promise<{
  eligiblePayroll: string;
  trainingExpenditures: string | null;
  qualityCertificate: boolean;
  shortfall: string | null;
  dueDate: string | null;
  status: WsdrfStatus;
}> {
  const payroll =
    (
      await runner.execute<{ payroll: string }>(
        sql`
    select coalesce(sum(s.gross), 0)::text as payroll
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
     where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.province = 'QC'
  `,
        "objects",
      )
    )[0]?.payroll ?? "0";
  const asOf = `${taxYear}-12-31`;
  const stored = await runner.execute<{ fact_key: string; fact_value: string }>(
    sql`
    select distinct fact_key, fact_value
      from payroll_employer_facts
     where org_id = ${orgId} and country = 'CA'
       and fact_key in ('qc_wsdrf_training_expenditures', 'qc_wsdrf_quality_certificate')
       and effective_from <= ${asOf}::date
       and (superseded_on is null or superseded_on > ${asOf}::date)
  `,
    "objects",
  );
  const values = (key: string): string[] =>
    stored.filter((row) => row.fact_key === key).map((row) => row.fact_value);
  const expendituresRaw = values("qc_wsdrf_training_expenditures");
  const certificateRaw = values("qc_wsdrf_quality_certificate");
  if (expendituresRaw.length > 1 || certificateRaw.length > 1) {
    return {
      eligiblePayroll: num(payroll),
      trainingExpenditures: null,
      qualityCertificate: false,
      shortfall: null,
      dueDate: null,
      status: "ambiguous_facts",
    };
  }
  const trainingExpenditures =
    expendituresRaw.length === 0
      ? null
      : resolveEmployerFact("CA", "qc_wsdrf_training_expenditures", expendituresRaw[0]);
  const qualityCertificate =
    certificateRaw.length !== 0 &&
    resolveEmployerFact("CA", "qc_wsdrf_quality_certificate", certificateRaw[0]) === "true";
  if (cmp(num(payroll), WSDRF_PAYROLL_THRESHOLD) < 0) {
    return {
      eligiblePayroll: num(payroll),
      trainingExpenditures,
      qualityCertificate,
      shortfall: "0",
      dueDate: null,
      status: "below_threshold",
    };
  }
  if (qualityCertificate) {
    return {
      eligiblePayroll: num(payroll),
      trainingExpenditures,
      qualityCertificate,
      shortfall: "0",
      dueDate: null,
      status: "exempt_certificate",
    };
  }
  if (trainingExpenditures === null) {
    return {
      eligiblePayroll: num(payroll),
      trainingExpenditures,
      qualityCertificate,
      shortfall: null,
      dueDate: null,
      status: "missing_training_expenditures",
    };
  }
  const owing = add(mulPercent(num(payroll), WSDRF_RATE_PERCENT, 2), neg(trainingExpenditures));
  return {
    eligiblePayroll: num(payroll),
    trainingExpenditures,
    qualityCertificate,
    shortfall: cmp(owing, "0") > 0 ? owing : "0",
    dueDate: wsdrfDueDate(taxYear),
    status: "computed",
  };
}

/** Build the public slip population under the same pinned source-year snapshot as the return. */
export async function rl1Slips(orgId: string, taxYear: number): Promise<Rl1Slip[]> {
  return withOpeningReportingSnapshot(orgId, taxYear, (tx) =>
    rl1SlipsInSnapshot(tx, orgId, taxYear),
  );
}

export async function rl1Summary(orgId: string, taxYear: number): Promise<Rl1SummaryTotals> {
  return withOpeningReportingSnapshot(orgId, taxYear, async (tx) => {
    const slips = await rl1SlipsInSnapshot(tx, orgId, taxYear);
    return rl1SummaryInSnapshot(tx, orgId, taxYear, slips);
  });
}

/** The year's RL-1 return: every QC slip under the org's RQ identification. */
export interface Rl1Return {
  /** The employer's Revenu Québec identification number, when configured
   *  (orgs.settings.payroll.rl1Transmitter.identificationNumber). */
  identificationNumber: string | null;
  slips: Rl1Slip[];
  summary: Rl1SummaryTotals;
}

export async function rl1Return(orgId: string, taxYear: number): Promise<Rl1Return> {
  return withOpeningReportingSnapshot(orgId, taxYear, async (tx) => {
    const cfg = await tx.execute<{ id_number: string | null }>(
      sql`
        select settings#>>'{payroll,rl1Transmitter,identificationNumber}' as id_number
          from orgs where id = ${orgId}
      `,
      "objects",
    );
    const slips = await rl1SlipsInSnapshot(tx, orgId, taxYear);
    return {
      identificationNumber: cfg[0]?.id_number ?? null,
      slips,
      summary: await rl1SummaryInSnapshot(tx, orgId, taxYear, slips),
    };
  });
}

/**
 * The year-end filing population, typed against the filing registry so the
 * CA pack declaration registers it as-is; that declaration lives in
 * engine/src/payroll/canada/filings.ts.
 */
export async function rl1Population(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  return withOpeningReportingSnapshot(orgId, taxYear, async (tx) => {
    const slips = await rl1SlipsInSnapshot(tx, orgId, taxYear);
    const summary = await rl1SummaryInSnapshot(tx, orgId, taxYear, slips);
    return {
      rowKey: "employeePartyId",
      columns: [
        { key: "employee", label: "Employee" },
        { key: "boxA", label: "Box A income", align: "right", money: true },
        { key: "boxB", label: "Box B.A/B.B QPP", align: "right", money: true },
        { key: "boxC", label: "Box C EI", align: "right", money: true },
        { key: "boxE", label: "Box E Québec tax", align: "right", money: true },
        { key: "boxG", label: "Box G QPP salary", align: "right", money: true },
        { key: "boxH", label: "Box H QPIP", align: "right", money: true },
        { key: "boxI", label: "Box I QPIP salary", align: "right", money: true },
        { key: "boxF", label: "Box F dues", align: "right", money: true },
      ],
      rows: slips.map((slip) => ({
        employeePartyId: slip.employeePartyId,
        employee: slip.employeeName,
        boxA: slip.boxA,
        // B.A + B.B together, as the T4 population shows 16 + 16A.
        boxB: add(slip.boxBA, slip.boxBB),
        boxC: slip.boxC,
        boxE: slip.boxE,
        boxG: slip.boxG,
        boxH: slip.boxH,
        boxI: slip.boxI,
        boxF: slip.boxF,
      })),
      totals: [
        { label: "Slips", value: String(summary.slips) },
        { label: "Box A employment income", value: summary.boxA, money: true },
        {
          label: "QPP (employee + employer)",
          value: add(add(summary.boxBA, summary.boxBB), summary.employerQpp),
          money: true,
        },
        {
          label: "QPIP (employee + employer)",
          value: add(summary.boxH, summary.employerQpip),
          money: true,
        },
        { label: "Québec income tax", value: summary.boxE, money: true },
        // The annual WSDRF position rides the filing face: the shortfall
        // with its due date when owed, or the named reason it cannot be
        // determined — never a silent zero.
        ...(summary.wsdrfStatus === "computed" && summary.wsdrfShortfall !== null
          ? [
              {
                label: `WSDRF training levy shortfall (due ${summary.wsdrfDueDate})`,
                value: summary.wsdrfShortfall,
                money: true,
              },
            ]
          : summary.wsdrfStatus === "missing_training_expenditures" ||
              summary.wsdrfStatus === "ambiguous_facts"
            ? [{ label: "WSDRF training levy", value: "not determined — see RL-1 summary gaps" }]
            : []),
      ],
    };
  });
}
