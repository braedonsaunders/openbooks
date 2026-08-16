import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, neg } from "./money.ts";
import {
  effectiveFilingAccountSql,
  filingAccountRef,
  filingAccountsById,
  type FilingAccountRef,
} from "./payroll-filing.ts";
import { RATES_2026_JAN } from "./payroll/canada/rates.ts";
import { PayrollError } from "./payroll-run.ts";

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
 *
 * A T4 return is filed per payroll program account and a W-2 set per EIN, so
 * every slip carries its filing account and `t4Returns` assembles one
 * slips+summary return per account. Orgs with no filing accounts configured
 * produce exactly one unassigned return — the previous behaviour.
 */

const num = (value: unknown): string => (value == null ? "0" : String(value));

/**
 * Statutory caps per tax year (extend each January alongside the engines).
 *
 * REFUSES an unknown year rather than returning null. Boxes 24 and 26 are
 * capped at the year's MIE and YAMPE; with no caps the cap became a no-op and
 * the slips went out UNCAPPED and silently — a 2025 restatement, or anything
 * filed once the calendar turned to 2027, would misstate insurable and
 * pensionable earnings on every slip. The country pack's own
 * `ratesForPayDate` throws for an unknown pay date; this local copy of the same
 * constants must fail the same way, not the opposite way.
 */
function caYearCaps(taxYear: number): { mie: string; yampe: string; qpipMie: string } {
  if (taxYear === 2026) {
    return {
      mie: RATES_2026_JAN.ei.mie,
      yampe: RATES_2026_JAN.cpp.yampe,
      qpipMie: RATES_2026_JAN.qpip.mie,
    };
  }
  throw new PayrollError(
    `no CRA maximums for tax year ${taxYear} — T4 boxes 24 and 26 cannot be capped. `
    + "Add the year to engine/src/payroll/canada/rates.ts",
  );
}

/**
 * Box 24 and box 26 are capped at the year's MIE and YAMPE PER EMPLOYEE, not
 * per slip — and an employee who moved province mid-year now gets one slip per
 * province, because the CRA requires a separate T4 for each province of
 * employment.
 *
 * Capping each of those slips independently would report up to N × the annual
 * maximum for one person. So the room is consumed across the employee's slips
 * in chronological order: the first slip fills first, and a later one gets only
 * what is left. Pure, and exact — `add`/`cmp`/`neg` from money.ts, no floats.
 */
export function capAnnualEarnings(
  rows: readonly { employeePartyId: string; insurable: string; pensionable: string }[],
  caps: { mie: string; yampe: string },
): { box24EiInsurable: string; box26CppPensionable: string }[] {
  const usedInsurable = new Map<string, string>();
  const usedPensionable = new Map<string, string>();
  const consume = (used: Map<string, string>, key: string, value: string, cap: string): string => {
    const already = used.get(key);
    if (already === undefined) {
      // First slip of the employee's year — byte-for-byte the previous
      // per-employee cap, so a single-province employee's boxes do not move.
      const taken = cmp(value, cap) > 0 ? cap : value;
      used.set(key, taken);
      return taken;
    }
    const room = cmp(cap, already) > 0 ? add(cap, neg(already)) : "0";
    const taken = cmp(value, room) > 0 ? room : value;
    used.set(key, add(already, taken));
    return taken;
  };
  return rows.map((row) => ({
    box24EiInsurable: consume(usedInsurable, row.employeePartyId, row.insurable, caps.mie),
    box26CppPensionable: consume(usedPensionable, row.employeePartyId, row.pensionable, caps.yampe),
  }));
}

export interface T4Slip {
  employeePartyId: string;
  employeeName: string;
  province: string;
  isQuebec: boolean;
  /** Payroll program account the slip is filed under; null = unassigned. */
  filingAccountId: string | null;
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
  /** Box 56 — QPIP insurable earnings, capped at the year's QPIP maximum. */
  box56QpipInsurable: string;
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

/**
 * One T4 slip per employee, per payroll program account, PER PROVINCE OF
 * EMPLOYMENT.
 *
 * `pay_stubs.province` is a per-stub snapshot precisely so a mid-year move is
 * representable, and `max(c.province)` threw that away: a BC→ON mover and an
 * ON→BC mover both collapsed to 'ON', the lexically largest code, which was
 * then stamped into `<EMPT_PROV_CD>` as the CRA's provincial attribution — the
 * field that decides which province's tax the employer is credited with
 * remitting. The CRA's own instruction is a separate slip per province, which
 * is also the only shape in which the data is not a lie.
 */
export async function t4Slips(orgId: string, taxYear: number): Promise<T4Slip[]> {
  const caps = caYearCaps(taxYear);
  const rows = (await db.execute(sql`
    with committed as (
      select s.*, ${effectiveFilingAccountSql("prof")} as filing_account_id
        from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join employee_payroll_profiles prof
        on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
     where s.org_id = ${orgId} and s.tax_year = ${taxYear}
       and coalesce(prof.country, 'CA') = 'CA'
    )
    select c.employee_party_id, p.display_name, c.filing_account_id,
           c.province as province,
           min(c.pay_date) as first_pay_date,
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
     group by c.employee_party_id, p.display_name, c.filing_account_id, c.province
     order by p.display_name, min(c.pay_date), c.province
  `)) as unknown as { rows: Record<string, unknown>[] };

  // The annual maxima are per EMPLOYEE, so they are consumed across that
  // employee's slips in the chronological order the query just produced.
  const capped = capAnnualEarnings(
    rows.rows.map((row) => ({
      employeePartyId: String(row.employee_party_id),
      insurable: num(row.insurable),
      pensionable: num(row.pensionable),
    })),
    caps,
  );

  const capMoney = (value: string, cap: string) => (cmp(value, cap) > 0 ? cap : value);
  return rows.rows.map((row, index) => {
    const province = String(row.province ?? "");
    const isQuebec = province === "QC";
    return {
      employeePartyId: String(row.employee_party_id),
      employeeName: String(row.display_name),
      province,
      isQuebec,
      filingAccountId: (row.filing_account_id as string | null) ?? null,
      box14EmploymentIncome: num(row.taxable_income),
      box16Cpp: num(row.cpp),
      box16aCpp2: num(row.cpp2),
      box18Ei: num(row.ei),
      box22IncomeTax: num(row.income_tax),
      box24EiInsurable: capped[index]!.box24EiInsurable,
      box26CppPensionable: capped[index]!.box26CppPensionable,
      box44UnionDues: num(row.union_dues),
      box55Qpip: num(row.qpip),
      // Box 56 is only reported for Quebec employment, and only up to the
      // QPIP maximum insurable earnings — a different ceiling from EI's MIE.
      box56QpipInsurable: isQuebec ? capMoney(num(row.insurable), caps.qpipMie) : "0",
      stubCount: Number(row.stub_count ?? 0),
    };
  });
}

/**
 * T4 Summary totals. `filingAccountId` restricts the return to one payroll
 * program account (undefined = every account, the org-wide view); pass null
 * for the unassigned bucket.
 */
export async function t4Summary(
  orgId: string,
  taxYear: number,
  filingAccountId?: string | null,
): Promise<T4SummaryTotals> {
  const scoped = filingAccountId !== undefined;
  const account = filingAccountId ?? null;
  const allSlips = await t4Slips(orgId, taxYear);
  const slips = scoped ? allSlips.filter((slip) => slip.filingAccountId === account) : allSlips;
  // Empty fragments keep the org-wide summary's SQL identical to before.
  const employerAccountFilter = scoped
    ? sql`and ${effectiveFilingAccountSql("prof")} is not distinct from ${account}`
    : sql``;
  const billAccountFilter = scoped
    ? sql`and (custom->'payrollRemittance'->>'filingAccountId') is not distinct from ${account}`
    : sql``;
  const employer = (await db.execute(sql`
    select
      sum(case when pc.system_key in ('cpp', 'cpp2') then l.amount else 0 end) as employer_cpp,
      sum(case when pc.system_key = 'ei' then l.amount else 0 end) as employer_ei
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join pay_components pc on pc.id = l.component_id
      left join employee_payroll_profiles prof
        on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
     where l.org_id = ${orgId} and s.tax_year = ${taxYear}
       and l.kind = 'employer_contribution' and coalesce(pc.country, 'CA') = 'CA'
       ${employerAccountFilter}
  `)) as unknown as { rows: { employer_cpp: string | null; employer_ei: string | null }[] };
  const remitted = (await db.execute(sql`
    select coalesce(sum(total), 0) as amount from documents
     where org_id = ${orgId} and kind = 'vendor_bill' and status = 'posted'
       and custom ? 'payrollRemittance'
       and custom->'payrollRemittance'->>'to' like ${`${taxYear}-%`}
       ${billAccountFilter}
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

/** One filed T4 return: the slips of one payroll program account + its summary. */
export interface T4Return {
  filingAccount: FilingAccountRef;
  slips: T4Slip[];
  summary: T4SummaryTotals;
}

/**
 * The year's T4 returns, one per payroll program account the year's employees
 * were filed under (accounts with no slips are not returned, and an org with
 * no filing accounts yields exactly one unassigned return).
 */
export async function t4Returns(orgId: string, taxYear: number): Promise<T4Return[]> {
  const slips = await t4Slips(orgId, taxYear);
  if (slips.length === 0) return [];
  const accounts = await filingAccountsById(orgId);
  const accountIds = [...new Set(slips.map((slip) => slip.filingAccountId))];
  const returns: T4Return[] = [];
  for (const accountId of accountIds) {
    returns.push({
      filingAccount: filingAccountRef(accountId, accounts),
      slips: slips.filter((slip) => slip.filingAccountId === accountId),
      summary: await t4Summary(orgId, taxYear, accountId),
    });
  }
  return returns.sort((a, b) =>
    (a.filingAccount.accountNumber ?? "").localeCompare(b.filingAccount.accountNumber ?? ""));
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

/**
 * Block 15C consecutive-pay-period count by pay-period type, per the Service
 * Canada ROE instructions. Block 15A's insurable hours are reported over the
 * same window.
 */
const ROE_PERIODS_BY_FREQUENCY: Record<string, number> = {
  weekly: 53,
  biweekly: 27,
  semi_monthly: 25,
  monthly: 13,
};

/** ROE Block 6 pay-period type codes. */
const ROE_PERIOD_TYPE: Record<string, string> = {
  weekly: "W",
  biweekly: "B",
  semi_monthly: "S",
  monthly: "M",
};

/**
 * ROE Block 16 reason-for-issue codes (Service Canada). The reason is the
 * employer's declaration about WHY earnings stopped, so it is always an input:
 * nothing in the payroll data can infer it, and guessing it would be a false
 * statutory statement.
 */
export const ROE_REASON_CODES = [
  "A", // shortage of work / end of contract or season
  "B", // strike or lockout
  "D", // illness or injury
  "E", // quit
  "F", // maternity
  "G", // retirement
  "H", // work sharing
  "J", // apprenticeship training
  "K", // other (comment required)
  "M", // dismissal or suspension
  "N", // leave of absence
  "P", // parental
  "Z", // compassionate care / family caregiver
] as const;

export type RoeReasonCode = (typeof ROE_REASON_CODES)[number];

/** One employee's complete ROE, block by block. */
export interface RoeRecord {
  employeePartyId: string;
  employeeName: string;
  /**
   * The employee's payroll country. Required, and carried all the way to the
   * XML builder, so the "only a Canadian employee gets an ROE" rule is enforced
   * where the file is written and not only where the list is queried.
   */
  country: string;
  /** Block 4 — the employer's own payroll reference for the employee. */
  payrollReference: string | null;
  /** Block 5 — the payroll program account the employee is filed under. */
  filingAccount: FilingAccountRef;
  /** Block 6 — W | B | S | M. */
  payPeriodType: string;
  /** Block 8 — present only on the XML build (sealed until then). */
  sinLast3: string | null;
  /** Block 10 / 11 / 12. */
  firstDayWorked: string | null;
  lastDayPaid: string | null;
  finalPayPeriodEnd: string | null;
  /** Block 13. */
  occupation: string | null;
  /** Block 15A / 15B / 15C — newest period first (P1 = final pay period). */
  totalInsurableHours: string;
  totalInsurableEarnings: string;
  periods: RoePeriod[];
  /** Block 17A — vacation pay in the final pay period. */
  vacationPayOnSeparation: string;
  /** Block 17C — other monies (bonus/retiring allowance) in the final period. */
  otherMoniesOnSeparation: string;
}

/**
 * Assemble one employee's ROE from committed stubs and the employee record.
 * Every block that the payroll data cannot supply (reason for issue, comments,
 * expected recall) stays an input on the caller — this builder never invents a
 * statutory declaration.
 *
 * CANADA ONLY, like `t4Slips` above. A Record of Employment is a Service Canada
 * return filed under a CRA payroll program account against a SIN; a US employee
 * of a CA/US org has neither. Without this predicate a terminated US employee
 * appeared in the year-end "ROE due" list and could be filed — a false
 * statutory return that also discloses their SSN. Returns null for a non-CA
 * employee so every caller (including the XML builder) fails closed.
 */
export async function roeRecord(orgId: string, employeePartyId: string): Promise<RoeRecord | null> {
  const header = (await db.execute(sql`
    select p.display_name, er.employee_number, er.job_title,
           er.hired_on::text as hired_on, er.terminated_on::text as terminated_on,
           prof.sin_last3, sched.frequency, coalesce(prof.country, 'CA') as country,
           ${effectiveFilingAccountSql("prof")} as filing_account_id
      from parties p
      left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
      left join employee_payroll_profiles prof
        on prof.org_id = p.org_id and prof.employee_party_id = p.id
      left join pay_schedules sched on sched.id = prof.pay_schedule_id
     where p.org_id = ${orgId} and p.id = ${employeePartyId}
       and coalesce(prof.country, 'CA') = 'CA'
  `)) as unknown as {
    rows: {
      display_name: string; employee_number: string | null; job_title: string | null;
      hired_on: string | null; terminated_on: string | null; sin_last3: string | null;
      frequency: string | null; country: string; filing_account_id: string | null;
    }[];
  };
  const row = header.rows[0];
  if (!row) return null;

  const frequency = row.frequency ?? "biweekly";
  const worksheet = await roeWorksheet(
    orgId, employeePartyId, ROE_PERIODS_BY_FREQUENCY[frequency] ?? 27,
  );
  const finalPeriod = worksheet.periods[0] ?? null;

  // Block 17: monies paid because employment ended, taken from the final
  // committed stub's own lines (vacation payout vs. other non-periodic pay).
  const separation = (await db.execute(sql`
    select
      coalesce(sum(case when pc.system_key = 'vacation_payout' then l.amount else 0 end), 0) as vacation,
      coalesce(sum(case when pc.system_key = 'bonus' then l.amount else 0 end), 0) as other
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      left join pay_components pc on pc.id = l.component_id
     where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
       and l.kind = 'earning'
       and (${finalPeriod?.payDate ?? null}::date is null or s.pay_date = ${finalPeriod?.payDate ?? null})
  `)) as unknown as { rows: { vacation: string; other: string }[] };

  const accounts = await filingAccountsById(orgId);
  return {
    employeePartyId,
    employeeName: row.display_name,
    country: row.country ?? "CA",
    payrollReference: row.employee_number,
    filingAccount: filingAccountRef(row.filing_account_id, accounts),
    payPeriodType: ROE_PERIOD_TYPE[frequency] ?? "B",
    sinLast3: row.sin_last3,
    firstDayWorked: row.hired_on,
    // The last day for which paid: the employee's termination date when the
    // record carries one, else the final committed period end.
    lastDayPaid: row.terminated_on ?? finalPeriod?.periodEnd ?? null,
    finalPayPeriodEnd: finalPeriod?.periodEnd ?? null,
    occupation: row.job_title,
    totalInsurableHours: worksheet.totalInsurableHours,
    totalInsurableEarnings: worksheet.totalInsurableEarnings,
    periods: worksheet.periods,
    vacationPayOnSeparation: num(separation.rows[0]?.vacation),
    otherMoniesOnSeparation: num(separation.rows[0]?.other),
  };
}

/**
 * Employees an ROE is due for in the tax year: anyone with a termination date
 * in the year, plus anyone paid by a termination run. Drives the year-end
 * page's ROE list — issuing the ROE itself is still an explicit act.
 *
 * Canadian employees only — the same predicate `t4Slips` and `roeRecord` use.
 * A US employee has no Record of Employment and must never be offered as one.
 */
export async function roeCandidates(orgId: string, taxYear: number): Promise<{
  employeePartyId: string;
  employeeName: string;
  terminatedOn: string | null;
  lastPayDate: string | null;
}[]> {
  const rows = (await db.execute(sql`
    select p.id, p.display_name, er.terminated_on::text as terminated_on,
           max(s.pay_date)::text as last_pay_date
      from parties p
      join pay_stubs s on s.employee_party_id = p.id and s.org_id = p.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join employee_payroll_profiles prof
        on prof.org_id = p.org_id and prof.employee_party_id = p.id
      left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
     where p.org_id = ${orgId} and s.tax_year = ${taxYear}
       and coalesce(prof.country, 'CA') = 'CA'
       and (extract(year from er.terminated_on)::int = ${taxYear} or r.run_type = 'termination')
     group by p.id, p.display_name, er.terminated_on
     order by p.display_name
  `)) as unknown as {
    rows: { id: string; display_name: string; terminated_on: string | null; last_pay_date: string | null }[];
  };
  return rows.rows.map((row) => ({
    employeePartyId: row.id,
    employeeName: row.display_name,
    terminatedOn: row.terminated_on,
    lastPayDate: row.last_pay_date,
  }));
}

export interface Form941Quarter {
  quarter: 1 | 2 | 3 | 4;
  /** EIN the quarter's return is filed under; null = unassigned. */
  filingAccountId: string | null;
  wages: string;
  federalIncomeTax: string;
  ssWages: string;
  ssTax: string; // employee + employer
  medicareWages: string;
  medicareTax: string; // employee + employer, incl. Additional Medicare
}

/**
 * Form 941 is filed BY EIN, quarterly — one return per (EIN, quarter).
 *
 * This grouped by quarter alone and never joined the filing account, so an
 * employer holding two EINs got one merged worksheet: wages and FICA from both
 * entities added together, reported under whichever EIN the operator happened
 * to file it as, understating one return and overstating the other. `t4Returns`
 * and `w2Slips` both scope per account; this is the same scoping, and
 * `form941Returns` below is the same per-account assembly `t4Returns` does.
 */
export async function form941Worksheet(orgId: string, taxYear: number): Promise<Form941Quarter[]> {
  const rows = (await db.execute(sql`
    select extract(quarter from s.pay_date)::int as quarter,
           ${effectiveFilingAccountSql("prof")} as filing_account_id,
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
     group by 1, 2 order by 2 nulls first, 1
  `)) as unknown as { rows: Record<string, unknown>[] };
  return rows.rows.map((row) => ({
    quarter: Number(row.quarter) as 1 | 2 | 3 | 4,
    filingAccountId: (row.filing_account_id as string | null) ?? null,
    wages: num(row.wages),
    federalIncomeTax: num(row.fit),
    ssWages: num(row.ss_wages),
    ssTax: num(row.ss_tax),
    medicareWages: num(row.medicare_wages),
    medicareTax: num(row.medicare_tax),
  }));
}

/** One filed Form 941 set: the quarters of a single EIN. */
export interface Form941Return {
  filingAccount: FilingAccountRef;
  quarters: Form941Quarter[];
}

/**
 * The year's 941 returns, one per EIN the year's US employees were filed
 * under. The same assembly `t4Returns` performs for CRA program accounts, for
 * the same reason: the return is the unit that gets transmitted, so it is the
 * unit the builder produces.
 */
export async function form941Returns(orgId: string, taxYear: number): Promise<Form941Return[]> {
  const quarters = await form941Worksheet(orgId, taxYear);
  if (quarters.length === 0) return [];
  const accounts = await filingAccountsById(orgId);
  const accountIds = [...new Set(quarters.map((q) => q.filingAccountId))];
  return accountIds
    .map((accountId) => ({
      filingAccount: filingAccountRef(accountId, accounts),
      quarters: quarters.filter((q) => q.filingAccountId === accountId),
    }))
    .sort((a, b) =>
      (a.filingAccount.accountNumber ?? "").localeCompare(b.filingAccount.accountNumber ?? ""));
}

export interface W2Slip {
  employeePartyId: string;
  employeeName: string;
  /**
   * State(s) of employment. A W-2 carries ONE federal wage set and a state
   * line per state, so unlike the T4 the federal boxes must NOT be split — but
   * `max(s.province)` reported a single lexically-largest state, which for a
   * mid-year mover names the wrong state's revenue department. Both are
   * reported: `states` is the fact, `state` renders it.
   */
  states: string[];
  /** Display form of `states`; the sole state, or all of them joined. */
  state: string;
  /** EIN account the W-2 is filed under; null = unassigned. */
  filingAccountId: string | null;
  box1Wages: string;
  box2FederalIncomeTax: string;
  box3SsWages: string;
  box4SsTax: string;
  box5MedicareWages: string;
  box6MedicareTax: string;
}

export async function w2Slips(orgId: string, taxYear: number): Promise<W2Slip[]> {
  const rows = (await db.execute(sql`
    select s.employee_party_id, p.display_name,
           array_agg(distinct s.province order by s.province) as states,
           ${effectiveFilingAccountSql("prof")} as filing_account_id,
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
     group by s.employee_party_id, p.display_name, ${effectiveFilingAccountSql("prof")}
     order by p.display_name
  `)) as unknown as { rows: Record<string, unknown>[] };
  return rows.rows.map((row) => {
    const states = ((row.states as string[] | null) ?? []).filter(Boolean);
    return {
    employeePartyId: String(row.employee_party_id),
    employeeName: String(row.display_name),
    states,
    state: states.join(" / "),
    filingAccountId: (row.filing_account_id as string | null) ?? null,
    box1Wages: num(row.wages),
    box2FederalIncomeTax: num(row.fit),
    box3SsWages: num(row.ss_wages),
    box4SsTax: num(row.ss_tax),
    box5MedicareWages: num(row.medicare_wages),
    box6MedicareTax: num(row.medicare_tax),
    };
  });
}
