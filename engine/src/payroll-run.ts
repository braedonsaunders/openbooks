import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, mulDecimal, mulPercent, neg, roundMoney, sum } from "./money.ts";
import { calculateT4127, type T4127Input } from "./payroll/canada/t4127.ts";
import type { Province } from "./payroll/canada/rates.ts";
import { calculatePub15T } from "./payroll/us/pub15t.ts";
import { NO_WITHHOLDING_STATES, US_STATES } from "./payroll/us/rates.ts";
import { laborCostingSettings } from "./labor-costing.ts";

/**
 * Pay run pipeline: create → calculate → commit → (standard document post).
 *
 * A pay run is documents kind 'pay_run'. Stubs and their lines are the
 * payroll subledger; commit materializes the balanced GL projection into
 * document_lines (signed, like a journal), so posting, voiding, numbering,
 * and period control ride the standard machinery in engine/src/posting.ts.
 *
 * Wages resolve from labor_cost_rates (employee scope — the one-table
 * doctrine); statutory amounts come from the versioned T4127 engine. YTD
 * state = payroll_opening_balances + previously committed stubs, so
 * recalculating an uncommitted run is always safe.
 */

export interface PayrollSettings {
  /** DR for wages when a component has no expense account of its own. */
  wageExpenseAccountId: string | null;
  /** DR for employer statutory burden (CPP/EI employer share, vacation). */
  burdenExpenseAccountId: string | null;
  /** CR net pay owed to employees (relieved by the payment). */
  netPayAccountId: string | null;
  /** CR statutory withholdings pending remittance to the CRA. */
  cppPayableAccountId: string | null;
  eiPayableAccountId: string | null;
  taxPayableAccountId: string | null;
  vacationPayableAccountId: string | null;
  /**
   * Where time-driven wages debit. 'labor_clearing' washes the standard cost
   * already posted at time approval (labor costing mode 'post') so the
   * existing clearing true-up converges; 'expense' debits wage expense with
   * project splits straight from the time entries.
   */
  wagesTo: "expense" | "labor_clearing";
  /** Vendor party used when raising CRA remittance bills. */
  craRemittancePartyId: string | null;
}

/**
 * US pack org configuration (orgs.settings.payroll.us): the effective FUTA
 * rate (credit-reduction states raise it past the default 0.6%) and the
 * employer's state unemployment accounts — SUI rates are experience-rated
 * per employer, so they are org-entered settings, never engine constants.
 */
export interface UsPayrollConfig {
  futaRate: string | null;
  sui: Record<string, { rate: string; wageBase: string }>;
}

export async function usPayrollConfig(orgId: string): Promise<UsPayrollConfig> {
  const r = (await db.execute(
    sql`select settings#>'{payroll,us}' as u from orgs where id = ${orgId}`,
  )) as unknown as { rows: { u: Record<string, unknown> | null }[] };
  const u = r.rows[0]?.u ?? {};
  const sui: UsPayrollConfig["sui"] = {};
  const rawSui = (u.sui ?? {}) as Record<string, { rate?: unknown; wageBase?: unknown }>;
  for (const [state, entry] of Object.entries(rawSui)) {
    if (entry && entry.rate != null && entry.wageBase != null) {
      sui[state] = { rate: String(entry.rate), wageBase: String(entry.wageBase) };
    }
  }
  return { futaRate: u.futaRate != null ? String(u.futaRate) : null, sui };
}

export async function payrollSettings(orgId: string): Promise<PayrollSettings> {
  const r = (await db.execute(
    sql`select settings->'payroll' as p, settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  )) as unknown as { rows: { p: Record<string, unknown> | null; c: Record<string, unknown> | null }[] };
  const p = (r.rows[0]?.p ?? {}) as Record<string, string | null>;
  return {
    wageExpenseAccountId: p.wageExpenseAccountId ?? null,
    burdenExpenseAccountId: p.burdenExpenseAccountId ?? null,
    netPayAccountId: p.netPayAccountId ?? null,
    cppPayableAccountId: p.cppPayableAccountId ?? null,
    eiPayableAccountId: p.eiPayableAccountId ?? null,
    taxPayableAccountId: p.taxPayableAccountId ?? null,
    vacationPayableAccountId: p.vacationPayableAccountId ?? null,
    wagesTo: p.wagesTo === "labor_clearing" ? "labor_clearing" : "expense",
    craRemittancePartyId: p.craRemittancePartyId ?? null,
  };
}

export class PayrollError extends Error {}

interface SeedComponent {
  code: string; name: string; kind: string; systemKey: string | null;
  basis?: string; taxable?: boolean; pensionable?: boolean; insurable?: boolean;
  vacationable?: boolean; nonPeriodic?: boolean; sequence: number;
  /** Country pack the row belongs to; omitted = shared across packs. */
  country?: "CA" | "US";
}

/** Jurisdiction-free earning baseline shared by every country pack. */
const BASELINE_COMPONENTS: SeedComponent[] = [
  { code: "BASE", name: "Base pay", kind: "earning", systemKey: "base_pay", basis: "per_hour", sequence: 10 },
  { code: "OT", name: "Overtime", kind: "earning", systemKey: "overtime", basis: "per_hour", sequence: 20 },
  { code: "BONUS", name: "Bonus", kind: "earning", systemKey: "bonus", nonPeriodic: true, vacationable: false, sequence: 30 },
  { code: "VACPAY", name: "Vacation pay", kind: "earning", systemKey: "vacation_payout", vacationable: false, sequence: 40 },
];

const CA_COMPONENTS: SeedComponent[] = [
  { code: "TAX", name: "Income tax", kind: "deduction", systemKey: "income_tax", sequence: 110, country: "CA" },
  { code: "CPP", name: "CPP", kind: "deduction", systemKey: "cpp", sequence: 120, country: "CA" },
  { code: "CPP2", name: "CPP (second additional)", kind: "deduction", systemKey: "cpp2", sequence: 130, country: "CA" },
  { code: "EI", name: "EI", kind: "deduction", systemKey: "ei", sequence: 140, country: "CA" },
  { code: "QPIP", name: "QPIP", kind: "deduction", systemKey: "qpip", sequence: 150, country: "CA" },
  { code: "CPP-ER", name: "CPP (employer)", kind: "employer_contribution", systemKey: "cpp", sequence: 210, country: "CA" },
  { code: "EI-ER", name: "EI (employer)", kind: "employer_contribution", systemKey: "ei", sequence: 220, country: "CA" },
  { code: "QPIP-ER", name: "QPIP (employer)", kind: "employer_contribution", systemKey: "qpip", sequence: 230, country: "CA" },
  { code: "VAC", name: "Vacation accrual", kind: "employer_contribution", systemKey: "vacation_accrual", sequence: 240, country: "CA" },
];

// US statutory set. `pensionable` generalizes to FICA-taxable and `insurable`
// to FUTA/SUI-taxable for US employees (see calculateStub).
const US_COMPONENTS: SeedComponent[] = [
  { code: "FIT", name: "Federal income tax", kind: "deduction", systemKey: "fit", sequence: 110, country: "US" },
  { code: "SS", name: "Social Security", kind: "deduction", systemKey: "ss", sequence: 120, country: "US" },
  { code: "MED", name: "Medicare", kind: "deduction", systemKey: "medicare", sequence: 130, country: "US" },
  { code: "MED2", name: "Additional Medicare", kind: "deduction", systemKey: "medicare_addl", sequence: 135, country: "US" },
  { code: "SS-ER", name: "Social Security (employer)", kind: "employer_contribution", systemKey: "ss", sequence: 210, country: "US" },
  { code: "MED-ER", name: "Medicare (employer)", kind: "employer_contribution", systemKey: "medicare", sequence: 220, country: "US" },
  { code: "FUTA", name: "Federal unemployment (FUTA)", kind: "employer_contribution", systemKey: "futa", sequence: 230, country: "US" },
  { code: "SUTA", name: "State unemployment (SUI)", kind: "employer_contribution", systemKey: "suta", sequence: 250, country: "US" },
];

/** Statutory + baseline components for a country pack; idempotent. */
export async function seedPayrollComponents(
  orgId: string, actorId: string | null, country: "CA" | "US" = "CA",
): Promise<void> {
  const rows = [...BASELINE_COMPONENTS, ...(country === "US" ? US_COMPONENTS : CA_COMPONENTS)];
  for (const c of rows) {
    await db.execute(sql`
      insert into pay_components (org_id, code, name, kind, system_key, country, basis, taxable,
                                  pensionable, insurable, vacationable, non_periodic, sequence,
                                  created_by, updated_by)
      values (${orgId}, ${c.code}, ${c.name}, ${c.kind}, ${c.systemKey}, ${c.country ?? null},
              ${c.basis ?? "fixed_amount"},
              ${c.taxable ?? true}, ${c.pensionable ?? true}, ${c.insurable ?? true},
              ${c.vacationable ?? true}, ${c.nonPeriodic ?? false}, ${c.sequence}, ${actorId}, ${actorId})
      on conflict (org_id, code) do nothing
    `);
  }
}

interface ScheduleRow {
  id: string; frequency: string; periods_per_year: number;
  anchor_period_end: string; pay_date_offset_days: number;
}

const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (s: string) => new Date(`${s}T00:00:00Z`);

/** Period boundaries for a schedule: [start, end] containing/after `from`. */
export function nextPeriodAfter(
  schedule: Pick<ScheduleRow, "frequency" | "anchor_period_end">,
  lastPeriodEnd: string | null,
): { periodStart: string; periodEnd: string } {
  const anchor = at(schedule.anchor_period_end);
  if (schedule.frequency === "weekly" || schedule.frequency === "biweekly") {
    const span = schedule.frequency === "weekly" ? 7 : 14;
    let end = anchor;
    if (lastPeriodEnd) {
      const last = at(lastPeriodEnd);
      const steps = Math.max(1, Math.ceil((last.getTime() - anchor.getTime()) / (span * DAY) + 1));
      end = new Date(anchor.getTime() + steps * span * DAY);
      while (end.getTime() <= last.getTime()) end = new Date(end.getTime() + span * DAY);
    }
    return { periodStart: iso(new Date(end.getTime() - (span - 1) * DAY)), periodEnd: iso(end) };
  }
  if (schedule.frequency === "semi_monthly") {
    // Periods end on the 15th and the last day of each month.
    const boundaries = (y: number, m: number) => [
      new Date(Date.UTC(y, m, 15)), new Date(Date.UTC(y, m + 1, 0)),
    ];
    let cursor = lastPeriodEnd ? at(lastPeriodEnd) : new Date(anchor.getTime() - DAY);
    for (let m = 0; m < 26; m++) {
      const base = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + Math.floor(m / 2), 1));
      const end = boundaries(base.getUTCFullYear(), base.getUTCMonth())[m % 2]!;
      if (end.getTime() > cursor.getTime()) {
        const start = end.getUTCDate() === 15
          ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
          : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 16));
        return { periodStart: iso(start), periodEnd: iso(end) };
      }
    }
    throw new PayrollError("could not derive the next semi-monthly period");
  }
  // monthly: end on the anchor's day-of-month, clamped to month end.
  const anchorDay = anchor.getUTCDate();
  let cursor = lastPeriodEnd ? at(lastPeriodEnd) : new Date(anchor.getTime() - DAY);
  for (let m = 0; m < 14; m++) {
    const y = cursor.getUTCFullYear();
    const mo = cursor.getUTCMonth() + m;
    const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const end = new Date(Date.UTC(y, mo, Math.min(anchorDay, lastDay)));
    if (end.getTime() > cursor.getTime()) {
      const prevLast = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const start = new Date(Date.UTC(y, mo - 1, Math.min(anchorDay, prevLast) + 1));
      return { periodStart: iso(start), periodEnd: iso(end) };
    }
  }
  throw new PayrollError("could not derive the next monthly period");
}

export async function createPayRun(input: {
  orgId: string; actorId: string; payScheduleId: string;
  periodStart?: string; periodEnd?: string; payDate?: string;
}): Promise<{ documentId: string; documentNumber: string }> {
  const { orgId, actorId } = input;
  return await db.transaction(async (tx) => {
    const s = (await tx.execute(sql`
      select id, frequency, periods_per_year, anchor_period_end, pay_date_offset_days, subsidiary_id
        from pay_schedules where org_id = ${orgId} and id = ${input.payScheduleId} and is_active
    `)) as unknown as { rows: (ScheduleRow & { subsidiary_id: string | null })[] };
    const schedule = s.rows[0];
    if (!schedule) throw new PayrollError("pay schedule not found");

    let periodStart = input.periodStart;
    let periodEnd = input.periodEnd;
    if (!periodStart || !periodEnd) {
      const last = (await tx.execute(sql`
        select max(period_end) as last_end from pay_runs
         where org_id = ${orgId} and pay_schedule_id = ${schedule.id}
      `)) as unknown as { rows: { last_end: string | null }[] };
      const next = nextPeriodAfter(schedule, last.rows[0]?.last_end ?? null);
      periodStart = next.periodStart;
      periodEnd = next.periodEnd;
    }
    const payDate = input.payDate ??
      iso(new Date(at(periodEnd).getTime() + schedule.pay_date_offset_days * DAY));
    const taxYear = Number(payDate.slice(0, 4));

    // Scoped schedules pin the run to their legal entity (and its currency);
    // org-wide schedules keep the historical root-subsidiary behaviour.
    const sub = (await tx.execute(schedule.subsidiary_id
      ? sql`
        select s.id, s.base_currency as currency_code from subsidiaries s
         where s.org_id = ${orgId} and s.id = ${schedule.subsidiary_id} and s.is_active`
      : sql`
        select s.id, s.base_currency as currency_code from subsidiaries s
         where s.org_id = ${orgId} and s.parent_id is null and s.is_active
         order by s.created_at limit 1
    `)) as unknown as { rows: { id: string; currency_code: string | null }[] };
    const subsidiary = sub.rows[0];
    if (!subsidiary) {
      throw new PayrollError(schedule.subsidiary_id
        ? "the pay schedule's subsidiary is missing or inactive"
        : "no active root subsidiary");
    }

    const seq = (await tx.execute(sql`
      insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
      values (${orgId}, 'pay_run', null, 'PAY-')
      on conflict on constraint sequences_org_kind_sub
      do update set next_number = number_sequences.next_number + 1
      returning prefix, next_number, padding
    `)) as unknown as { rows: { prefix: string; next_number: number; padding: number }[] };
    const number = `${seq.rows[0]!.prefix}${String(seq.rows[0]!.next_number).padStart(seq.rows[0]!.padding, "0")}`;

    const doc = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, subsidiary_id, document_date,
                             currency, status, memo, created_by, updated_by)
      values (${orgId}, 'pay_run', ${number}, ${subsidiary.id}, ${payDate},
              ${subsidiary.currency_code}, 'draft',
              ${`Pay run ${periodStart} – ${periodEnd}`}, ${actorId}, ${actorId})
      returning id
    `)) as unknown as { rows: { id: string }[] };
    const documentId = doc.rows[0]!.id;
    await tx.execute(sql`
      insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                            pay_date, tax_year, created_by, updated_by)
      values (${documentId}, ${orgId}, ${schedule.id}, ${periodStart}, ${periodEnd},
              ${payDate}, ${taxYear}, ${actorId}, ${actorId})
    `);
    return { documentId, documentNumber: number };
  });
}

interface StubComputation {
  employeePartyId: string;
  province: string;
  gross: string;
  net: string;
  employerCost: string;
  errors: string[];
}

interface YtdRow {
  pensionable: string; insurable: string; cpp: string; cpp2: string; ei: string;
  qpip: string; non_periodic: string; f5b: string;
}

async function employeeYtd(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string,
  taxYear: number, excludeDocumentId: string,
): Promise<YtdRow> {
  const r = (await tx.execute(sql`
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
      coalesce(sum((s.factors->>'F5B')::numeric), 0) as f5b
    from pay_stubs s
    join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
    where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
      and s.tax_year = ${taxYear} and s.pay_run_document_id <> ${excludeDocumentId}
  `)) as unknown as { rows: YtdRow[] };
  return r.rows[0]!;
}

interface UsYtdRow {
  fica: string;
  futa: string;
  supplemental: string;
}

/**
 * US YTD state for the wage-base caps: the caps compare cumulative WAGES
 * (not contributions) against the base, so the generic pensionable/insurable
 * stub columns — FICA and FUTA/SUI wages for US employees — plus the same
 * opening-balance columns are the whole story.
 */
async function usEmployeeYtd(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string,
  taxYear: number, excludeDocumentId: string,
): Promise<UsYtdRow> {
  const r = (await tx.execute(sql`
    select
      coalesce((select pensionable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.pensionable_earnings), 0) as fica,
      coalesce((select insurable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.insurable_earnings), 0) as futa,
      coalesce((select non_periodic_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'B')::numeric), 0) as supplemental
    from pay_stubs s
    join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
    where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
      and s.tax_year = ${taxYear} and s.pay_run_document_id <> ${excludeDocumentId}
  `)) as unknown as { rows: UsYtdRow[] };
  return r.rows[0]!;
}

/** Employee-scope pay rate straight from labor_cost_rates (one-table doctrine). */
async function resolvePayRate(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string, onDate: string,
): Promise<{ basis: "hour" | "year"; rate: string; annualHours: string; currency: string } | null> {
  const r = (await tx.execute(sql`
    select basis, rate, annual_hours, currency from labor_cost_rates
     where org_id = ${orgId} and employee_party_id = ${employeePartyId}
       and is_active and effective_from <= ${onDate}
       and (effective_to is null or effective_to >= ${onDate})
     order by effective_from desc limit 1
  `)) as unknown as {
    rows: { basis: "hour" | "year"; rate: string; annual_hours: string; currency: string }[];
  };
  const row = r.rows[0];
  if (!row) return null;
  return { basis: row.basis, rate: row.rate, annualHours: row.annual_hours, currency: row.currency };
}

export async function calculatePayRun(input: {
  orgId: string; documentId: string; actorId: string;
}): Promise<{ employees: number; errors: { employee: string; message: string }[] }> {
  const { orgId, documentId, actorId } = input;
  return await db.transaction(async (tx) => {
    const runRows = (await tx.execute(sql`
      select r.*, d.status as doc_status, d.currency as doc_currency
        from pay_runs r join documents d on d.id = r.document_id
       where r.org_id = ${orgId} and r.document_id = ${documentId} for update
    `)) as unknown as { rows: Record<string, string>[] };
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (run.run_status === "committed") throw new PayrollError("pay run is already committed");
    if (run.doc_status !== "draft") throw new PayrollError("pay run document is not editable");

    const components = (await tx.execute(sql`
      select * from pay_components where org_id = ${orgId} and is_active order by sequence
    `)) as unknown as { rows: Record<string, unknown>[] };
    const byKey = new Map<string, Record<string, unknown>>();
    for (const c of components.rows) {
      if (c.system_key) byKey.set(`${c.system_key}:${c.kind}`, c);
    }
    const need = (systemKey: string, kind: string) => {
      const c = byKey.get(`${systemKey}:${kind}`);
      if (!c) throw new PayrollError(`missing system pay component ${systemKey}/${kind} — seed payroll components first`);
      return c;
    };

    // A subsidiary-scoped schedule pays only that entity's employees; an
    // org-wide schedule keeps everyone (the historical behaviour).
    const scheduleScope = (await tx.execute(sql`
      select subsidiary_id from pay_schedules where org_id = ${orgId} and id = ${run.pay_schedule_id}
    `)) as unknown as { rows: { subsidiary_id: string | null }[] };
    const scopedSubsidiaryId = scheduleScope.rows[0]?.subsidiary_id ?? null;
    const employees = (await tx.execute(sql`
      select p.id as party_id, p.display_name, prof.*
        from employee_payroll_profiles prof
        join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
        left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
       where prof.org_id = ${orgId} and prof.pay_schedule_id = ${run.pay_schedule_id}
         and prof.is_active
         and (er.terminated_on is null or er.terminated_on >= ${run.period_start})
         and (${scopedSubsidiaryId}::uuid is null or p.subsidiary_id = ${scopedSubsidiaryId}::uuid)
       order by p.display_name
    `)) as unknown as { rows: Record<string, string | null>[] };

    await tx.execute(sql`delete from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}`);

    // Run-level input adjustments: exclusions drop the employee entirely;
    // 'line' rows are merged into the stub's inputs inside calculateStub.
    const excludedRows = (await tx.execute(sql`
      select employee_party_id from pay_run_adjustments
       where org_id = ${orgId} and pay_run_document_id = ${documentId}
         and adjustment_type = 'exclude'
    `)) as unknown as { rows: { employee_party_id: string }[] };
    const excluded = new Set(excludedRows.rows.map((r) => r.employee_party_id));

    const usConfig = await usPayrollConfig(orgId);
    const errors: { employee: string; message: string }[] = [];
    let grossTotal = "0"; let netTotal = "0"; let employerTotal = "0"; let count = 0;
    const P = Number(run.periods_per_year ?? 0) || undefined;

    for (const emp of employees.rows) {
      if (excluded.has(emp.party_id!)) continue;
      const name = emp.display_name ?? emp.party_id!;
      try {
        const result = await calculateStub(tx, {
          orgId, actorId, documentId, run, emp,
          periodsPerYear: P, need, components: components.rows, usConfig,
        });
        grossTotal = add(grossTotal, result.gross);
        netTotal = add(netTotal, result.net);
        employerTotal = add(employerTotal, result.employerCost);
        count += 1;
      } catch (error) {
        errors.push({ employee: name, message: error instanceof Error ? error.message : String(error) });
      }
    }

    await tx.execute(sql`
      update pay_runs set run_status = 'calculated', calculated_at = now(),
             gross_total = ${grossTotal}, net_total = ${netTotal},
             employer_cost_total = ${employerTotal}, employee_count = ${count},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
    `);
    return { employees: count, errors };
  });
}

async function calculateStub(
  tx: Pick<typeof db, "execute">,
  ctx: {
    orgId: string; actorId: string; documentId: string;
    run: Record<string, string>; emp: Record<string, string | null>;
    periodsPerYear: number | undefined;
    need: (systemKey: string, kind: string) => Record<string, unknown>;
    components: Record<string, unknown>[];
    usConfig: UsPayrollConfig;
  },
): Promise<StubComputation> {
  const { orgId, actorId, documentId, run, emp } = ctx;
  const employeePartyId = emp.party_id!;
  const schedule = (await tx.execute(sql`
    select periods_per_year from pay_schedules where id = ${run.pay_schedule_id}
  `)) as unknown as { rows: { periods_per_year: number }[] };
  const P = schedule.rows[0]!.periods_per_year;
  const taxYear = Number(run.tax_year);

  interface Line {
    componentId: string | null; kind: "earning" | "deduction" | "employer_contribution";
    description: string; hours?: string; rate?: string; amount: string;
    projectId?: string | null; departmentId?: string | null; timeTypeId?: string | null;
    sequence: number;
    taxable?: boolean; pensionable?: boolean; insurable?: boolean;
    vacationable?: boolean; nonPeriodic?: boolean; taxTreatment?: string;
    accrualOnly?: boolean;
  }
  const lines: Line[] = [];

  const payRate = await resolvePayRate(tx, orgId, employeePartyId, run.period_end);
  const baseComponent = ctx.need("base_pay", "earning");

  if (emp.pay_basis === "salary") {
    if (!payRate || payRate.basis !== "year") {
      throw new PayrollError("salaried employee has no annual labor cost rate (employee scope)");
    }
    const periodSalary = roundMoney(mulDecimal(payRate.rate, (1 / P).toFixed(10)), 2);
    lines.push({
      componentId: baseComponent.id as string, kind: "earning", description: "Salary",
      amount: periodSalary, sequence: 10,
    });
  } else {
    if (!payRate) throw new PayrollError("no labor cost rate covers this employee for the period");
    const hourlyWage = payRate.basis === "hour"
      ? payRate.rate
      : roundMoney(mulDecimal(payRate.rate, (1 / Number(payRate.annualHours)).toFixed(10)), 4);
    const time = (await tx.execute(sql`
      select te.id, te.hours, te.project_id, te.department_id, te.time_type_id,
             coalesce(tt.classification, 'regular') as classification,
             coalesce(tt.cost_multiplier, 1) as multiplier, coalesce(tt.name, 'Regular') as type_name
        from time_entries te
        left join time_types tt on tt.id = te.time_type_id
       where te.org_id = ${orgId} and te.employee_party_id = ${employeePartyId}
         and te.status = 'approved'
         and te.worked_on between ${run.period_start} and ${run.period_end}
         and (te.payroll_batch_ref is null or te.payroll_batch_ref = ${documentId})
    `)) as unknown as {
      rows: {
        id: string; hours: string; project_id: string | null; department_id: string | null;
        time_type_id: string | null; classification: string; multiplier: string; type_name: string;
      }[];
    };
    const otComponent = ctx.need("overtime", "earning");
    const groups = new Map<string, { hours: string; rate: string; row: (typeof time.rows)[0] }>();
    for (const t of time.rows) {
      const key = [t.time_type_id ?? "", t.project_id ?? "", t.department_id ?? ""].join("|");
      const rate = roundMoney(mulDecimal(hourlyWage, t.multiplier), 4);
      const existing = groups.get(key);
      if (existing) existing.hours = add(existing.hours, t.hours);
      else groups.set(key, { hours: t.hours, rate, row: t });
    }
    let sequence = 10;
    for (const group of groups.values()) {
      const isOt = group.row.classification === "overtime" || group.row.classification === "double_time";
      lines.push({
        componentId: (isOt ? otComponent.id : baseComponent.id) as string,
        kind: "earning",
        description: group.row.type_name,
        hours: group.hours, rate: group.rate,
        amount: roundMoney(mulDecimal(group.rate, group.hours), 2),
        projectId: group.row.project_id, departmentId: group.row.department_id,
        timeTypeId: group.row.time_type_id, sequence: sequence++,
      });
    }
  }

  // Recurring assigned components (allowances, RRSP match, dues, garnishees…).
  // Country-scoped components only apply to that country's employees; rows
  // with no country are shared across packs.
  const country = emp.country === "US" ? "US" : "CA";
  const assigned = (await tx.execute(sql`
    select a.value as override, c.*
      from employee_pay_components a
      join pay_components c on c.id = a.component_id
     where a.org_id = ${orgId} and a.employee_party_id = ${employeePartyId}
       and a.is_active and c.is_active and c.system_key is null
       and (c.country is null or c.country = ${country})
       and a.effective_from <= ${run.period_end}
       and (a.effective_to is null or a.effective_to >= ${run.period_end})
     order by c.sequence
  `)) as unknown as { rows: Record<string, unknown>[] };

  const earningsBase = () =>
    sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly).map((l) => l.amount));
  const totalHours = () =>
    sum(lines.filter((l) => l.hours).map((l) => l.hours!));

  for (const c of assigned.rows) {
    const value = String(c.override ?? c.value ?? "0");
    let amount: string;
    if (c.basis === "per_hour") amount = roundMoney(mulDecimal(value, totalHours()), 2);
    else if (c.basis === "percent_of_gross") amount = mulPercent(earningsBase(), value, 2);
    else amount = roundMoney(value, 2);
    if (cmp(amount, "0") === 0) continue;
    lines.push({
      componentId: c.id as string, kind: c.kind as Line["kind"],
      description: c.name as string, amount, sequence: Number(c.sequence),
      taxable: c.taxable as boolean, pensionable: c.pensionable as boolean,
      insurable: c.insurable as boolean, vacationable: c.vacationable as boolean,
      nonPeriodic: c.non_periodic as boolean, taxTreatment: c.tax_treatment as string,
    });
  }

  // Run-level 'line' adjustments — one-off inputs for THIS employee in THIS
  // run. replaceComponent swaps out the component's derived lines (time,
  // salary, or recurring) before the one-off amount lands; either way the
  // statutory math below sees the adjusted inputs, never edited outputs.
  const adjustments = (await tx.execute(sql`
    select a.amount as adj_amount, a.hours as adj_hours, a.replace_component, a.note, c.*
      from pay_run_adjustments a
      join pay_components c on c.id = a.component_id
     where a.org_id = ${orgId} and a.pay_run_document_id = ${documentId}
       and a.employee_party_id = ${employeePartyId} and a.adjustment_type = 'line'
     order by c.sequence, a.created_at
  `)) as unknown as { rows: Record<string, unknown>[] };
  for (const adj of adjustments.rows) {
    if (adj.replace_component) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.componentId === adj.id) lines.splice(i, 1);
      }
    }
    const amount = roundMoney(String(adj.adj_amount), 2);
    if (cmp(amount, "0") === 0) continue;
    lines.push({
      componentId: adj.id as string, kind: adj.kind as Line["kind"],
      description: (adj.note as string | null) || (adj.name as string),
      hours: adj.adj_hours != null ? String(adj.adj_hours) : undefined,
      amount, sequence: Number(adj.sequence),
      taxable: adj.taxable as boolean, pensionable: adj.pensionable as boolean,
      insurable: adj.insurable as boolean, vacationable: adj.vacationable as boolean,
      nonPeriodic: adj.non_periodic as boolean, taxTreatment: adj.tax_treatment as string,
    });
  }

  // Union fringes and dues (collective agreement)
  if (emp.union_agreement_id) {
    const { fringesForEmployee } = await import("./payroll-union.ts");
    const fringes = await fringesForEmployee(
      tx, orgId, emp.union_agreement_id, emp.union_classification_id ?? null,
    );
    for (const fringe of fringes) {
      if (!fringe.component_id) {
        throw new PayrollError(`union fringe ${fringe.code} has no linked pay component`);
      }
      const kind: Line["kind"] = fringe.paid_by === "employer" ? "employer_contribution" : "deduction";
      const taxTreatment = fringe.paid_by === "employee" ? "union_dues" : undefined;
      if (fringe.calc === "per_hour_worked") {
        // Job-costed per-hour fringes split by project exactly like the hours.
        const hourLines = lines.filter((l) => l.kind === "earning" && l.hours);
        const splits = fringe.job_costed && kind === "employer_contribution"
          ? hourLines
          : [{ hours: totalHours(), projectId: null, departmentId: null } as Line];
        for (const split of splits) {
          if (!split.hours || cmp(split.hours, "0") === 0) continue;
          const amount = roundMoney(mulDecimal(fringe.value, split.hours), 2);
          if (cmp(amount, "0") === 0) continue;
          lines.push({
            componentId: fringe.component_id, kind, description: fringe.name,
            hours: split.hours, rate: fringe.value, amount,
            projectId: split.projectId ?? null, departmentId: split.departmentId ?? null,
            sequence: 300 + fringe.sequence, taxTreatment,
          });
        }
      } else {
        const amount = mulPercent(earningsBase(), fringe.value, 2);
        if (cmp(amount, "0") === 0) continue;
        lines.push({
          componentId: fringe.component_id, kind, description: fringe.name,
          amount, sequence: 300 + fringe.sequence, taxTreatment,
        });
      }
    }
  }

  // Vacation pay
  const vacationPercent = emp.vacation_percent;
  let vacationAccrued = "0";
  if (vacationPercent && cmp(vacationPercent, "0") > 0) {
    const base = sum(lines
      .filter((l) => l.kind === "earning" && (l.vacationable ?? true) && !l.accrualOnly)
      .map((l) => l.amount));
    const vacation = mulPercent(base, vacationPercent, 2);
    if (cmp(vacation, "0") > 0) {
      if (emp.vacation_method === "pay_each_period") {
        const c = ctx.need("vacation_payout", "earning");
        lines.push({
          componentId: c.id as string, kind: "earning", description: "Vacation pay",
          amount: vacation, sequence: 45, vacationable: false,
        });
      } else {
        const c = ctx.need("vacation_accrual", "employer_contribution");
        lines.push({
          componentId: c.id as string, kind: "employer_contribution",
          description: "Vacation accrual", amount: vacation, sequence: 240, accrualOnly: true,
        });
        vacationAccrued = vacation;
      }
    }
  }

  // Statutory inputs from the line set. For US employees the flags
  // generalize: taxable → FIT wages, pensionable → FICA (Social Security /
  // Medicare) wages, insurable → FUTA and SUI wages.
  const earning = (predicate: (l: Line) => boolean) =>
    sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly && predicate(l)).map((l) => l.amount));
  const deduction = (treatment: string) =>
    sum(lines.filter((l) => l.kind === "deduction" && l.taxTreatment === treatment).map((l) => l.amount));

  const gross = earning(() => true);
  const income = earning((l) => (l.taxable ?? true) && !(l.nonPeriodic ?? false));
  const nonPeriodic = earning((l) => (l.taxable ?? true) && (l.nonPeriodic ?? false));
  const pensionable = earning((l) => l.pensionable ?? true);
  const insurable = earning((l) => l.insurable ?? true);

  const pushStatutory = (
    systemKey: string, kind: "deduction" | "employer_contribution",
    description: string, amount: string, sequence: number, accrualOnly = false,
  ) => {
    if (cmp(amount, "0") === 0) return;
    const c = ctx.need(systemKey, kind);
    lines.push({ componentId: c.id as string, kind, description, amount, sequence, accrualOnly });
  };

  const bool = (value: string | null | undefined) =>
    value === "true" || (value as unknown) === true;
  const province = (emp.province ?? (country === "US" ? "" : "ON"));
  let factors: Record<string, string>;

  if (country === "US") {
    if (!(US_STATES as readonly string[]).includes(province)) {
      throw new PayrollError(`unknown US state "${province}" on the payroll profile`);
    }
    if (!NO_WITHHOLDING_STATES.has(province)) {
      throw new PayrollError(
        `state income tax withholding for ${province} is not yet supported — `
        + `the US pack currently covers the nine no-withholding states`,
      );
    }
    const ytd = await usEmployeeYtd(tx, orgId, employeePartyId, taxYear, documentId);
    const filingStatus = (emp.filing_status ?? "single") as "single" | "married_joint" | "head_household";
    const statutory = calculatePub15T({
      payDate: run.pay_date, periodsPerYear: P,
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
      futaEffectiveRate: ctx.usConfig.futaRate ?? undefined,
      sui: ctx.usConfig.sui[province],
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
    factors = {
      ...statutory.factors,
      B: nonPeriodic, I: income, PI: pensionable, IE: insurable,
    };
  } else {

    const ytd = await employeeYtd(tx, orgId, employeePartyId, taxYear, documentId);

    const t4127Input: T4127Input = {
      payDate: run.pay_date, province: province as Province, periodsPerYear: P,
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
      taxExempt: emp.tax_exempt === "true" || emp.tax_exempt === true as unknown as string,
      cppExempt: emp.cpp_exempt === "true" || emp.cpp_exempt === true as unknown as string,
      eiExempt: emp.ei_exempt === "true" || emp.ei_exempt === true as unknown as string,
      ytd: {
        cpp: ytd.cpp, cpp2: ytd.cpp2, ei: ytd.ei, qpip: ytd.qpip,
        pensionable: ytd.pensionable, nonPeriodic: ytd.non_periodic,
        nonPeriodicCppEnhancedDeductions: ytd.f5b,
      },
    };
    const statutory = calculateT4127(t4127Input);

    pushStatutory("income_tax", "deduction", "Income tax", statutory.totalTax, 110);
    pushStatutory("cpp", "deduction", province === "QC" ? "QPP" : "CPP", statutory.cpp, 120);
    pushStatutory("cpp2", "deduction", province === "QC" ? "QPP2" : "CPP2", statutory.cpp2, 130);
    pushStatutory("ei", "deduction", "EI", statutory.ei, 140);
    pushStatutory("qpip", "deduction", "QPIP", statutory.qpip, 150);
    pushStatutory("cpp", "employer_contribution",
      province === "QC" ? "QPP (employer)" : "CPP (employer)", statutory.cppEmployer, 210);
    pushStatutory("ei", "employer_contribution", "EI (employer)", statutory.eiEmployer, 220);
    pushStatutory("qpip", "employer_contribution", "QPIP (employer)", statutory.qpipEmployer, 230);

    factors = {
      ...statutory.factors,
      B: nonPeriodic, I: income, PI: pensionable, IE: insurable,
      QPIP: statutory.qpip, EI_ER: statutory.eiEmployer, QPIP_ER: statutory.qpipEmployer,
    };
  }

  const deductions = sum(lines.filter((l) => l.kind === "deduction").map((l) => l.amount));
  const net = add(gross, neg(deductions));
  if (cmp(net, "0") < 0) throw new PayrollError(`net pay is negative (${net})`);
  const employerCost = sum(
    lines.filter((l) => l.kind === "employer_contribution").map((l) => l.amount),
  );

  const stub = (await tx.execute(sql`
    insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province,
                           periods_per_year, pay_date, tax_year, federal_claim, provincial_claim,
                           currency_code, gross, pensionable_earnings, insurable_earnings,
                           net_pay, employer_cost, vacation_accrued, factors, created_by, updated_by)
    values (${orgId}, ${documentId}, ${employeePartyId}, ${province}, ${P},
            ${run.pay_date}, ${taxYear}, ${factors.TC ?? "0"}, ${factors.TCP ?? "0"},
            ${run.doc_currency}, ${gross}, ${pensionable}, ${insurable},
            ${net}, ${employerCost}, ${vacationAccrued}, ${JSON.stringify(factors)}::jsonb,
            ${actorId}, ${actorId})
    returning id
  `)) as unknown as { rows: { id: string }[] };
  const stubId = stub.rows[0]!.id;
  for (const line of lines) {
    await tx.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, hours, rate,
                                  amount, project_id, department_id, time_type_id, sequence,
                                  created_by, updated_by)
      values (${orgId}, ${stubId}, ${line.componentId}, ${line.kind}, ${line.description},
              ${line.hours ?? null}, ${line.rate ?? null}, ${line.amount},
              ${line.projectId ?? null}, ${line.departmentId ?? null}, ${line.timeTypeId ?? null},
              ${line.sequence}, ${actorId}, ${actorId})
    `);
  }

  return { employeePartyId, province, gross, net, employerCost, errors: [] };
}

export interface PayRunGlLeg {
  accountId: string;
  amount: string;
  partyId: string | null;
  projectId: string | null;
  departmentId: string | null;
  description: string;
}

/**
 * Build the balanced GL projection for a calculated run — shared by commit
 * (which writes it into document_lines) and the wizard's pre-commit preview.
 * Throws PayrollError on missing accounts or an unbalanced projection, so the
 * preview surfaces setup problems before anything is written.
 */
async function payRunGlLegs(
  tx: Pick<typeof db, "execute">, orgId: string, documentId: string,
): Promise<{ legs: PayRunGlLeg[]; debitTotal: string }> {
  {
    const settings = await payrollSettings(orgId);
    const costing = await laborCostingSettings(orgId);
    const control = (await tx.execute(sql`
      select settings->'controlAccounts' as c from orgs where id = ${orgId}
    `)) as unknown as { rows: { c: Record<string, string | null> | null }[] };
    const laborClearing = control.rows[0]?.c?.laborClearing ?? null;

    const requireAccount = (value: string | null, label: string): string => {
      if (!value) throw new PayrollError(`payroll setup incomplete: ${label} account is not configured`);
      return value;
    };
    const wageExpense = requireAccount(settings.wageExpenseAccountId, "wage expense");
    const netPayable = requireAccount(settings.netPayAccountId, "net pay payable");
    const burdenExpense = settings.burdenExpenseAccountId ?? wageExpense;
    // Statutory liabilities are pack-declared: each seeded component carries
    // its slot's account (Payroll setup → Accounts & posting). The legacy
    // org-level settings keys remain a read fallback for pre-pack tenants.
    const statutoryLiability: Record<string, string | null> = {
      income_tax: settings.taxPayableAccountId,
      cpp: settings.cppPayableAccountId,
      cpp2: settings.cppPayableAccountId,
      ei: settings.eiPayableAccountId,
      qpip: settings.eiPayableAccountId,
      vacation_accrual: settings.vacationPayableAccountId,
    };
    const wagesToClearing = settings.wagesTo === "labor_clearing" && costing.mode === "post";
    if (settings.wagesTo === "labor_clearing" && !laborClearing) {
      throw new PayrollError("payroll setup incomplete: labor clearing account is not configured");
    }

    const stubLines = (await tx.execute(sql`
      select s.employee_party_id, l.kind, l.description, l.amount, l.project_id, l.department_id,
             c.system_key, c.expense_account_id, c.liability_account_id, s.net_pay
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id
        left join pay_components c on c.id = l.component_id
       where l.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
       order by s.employee_party_id, l.sequence
    `)) as unknown as { rows: Record<string, string | null>[] };
    if (stubLines.rows.length === 0) throw new PayrollError("pay run has no calculated stubs");

    // Aggregate GL legs: key = account|project|department|party (party only on net pay)
    const legs = new Map<string, {
      accountId: string; amount: string; partyId: string | null;
      projectId: string | null; departmentId: string | null; description: string;
    }>();
    const accumulate = (
      accountId: string, amount: string, description: string,
      opts: { partyId?: string | null; projectId?: string | null; departmentId?: string | null } = {},
    ) => {
      if (cmp(amount, "0") === 0) return;
      const key = [accountId, opts.partyId ?? "", opts.projectId ?? "", opts.departmentId ?? ""].join("|");
      const existing = legs.get(key);
      if (existing) existing.amount = add(existing.amount, amount);
      else legs.set(key, {
        accountId, amount, description,
        partyId: opts.partyId ?? null, projectId: opts.projectId ?? null,
        departmentId: opts.departmentId ?? null,
      });
    };

    const netByEmployee = new Map<string, string>();
    for (const line of stubLines.rows) {
      netByEmployee.set(line.employee_party_id!, line.net_pay!);
      const amount = line.amount!;
      if (line.kind === "earning") {
        const isTimeDriven = line.system_key === "base_pay" || line.system_key === "overtime";
        if (isTimeDriven && wagesToClearing) {
          // Standard cost already posted to the job at approval; wash clearing.
          accumulate(laborClearing!, amount, "Wages (labor clearing)");
        } else {
          accumulate(line.expense_account_id ?? wageExpense, amount, line.description ?? "Wages", {
            projectId: line.project_id, departmentId: line.department_id,
          });
        }
      } else if (line.kind === "deduction") {
        const liability = line.liability_account_id
          ?? (line.system_key ? statutoryLiability[line.system_key] : null);
        if (!liability) {
          throw new PayrollError(
            `deduction "${line.description}" has no liability account — set it in Payroll setup → Accounts & posting`,
          );
        }
        accumulate(liability, neg(amount), line.description ?? "Deduction");
      } else {
        const liability = line.liability_account_id
          ?? (line.system_key ? statutoryLiability[line.system_key] : null);
        if (!liability) {
          throw new PayrollError(
            `employer contribution "${line.description}" has no liability account — set it in Payroll setup → Accounts & posting`,
          );
        }
        // Job-costed burdens (union fringes) carry the line's project split.
        accumulate(line.expense_account_id ?? burdenExpense, amount, line.description ?? "Employer burden", {
          projectId: line.project_id, departmentId: line.department_id,
        });
        accumulate(liability, neg(amount), line.description ?? "Employer burden");
      }
    }
    for (const [employeePartyId, net] of netByEmployee) {
      accumulate(netPayable, neg(net), "Net pay", { partyId: employeePartyId });
    }

    const total = sum([...legs.values()].map((l) => l.amount));
    if (cmp(total, "0") !== 0) throw new PayrollError(`pay run GL projection is unbalanced (${total})`);
    const debitTotal = sum([...legs.values()].filter((l) => cmp(l.amount, "0") > 0).map((l) => l.amount));
    return { legs: [...legs.values()], debitTotal };
  }
}

/**
 * Commit: materialize the balanced GL projection into document_lines and claim
 * the period's time entries. The document then posts through the standard
 * submit/post action (RULES.pay_run maps lines 1:1, signed, like a journal).
 */
export async function commitPayRun(input: {
  orgId: string; documentId: string; actorId: string;
}): Promise<{ lines: number }> {
  const { orgId, documentId, actorId } = input;
  return await db.transaction(async (tx) => {
    const runRows = (await tx.execute(sql`
      select r.*, d.status as doc_status from pay_runs r
      join documents d on d.id = r.document_id
      where r.org_id = ${orgId} and r.document_id = ${documentId} for update
    `)) as unknown as { rows: Record<string, string>[] };
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (run.run_status !== "calculated") throw new PayrollError("calculate the pay run before committing");
    if (run.doc_status !== "draft") throw new PayrollError("pay run document is not editable");

    const { legs, debitTotal } = await payRunGlLegs(tx, orgId, documentId);

    await tx.execute(sql`delete from document_lines where org_id = ${orgId} and document_id = ${documentId}`);
    let lineNumber = 1;
    for (const leg of legs) {
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    amount, party_id, project_id, department_id, created_by, updated_by)
        values (${orgId}, ${documentId}, ${lineNumber++}, ${leg.accountId}, ${leg.description},
                ${leg.amount}, ${leg.partyId}, ${leg.projectId}, ${leg.departmentId},
                ${actorId}, ${actorId})
      `);
    }

    await tx.execute(sql`
      update time_entries set payroll_batch_ref = ${documentId}
       where org_id = ${orgId} and status = 'approved'
         and worked_on between ${run.period_start} and ${run.period_end}
         and payroll_batch_ref is null
         and employee_party_id in (
           select employee_party_id from pay_stubs where pay_run_document_id = ${documentId}
         )
    `);
    await tx.execute(sql`
      update pay_runs set run_status = 'committed', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
    `);
    await tx.execute(sql`
      update documents set subtotal = ${debitTotal}, total = ${debitTotal},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${documentId}
    `);
    return { lines: legs.length };
  });
}

/**
 * Pre-commit GL preview: the exact legs commit would write, enriched with
 * account/party/project names for the wizard's review step. Read-only —
 * setup problems (missing accounts, imbalance) surface as PayrollError here
 * before anything is written.
 */
export async function previewPayRunGl(
  orgId: string, documentId: string,
): Promise<{ legs: (PayRunGlLeg & {
  accountLabel: string; partyName: string | null; projectName: string | null;
})[]; debitTotal: string }> {
  const runRows = (await db.execute(sql`
    select r.run_status from pay_runs r
     where r.org_id = ${orgId} and r.document_id = ${documentId}
  `)) as unknown as { rows: { run_status: string }[] };
  if (!runRows.rows[0]) throw new PayrollError("pay run not found");
  if (runRows.rows[0].run_status === "draft") {
    throw new PayrollError("calculate the pay run to preview its GL impact");
  }
  const { legs, debitTotal } = await payRunGlLegs(db, orgId, documentId);
  const accountIds = [...new Set(legs.map((l) => l.accountId))];
  const partyIds = [...new Set(legs.map((l) => l.partyId).filter(Boolean))] as string[];
  const projectIds = [...new Set(legs.map((l) => l.projectId).filter(Boolean))] as string[];
  const [accounts, parties, projects] = (await Promise.all([
    db.execute(sql`select id, number, name from accounts
                    where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])`),
    partyIds.length
      ? db.execute(sql`select id, display_name from parties
                        where org_id = ${orgId} and id = any(${`{${partyIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
    projectIds.length
      ? db.execute(sql`select id, name from projects
                        where org_id = ${orgId} and id = any(${`{${projectIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
  ])) as unknown as [
    { rows: { id: string; number: string | null; name: string }[] },
    { rows: { id: string; display_name: string }[] },
    { rows: { id: string; name: string }[] },
  ];
  const accountById = new Map(accounts.rows.map((a) => [a.id, a.number ? `${a.number} · ${a.name}` : a.name]));
  const partyById = new Map(parties.rows.map((p) => [p.id, p.display_name]));
  const projectById = new Map(projects.rows.map((p) => [p.id, p.name]));
  return {
    debitTotal,
    legs: legs.map((leg) => ({
      ...leg,
      accountLabel: accountById.get(leg.accountId) ?? leg.accountId,
      partyName: leg.partyId ? (partyById.get(leg.partyId) ?? null) : null,
      projectName: leg.projectId ? (projectById.get(leg.projectId) ?? null) : null,
    })),
  };
}
