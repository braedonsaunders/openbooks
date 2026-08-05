import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add } from "./money.ts";
import { RATES_2026_JAN } from "./payroll/canada/rates.ts";

/**
 * Year-end payroll artifacts, built from committed stubs (the payroll
 * subledger of record):
 *
 * - Canada: T4 slip box data per employee + the T4 Summary totals, and the
 *   ROE insurable-earnings worksheet (block 15A/15B/15C source data).
 * - US: Form 941 quarterly worksheet + W-2 box data per employee.
 *
 * These are DATA builders — the UI renders slips/printables and the numbers
 * always reconcile to stub factors, so every box is explainable line by
 * line. Filing-record integration (CRA XML / SSA EFW2 transmission) layers
 * on later without changing the math here.
 */

const num = (value: unknown): string => (value == null ? "0" : String(value));

/** Statutory caps per tax year (extend each January alongside the engines). */
function caYearCaps(taxYear: number): { mie: string; yampe: string } | null {
  if (taxYear === 2026) return { mie: RATES_2026_JAN.ei.mie, yampe: RATES_2026_JAN.cpp.yampe };
  return null;
}

export interface T4Slip {
  employeePartyId: string;
  employeeName: string;
  province: string;
  isQuebec: boolean;
  /** T4 boxes (QPP amounts land in the QPP boxes for Quebec on the render). */
  box14EmploymentIncome: string;
  box16Cpp: string;
  box16aCpp2: string;
  box18Ei: string;
  box22IncomeTax: string;
  box24EiInsurable: string;
  box26CppPensionable: string;
  box44UnionDues: string;
  box55Qpip: string;
  stubCount: number;
}

export interface T4SummaryTotals {
  slips: number;
  employmentIncome: string;
  employeeCpp: string;
  employeeCpp2: string;
  employerCpp: string;
  employeeEi: string;
  employerEi: string;
  incomeTax: string;
  /** Posted payroll-remittance bills to the CRA vendor in the year. */
  remitted: string;
}

export async function t4Slips(orgId: string, taxYear: number): Promise<T4Slip[]> {
  const caps = caYearCaps(taxYear);
  const rows = (await db.execute(sql`
    with committed as (
      select s.* from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join employee_payroll_profiles prof
        on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
     where s.org_id = ${orgId} and s.tax_year = ${taxYear}
       and coalesce(prof.country, 'CA') = 'CA'
    )
    select c.employee_party_id, p.display_name,
           max(c.province) as province,
           count(*)::int as stub_count,
           sum(c.pensionable_earnings) as pensionable,
           sum(c.insurable_earnings) as insurable,
           sum((c.factors->>'C')::numeric) as cpp,
           sum(coalesce((c.factors->>'C2')::numeric, 0)) as cpp2,
           sum((c.factors->>'EI')::numeric) as ei,
           sum(coalesce((c.factors->>'QPIP')::numeric, 0)) as qpip,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = c.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as taxable_income,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = c.id and l.kind = 'deduction'
                  and pc.system_key = 'income_tax')) as income_tax,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = c.id and l.kind = 'deduction'
                  and pc.tax_treatment = 'union_dues')) as union_dues
      from committed c
      join parties p on p.id = c.employee_party_id and p.org_id = ${orgId}
     group by c.employee_party_id, p.display_name
     order by p.display_name
  `)) as unknown as { rows: Record<string, unknown>[] };

  return rows.rows.map((row) => {
    const insurable = num(row.insurable);
    const pensionable = num(row.pensionable);
    const capMoney = (value: string, cap: string | undefined) =>
      cap !== undefined && Number(value) > Number(cap) ? cap : value;
    return {
      employeePartyId: String(row.employee_party_id),
      employeeName: String(row.display_name),
      province: String(row.province ?? ""),
      isQuebec: row.province === "QC",
      box14EmploymentIncome: num(row.taxable_income),
      box16Cpp: num(row.cpp),
      box16aCpp2: num(row.cpp2),
      box18Ei: num(row.ei),
      box22IncomeTax: num(row.income_tax),
      box24EiInsurable: capMoney(insurable, caps?.mie),
      box26CppPensionable: capMoney(pensionable, caps?.yampe),
      box44UnionDues: num(row.union_dues),
      box55Qpip: num(row.qpip),
      stubCount: Number(row.stub_count ?? 0),
    };
  });
}

export async function t4Summary(orgId: string, taxYear: number): Promise<T4SummaryTotals> {
  const slips = await t4Slips(orgId, taxYear);
  const employer = (await db.execute(sql`
    select
      sum(case when pc.system_key in ('cpp', 'cpp2') then l.amount else 0 end) as employer_cpp,
      sum(case when pc.system_key = 'ei' then l.amount else 0 end) as employer_ei
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join pay_components pc on pc.id = l.component_id
     where l.org_id = ${orgId} and s.tax_year = ${taxYear}
       and l.kind = 'employer_contribution' and coalesce(pc.country, 'CA') = 'CA'
  `)) as unknown as { rows: { employer_cpp: string | null; employer_ei: string | null }[] };
  const remitted = (await db.execute(sql`
    select coalesce(sum(total), 0) as amount from documents
     where org_id = ${orgId} and kind = 'vendor_bill' and status = 'posted'
       and custom ? 'payrollRemittance'
       and custom->'payrollRemittance'->>'to' like ${`${taxYear}-%`}
  `)) as unknown as { rows: { amount: string }[] };
  const total = (pick: (slip: T4Slip) => string) =>
    slips.reduce((acc, slip) => add(acc, pick(slip)), "0");
  return {
    slips: slips.length,
    employmentIncome: total((s) => s.box14EmploymentIncome),
    employeeCpp: total((s) => s.box16Cpp),
    employeeCpp2: total((s) => s.box16aCpp2),
    employerCpp: num(employer.rows[0]?.employer_cpp),
    employeeEi: total((s) => s.box18Ei),
    employerEi: num(employer.rows[0]?.employer_ei),
    incomeTax: total((s) => s.box22IncomeTax),
    remitted: num(remitted.rows[0]?.amount),
  };
}

export interface RoePeriod {
  payDate: string;
  periodStart: string;
  periodEnd: string;
  insurableEarnings: string;
  insurableHours: string;
}

/** ROE worksheet: recent committed periods, newest first (blocks 15A–15C). */
export async function roeWorksheet(
  orgId: string,
  employeePartyId: string,
  limit = 27,
): Promise<{ periods: RoePeriod[]; totalInsurableEarnings: string; totalInsurableHours: string }> {
  const rows = (await db.execute(sql`
    select s.pay_date, r.period_start, r.period_end, s.insurable_earnings,
           (select coalesce(sum(l.hours), 0) from pay_stub_lines l
             where l.stub_id = s.id and l.kind = 'earning') as hours
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
     where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
     order by s.pay_date desc
     limit ${limit}
  `)) as unknown as {
    rows: { pay_date: string; period_start: string; period_end: string; insurable_earnings: string; hours: string }[];
  };
  const periods = rows.rows.map((row) => ({
    payDate: row.pay_date, periodStart: row.period_start, periodEnd: row.period_end,
    insurableEarnings: row.insurable_earnings, insurableHours: num(row.hours),
  }));
  return {
    periods,
    totalInsurableEarnings: periods.reduce((acc, p) => add(acc, p.insurableEarnings), "0"),
    totalInsurableHours: periods.reduce((acc, p) => add(acc, p.insurableHours), "0"),
  };
}

export interface Form941Quarter {
  quarter: 1 | 2 | 3 | 4;
  wages: string;
  federalIncomeTax: string;
  ssWages: string;
  ssTax: string; // employee + employer
  medicareWages: string;
  medicareTax: string; // employee + employer, incl. Additional Medicare
}

export async function form941Worksheet(orgId: string, taxYear: number): Promise<Form941Quarter[]> {
  const rows = (await db.execute(sql`
    select extract(quarter from s.pay_date)::int as quarter,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = s.id and l.kind = 'earning' and coalesce(pc.taxable, true))) as wages,
           sum(coalesce((s.factors->>'SS_TAXABLE')::numeric, 0)) as ss_wages,
           sum(s.pensionable_earnings) as medicare_wages,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = s.id and pc.system_key = 'fit')) as fit,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = s.id and pc.system_key = 'ss')) as ss_tax,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = s.id and pc.system_key in ('medicare', 'medicare_addl'))) as medicare_tax
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join employee_payroll_profiles prof
        on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id and prof.country = 'US'
     where s.org_id = ${orgId} and s.tax_year = ${taxYear}
     group by 1 order by 1
  `)) as unknown as { rows: Record<string, unknown>[] };
  return rows.rows.map((row) => ({
    quarter: Number(row.quarter) as 1 | 2 | 3 | 4,
    wages: num(row.wages),
    federalIncomeTax: num(row.fit),
    ssWages: num(row.ss_wages),
    ssTax: num(row.ss_tax),
    medicareWages: num(row.medicare_wages),
    medicareTax: num(row.medicare_tax),
  }));
}

export interface W2Slip {
  employeePartyId: string;
  employeeName: string;
  state: string;
  box1Wages: string;
  box2FederalIncomeTax: string;
  box3SsWages: string;
  box4SsTax: string;
  box5MedicareWages: string;
  box6MedicareTax: string;
}

export async function w2Slips(orgId: string, taxYear: number): Promise<W2Slip[]> {
  const rows = (await db.execute(sql`
    select s.employee_party_id, p.display_name, max(s.province) as state,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = s.id and l.kind = 'earning' and coalesce(pc.taxable, true))) as wages,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = s.id and pc.system_key = 'fit')) as fit,
           sum(coalesce((s.factors->>'SS_TAXABLE')::numeric, 0)) as ss_wages,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = s.id and l.kind = 'deduction' and pc.system_key = 'ss')) as ss_tax,
           sum(s.pensionable_earnings) as medicare_wages,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id
                where l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key in ('medicare', 'medicare_addl'))) as medicare_tax
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join employee_payroll_profiles prof
        on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id and prof.country = 'US'
      join parties p on p.id = s.employee_party_id and p.org_id = ${orgId}
     where s.org_id = ${orgId} and s.tax_year = ${taxYear}
     group by s.employee_party_id, p.display_name
     order by p.display_name
  `)) as unknown as { rows: Record<string, unknown>[] };
  return rows.rows.map((row) => ({
    employeePartyId: String(row.employee_party_id),
    employeeName: String(row.display_name),
    state: String(row.state ?? ""),
    box1Wages: num(row.wages),
    box2FederalIncomeTax: num(row.fit),
    box3SsWages: num(row.ss_wages),
    box4SsTax: num(row.ss_tax),
    box5MedicareWages: num(row.medicare_wages),
    box6MedicareTax: num(row.medicare_tax),
  }));
}
