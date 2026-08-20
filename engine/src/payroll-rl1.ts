import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp } from "./money.ts";
import { RATES_2026_JAN } from "./payroll/canada/rates.ts";
import { PayrollError } from "./payroll-error.ts";
import type { PayrollFilingData } from "./payroll-filing-registry.ts";

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
 * gap, not an approximation (see .local/handoff-quebec.md).
 */

const num = (value: unknown): string => (value == null ? "0" : String(value));

/** Named for the year-end surface, so omission is published, never implied. */
export const RL1_UNSUPPORTED_BOXES =
  "RL-1 boxes D (RPP-only contributions) and J–W (benefit, commission and tip "
  + "attributions) are not populated: the payroll data cannot attribute them "
  + "without guessing. Enter them on the slips in Revenu Québec's services if "
  + "they apply.";

/**
 * Statutory caps for the RL-1 boxes, per tax year. REFUSES an unknown year —
 * same discipline as `caYearCaps` and `ratesForPayDate`: an uncapped box G/I
 * silently misstates pensionable and insurable salary on every slip.
 *
 * 2026 values (Guide RL-1.G s. 5.9/5.11 rule, TP-1015.F-V (2026-01) p. 7
 * amounts): YMPE 74,600; additional maximum (YAMPE) 85,000; QPIP maximum
 * insurable earnings 103,000.
 */
export function rl1YearCaps(taxYear: number): {
  ympe: string; yampe: string; qpipMie: string;
} {
  if (taxYear === 2026) {
    return {
      ympe: RATES_2026_JAN.qpp.ympe,
      yampe: RATES_2026_JAN.qpp.yampe,
      qpipMie: RATES_2026_JAN.qpip.mie,
    };
  }
  throw new PayrollError(
    `no Revenu Québec maximums for tax year ${taxYear} — RL-1 boxes G and I cannot be capped. `
    + "Add the year to engine/src/payroll-rl1.ts (rl1YearCaps) alongside the TP-1015.F-V edition",
  );
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
    boxI: capMoney(row.insurable, caps.qpipMie),
    stubCount: row.stubCount,
  };
}

/**
 * One RL-1 slip per employee with committed Québec-province stubs in the
 * year. `pay_stubs.province` is the per-stub snapshot, so a mid-year
 * QC↔elsewhere mover contributes exactly their Québec periods — the same
 * per-province attribution the T4 builder performs, seen from the RQ side.
 */
export async function rl1Slips(orgId: string, taxYear: number): Promise<Rl1Slip[]> {
  const caps = rl1YearCaps(taxYear);
  const rows = (await db.execute<Record<string, unknown>>(sql`
    with committed as (
      select s.*
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
        join employee_payroll_profiles prof
          on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
       where s.org_id = ${orgId} and s.tax_year = ${taxYear}
         and coalesce(prof.country, 'CA') = 'CA' and s.province = 'QC'
    )
    select c.employee_party_id, p.display_name,
           count(*)::int as stub_count,
           sum(c.pensionable_earnings) as pensionable,
           sum(c.insurable_earnings) as insurable,
           sum((c.factors->>'C')::numeric) as qpp,
           sum(coalesce((c.factors->>'C2')::numeric, 0)) as qpp2,
           sum((c.factors->>'EI')::numeric) as ei,
           sum(coalesce((c.factors->>'QPIP')::numeric, 0)) as qpip,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = c.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as taxable_income,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = c.id and l.kind = 'deduction'
                  and pc.system_key = 'qc_income_tax')) as qc_income_tax,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = c.id and l.kind = 'deduction'
                  and pc.tax_treatment = 'union_dues')) as union_dues
      from committed c
      join parties p on p.id = c.employee_party_id and p.org_id = ${orgId}
     group by c.employee_party_id, p.display_name
     order by p.display_name
  `));

  return rows.rows.map((row) => assembleRl1Slip({
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
    stubCount: Number(row.stub_count ?? 0),
  }, caps));
}

/**
 * RL-1 summary (RLZ-1.S worksheet) totals. The employer QPP/QPIP shares come
 * from the employer_contribution stub lines of the same Québec stubs, so the
 * summary always reconciles to the slips it accompanies.
 *
 * `gaps` names the RLZ-1.S lines this product does NOT produce, rather than
 * printing zeros an employer might file: the health services fund (a total-
 * payroll-rate employer levy, TP-1015.F-V s. 5), the CNT labour-standards
 * levy, the WSDRF training levy, and the year's remittances to Revenu Québec
 * (the remittance module tracks CRA destinations today).
 */
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
  gaps: string[];
}

export const RLZ1S_GAPS = [
  "health services fund contribution (TP-1015.F-V s. 5) is not computed",
  "labour standards (CNT) and WSDRF training contributions are not computed",
  "remittances made to Revenu Québec are not tracked by the remittance module",
];

export async function rl1Summary(orgId: string, taxYear: number): Promise<Rl1SummaryTotals> {
  const slips = await rl1Slips(orgId, taxYear);
  const employer = (await db.execute<{ employer_qpp: string | null; employer_qpip: string | null }>(sql`
    select
      sum(case when pc.system_key in ('cpp', 'cpp2') then l.amount else 0 end) as employer_qpp,
      sum(case when pc.system_key = 'qpip' then l.amount else 0 end) as employer_qpip
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join pay_components pc on pc.id = l.component_id
     where l.org_id = ${orgId} and s.tax_year = ${taxYear} and s.province = 'QC'
       and l.kind = 'employer_contribution' and coalesce(pc.country, 'CA') = 'CA'
  `));
  const total = (pick: (slip: Rl1Slip) => string) =>
    slips.reduce((acc, slip) => add(acc, pick(slip)), "0");
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
    employerQpp: num(employer.rows[0]?.employer_qpp),
    employerQpip: num(employer.rows[0]?.employer_qpip),
    gaps: [...RLZ1S_GAPS],
  };
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
  const cfg = (await db.execute<{ id_number: string | null }>(sql`
    select settings#>>'{payroll,rl1Transmitter,identificationNumber}' as id_number
      from orgs where id = ${orgId}
  `));
  return {
    identificationNumber: cfg.rows[0]?.id_number ?? null,
    slips: await rl1Slips(orgId, taxYear),
    summary: await rl1Summary(orgId, taxYear),
  };
}

/**
 * The year-end filing population, typed against the filing registry so the
 * CA pack declaration registers it as-is (see .local/handoff-quebec.md — the
 * declaration itself lives in engine/src/payroll/canada/filings.ts).
 */
export async function rl1Population(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const summary = await rl1Summary(orgId, taxYear);
  const slips = await rl1Slips(orgId, taxYear);
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
    ],
  };
}
