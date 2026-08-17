import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, sum } from "./money.ts";
import {
  effectiveFilingAccountSql,
  filingAccountRef,
  filingAccountsById,
  type FilingAccountRef,
  type PayrollFilingAccount,
} from "./payroll-filing.ts";
import {
  addBusinessDays,
  holidayDateSet,
  nextBusinessDay,
  resolveObservedHolidays,
} from "./payroll-holidays.ts";
import { PayrollError } from "./payroll-error.ts";
import { legacyStatutoryLiabilityAccount, statutoryRemittanceDeclaration } from "./payroll/packs.ts";

/**
 * Payroll remittance execution — the PD7A-shaped bridge from accrued
 * withholding liabilities to money out the door.
 *
 * Committed pay runs credit each component's liability account; a remittance
 * run sums those amounts for a period, grouped by remittance destination
 * (the component's remittance party — union funds set theirs on their
 * auto-provisioned components; CA statutory components fall back to the org's
 * CRA remittance vendor) AND by the employees' payroll filing account, and
 * materializes ONE vendor bill per (destination, filing account) that DEBITS
 * the liability accounts. The bill then rides the normal AP review/post/pay
 * machinery — payroll never grows a second payment path.
 *
 * Grouping by filing account is what makes a multi-account employer correct: a
 * PD7A is filed per payroll program account (…RP0001, …RP0002), so amounts
 * withheld from RP0002's employees must never be remitted under RP0001. Orgs
 * with no filing accounts configured land in one unassigned group, which is
 * byte-for-byte the previous single-account behaviour.
 */

export interface RemittanceComponentLine {
  componentId: string;
  code: string;
  name: string;
  kind: "deduction" | "employer_contribution";
  systemKey: string | null;
  liabilityAccountId: string | null;
  accountLabel: string | null;
  amount: string;
}

export interface RemittanceGroup {
  partyId: string | null;
  partyName: string | null;
  /** The payroll program/EIN account this remittance is filed under. */
  filingAccount: FilingAccountRef;
  components: RemittanceComponentLine[];
  total: string;
  /** PD7A worksheet context: gross pay and employee count in the period,
   *  counted within this filing account (the PD7A is filed per account). */
  grossPayroll: string;
  employeeCount: number;
  /** Remittance bills already raised for this destination and period. */
  existingBills: { documentId: string; documentNumber: string; status: string; total: string }[];
}

/** The raw orgs.settings.payroll blob — indexed by whatever settings keys the
 *  pack declarations name, so this module needs no typed knowledge of them. */
async function rawPayrollSettings(orgId: string): Promise<Record<string, unknown>> {
  const r = (await db.execute(
    sql`select settings->'payroll' as p from orgs where id = ${orgId}`,
  )) as unknown as { rows: { p: Record<string, unknown> | null }[] };
  return r.rows[0]?.p ?? {};
}

/**
 * Accrued-but-unremitted withholding by destination for pay dates in
 * [from, to] (committed and posted runs).
 *
 * Which system keys are internal accruals — liabilities that settle through a
 * payout to the employee, never through a remittance to anyone — is a PACK
 * declaration (`remittance: 'internal_accrual'` in engine/src/payroll/packs.ts),
 * not a spelled key. The CA pack declares `vacation_accrual`; a pack whose
 * statute banks a different accrual declares its own, and this module never
 * learns the words.
 */
export async function payrollRemittanceSummary(
  orgId: string,
  range: { from: string; to: string },
): Promise<RemittanceGroup[]> {
  const declaration = statutoryRemittanceDeclaration();
  const rawSettings = await rawPayrollSettings(orgId);
  const filingAccount = effectiveFilingAccountSql("prof");
  // '' can never be a declared key, so the coalesce keeps user components
  // (null system_key) in the summary whatever the exclusion list holds.
  const internalAccruals = `{${declaration.internalAccrualSystemKeys.join(",")}}`;
  // Grouped by the STUB's snapshot province as well as by component: a
  // component whose pack declares a region-scoped remittance vendor (QPP and
  // QPIP go to Revenu Québec for QC employment, to the CRA nowhere) splits by
  // destination, and rows that resolve to the same vendor are re-merged per
  // component in groupRemittanceRows.
  const rows = (await db.execute(sql`
    select c.id as component_id, c.code, c.name, c.kind, c.system_key, c.remittance_party_id,
           c.liability_account_id, ${filingAccount} as filing_account_id, s.province,
           sum(l.amount) as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id
      left join employee_payroll_profiles prof
        on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
     where l.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       and l.kind in ('deduction', 'employer_contribution')
       and coalesce(c.system_key, '') <> all(${internalAccruals}::text[])
     group by c.id, c.code, c.name, c.kind, c.system_key, c.remittance_party_id,
              c.liability_account_id, ${filingAccount}, s.province
     order by c.sequence, c.code
  `)) as unknown as {
    rows: {
      component_id: string; code: string; name: string; kind: "deduction" | "employer_contribution";
      system_key: string | null; remittance_party_id: string | null;
      liability_account_id: string | null; filing_account_id: string | null;
      province: string; amount: string;
    }[];
  };
  if (rows.rows.length === 0) return [];

  const context = (await db.execute(sql`
    select ${filingAccount} as filing_account_id,
           coalesce(sum(s.gross), 0) as gross,
           count(distinct s.employee_party_id)::int as employees
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      left join employee_payroll_profiles prof
        on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
     where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
     group by ${filingAccount}
  `)) as unknown as { rows: { filing_account_id: string | null; gross: string; employees: number }[] };
  const contextByAccount = new Map(
    context.rows.map((row) => [row.filing_account_id ?? "", row]),
  );
  const filingAccounts = await filingAccountsById(orgId);

  // Destination and account both resolve through the pack declarations. A
  // component with a REGION-scoped vendor declaration for the stub's province
  // (QPP/QPIP → the Revenu Québec vendor for QC stubs) resolves there FIRST —
  // it outranks even the component's own remittance_party_id, because that
  // column is one value on a component whose amounts split by destination.
  // Otherwise a `tax_authority` component falls back to the vendor named by
  // ITS pack's remittanceVendorSettingsKey (the CRA remittance vendor for the
  // CA pack; a pack that declares none surfaces unassigned for setup, which
  // is where the US statutory components have always landed). An `external`
  // component (WCB, SUTA) only ever uses its own remittance_party_id.
  const settingsVendor = (settingsKey: string): string | null => {
    const vendor = rawSettings[settingsKey];
    return typeof vendor === "string" && vendor ? vendor : null;
  };
  const resolveParty = (row: (typeof rows.rows)[0]): string | null => {
    const regionalKey = row.system_key
      ? declaration.regionalVendorSettingsKeyBySystemKey.get(row.system_key)?.[row.province]
      : undefined;
    if (regionalKey) return settingsVendor(regionalKey);
    if (row.remittance_party_id) return row.remittance_party_id;
    const vendorKey = row.system_key
      ? declaration.vendorSettingsKeyBySystemKey.get(row.system_key)
      : undefined;
    if (!vendorKey) return null;
    return settingsVendor(vendorKey);
  };
  const resolveAccount = (row: (typeof rows.rows)[0]): string | null =>
    row.liability_account_id
    ?? (row.system_key ? legacyStatutoryLiabilityAccount(row.system_key, rawSettings) : null);

  const groups = groupRemittanceRows({
    rows: rows.rows, contextByAccount, filingAccounts, resolveParty, resolveAccount,
  });

  // Names + account labels + prior bills for the same destination/period.
  const partyIds = [...new Set([...groups.values()].map((g) => g.partyId).filter(Boolean))] as string[];
  const accountIds = [...new Set(
    [...groups.values()].flatMap((g) => g.components.map((c) => c.liabilityAccountId)).filter(Boolean),
  )] as string[];
  const [parties, accounts, bills] = (await Promise.all([
    partyIds.length
      ? db.execute(sql`select id, display_name from parties
                        where org_id = ${orgId} and id = any(${`{${partyIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
    accountIds.length
      ? db.execute(sql`select id, number, name from accounts
                        where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
    db.execute(sql`
      select id, document_number, status, total, party_id,
             custom->'payrollRemittance'->>'filingAccountId' as filing_account_id
        from documents
       where org_id = ${orgId} and kind = 'vendor_bill'
         and custom->'payrollRemittance'->>'from' = ${range.from}
         and custom->'payrollRemittance'->>'to' = ${range.to}
         and status <> 'voided'`),
  ])) as unknown as [
    { rows: { id: string; display_name: string }[] },
    { rows: { id: string; number: string | null; name: string }[] },
    {
      rows: {
        id: string; document_number: string; status: string; total: string;
        party_id: string | null; filing_account_id: string | null;
      }[];
    },
  ];
  const partyName = new Map(parties.rows.map((p) => [p.id, p.display_name]));
  const accountLabel = new Map(accounts.rows.map((a) => [a.id, a.number ? `${a.number} · ${a.name}` : a.name]));
  for (const group of groups.values()) {
    group.partyName = group.partyId ? (partyName.get(group.partyId) ?? null) : null;
    for (const component of group.components) {
      component.accountLabel = component.liabilityAccountId
        ? (accountLabel.get(component.liabilityAccountId) ?? null) : null;
    }
    group.existingBills = bills.rows
      .filter((b) =>
        groupKey(b.party_id ?? null, b.filing_account_id) ===
          groupKey(group.partyId, group.filingAccount.id))
      .map((b) => ({ documentId: b.id, documentNumber: b.document_number, status: b.status, total: b.total }));
  }
  return [...groups.values()].sort((a, b) =>
    (a.partyName ?? "￿").localeCompare(b.partyName ?? "￿")
    || (a.filingAccount.accountNumber ?? "").localeCompare(b.filingAccount.accountNumber ?? ""));
}

/** One remittance group = one destination vendor under one filing account. */
function groupKey(partyId: string | null, filingAccountId: string | null): string {
  return `${partyId ?? ""}::${filingAccountId ?? ""}`;
}

/** A withholding total for one component under one filing account, per stub
 *  province — the province is what a region-scoped remittance declaration
 *  (QPP/QPIP → Revenu Québec) resolves the destination from. */
export interface RemittanceRow {
  component_id: string;
  code: string;
  name: string;
  kind: "deduction" | "employer_contribution";
  system_key: string | null;
  remittance_party_id: string | null;
  liability_account_id: string | null;
  filing_account_id: string | null;
  province: string;
  amount: string;
}

/**
 * Fold component totals into one group per (destination vendor, filing
 * account). Pure, so the grouping rule that keeps one program account's
 * withholding out of another's PD7A is verifiable without a database.
 */
export function groupRemittanceRows(input: {
  rows: RemittanceRow[];
  contextByAccount: Map<string, { gross: string; employees: number }>;
  filingAccounts: Map<string, PayrollFilingAccount>;
  resolveParty: (row: RemittanceRow) => string | null;
  resolveAccount: (row: RemittanceRow) => string | null;
}): Map<string, RemittanceGroup> {
  const groups = new Map<string, RemittanceGroup>();
  for (const row of input.rows) {
    if (cmp(row.amount, "0") === 0) continue;
    const partyId = input.resolveParty(row);
    const key = groupKey(partyId, row.filing_account_id);
    const runContext = input.contextByAccount.get(row.filing_account_id ?? "");
    const group = groups.get(key) ?? {
      partyId, partyName: null,
      filingAccount: filingAccountRef(row.filing_account_id, input.filingAccounts),
      components: [], total: "0",
      grossPayroll: runContext?.gross ?? "0",
      employeeCount: runContext?.employees ?? 0,
      existingBills: [],
    };
    // Rows arrive per (component, province); provinces that resolve to the
    // SAME destination fold back into one component line, so a bill never
    // carries two lines for one component.
    const existing = group.components.find(
      (component) => component.componentId === row.component_id && component.kind === row.kind,
    );
    if (existing) {
      existing.amount = add(existing.amount, row.amount);
    } else {
      group.components.push({
        componentId: row.component_id, code: row.code, name: row.name, kind: row.kind,
        systemKey: row.system_key, liabilityAccountId: input.resolveAccount(row),
        accountLabel: null, amount: row.amount,
      });
    }
    group.total = add(group.total, row.amount);
    groups.set(key, group);
  }
  return groups;
}

/** Bill memo naming the period and, for multi-account employers, the account. */
function remittanceMemo(group: RemittanceGroup, from: string, to: string): string {
  const account = group.filingAccount.accountNumber
    ? ` · ${group.filingAccount.accountNumber}`
    : "";
  return `Payroll remittance ${from} – ${to}${account}`;
}

/**
 * The CRA public-holiday calendar a remittance deadline moves against.
 *
 * NOT the employer's calendar, and deliberately not tenant-overridable. The
 * CRA recognizes Easter Monday and the Civic Holiday, which no province's
 * employment standards act lists, and it excludes the Civic Holiday in Quebec
 * while recognizing Saint-Jean-Baptiste Day there. Letting an employer's own
 * closures push a federal deadline would be letting configuration create a
 * penalty; the pack's declaration is the whole input.
 *
 * Source: https://www.canada.ca/en/revenue-agency/services/tax/public-holidays.html
 */
function craCalendar(around: string, quebec: boolean): ReadonlySet<string> {
  const year = Number(around.slice(0, 4));
  return holidayDateSet(resolveObservedHolidays({
    jurisdiction: quebec ? "CA-CRA-QC" : "CA-CRA",
    from: `${year - 1}-01-01`,
    to: `${year + 1}-12-31`,
  }));
}

/** The last day of the month `date` falls in. */
function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/** The `day`th of the month `offsetMonths` after the one `date` falls in. */
function dayOfMonth(date: string, offsetMonths: number, day: number): string {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + offsetMonths, day)).toISOString().slice(0, 10);
}

export interface RemittanceDue {
  dueDate: string;
  /** The statutory rule applied, carried onto the bill so an operator can
   *  see WHY the date is what it is rather than trusting it. */
  rule: string;
}

/**
 * The CRA due date for a remittance period, for every remitter type.
 *
 * A remitter's deadline is a function of
 * `payroll_filing_accounts.remitter_type` and of where the period ends inside
 * the month. Each rule below is transcribed from the CRA's published
 * "When to remit (pay)" table, verified against canada.ca:
 *
 *   https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/
 *     payroll/remitting-source-deductions/how-when-remit-due-dates.html
 *
 * - QUARTERLY — "January 1 to March 31 … April 15; April 1 to June 30 …
 *   July 15; July 1 to September 30 … October 15; October 1 to December 31 …
 *   January 15": the 15th of the month following the end of the quarter the
 *   period falls in.
 * - REGULAR — remitting period is the calendar month; due "the 15th day of the
 *   next month".
 * - ACCELERATED THRESHOLD 1 — "1st to 15th of the month … 25th day of same
 *   month; 16th to end of the month … 10th day of the next month."
 * - ACCELERATED THRESHOLD 2 — four quarter-month periods, "1st to 7th … 3rd
 *   working day after the 7th; 8th to 14th … 3rd working day after the 14th;
 *   15th to 21st … 3rd working day after the 21st; 22nd to the last day … 3rd
 *   working day after the last day of the month."
 *
 * And the shift, from the same page: "If your due date falls on a Saturday, a
 * Sunday, or a public holiday recognized by the CRA, your remittance is on
 * time if the CRA receives it on the next business day." That applies to the
 * three fixed-date schedules. Threshold 2 needs no shift — counting three
 * WORKING days necessarily lands on a working day, which is exactly why this
 * function could not exist before there was a working-day calendar.
 *
 * The penalty for getting this wrong is 3% to 10% of the remittance (20% for a
 * repeat in the same calendar year), which is why every rule above is quoted
 * rather than remembered, and why the calendar is the CRA's own list rather
 * than an employer's.
 */
export function remittanceDueDateExplained(
  periodTo: string,
  remitterType: PayrollFilingAccount["remitterType"] | null,
  options: { quebec?: boolean } = {},
): RemittanceDue {
  const date = periodTo.slice(0, 10);
  const holidays = craCalendar(date, options.quebec === true);
  const day = Number(date.slice(8, 10));
  // No filing account configured = the CRA's default registration for a new
  // employer, which is a regular remitter. Previous single-account behaviour,
  // preserved exactly.
  const remitter = remitterType ?? "regular";

  switch (remitter) {
    case "regular":
      return {
        dueDate: nextBusinessDay(dayOfMonth(date, 1, 15), holidays),
        rule: "regular remitter — the 15th of the month following the month of the pay date",
      };
    case "quarterly": {
      // The quarter the period ends in; its following month's 15th.
      const month = Number(date.slice(5, 7));
      const monthsToQuarterEnd = 2 - ((month - 1) % 3);
      return {
        dueDate: nextBusinessDay(dayOfMonth(date, monthsToQuarterEnd + 1, 15), holidays),
        rule: "quarterly remitter — the 15th of the month following the end of the quarter",
      };
    }
    case "accelerated_1":
      return day <= 15
        ? {
            dueDate: nextBusinessDay(dayOfMonth(date, 0, 25), holidays),
            rule: "accelerated threshold 1 — remuneration paid the 1st to the 15th, "
              + "due the 25th of the same month",
          }
        : {
            dueDate: nextBusinessDay(dayOfMonth(date, 1, 10), holidays),
            rule: "accelerated threshold 1 — remuneration paid the 16th to month end, "
              + "due the 10th of the following month",
          };
    case "accelerated_2": {
      // Three WORKING days after the end of the quarter-month period the
      // remittance period closes in. addBusinessDays never counts the day it
      // starts from, so a period ending on the 7th counts the 8th onward.
      const [periodEnd, label] = day <= 7 ? [dayOfMonth(date, 0, 7), "the 1st to the 7th"]
        : day <= 14 ? [dayOfMonth(date, 0, 14), "the 8th to the 14th"]
        : day <= 21 ? [dayOfMonth(date, 0, 21), "the 15th to the 21st"]
        : [monthEnd(date), "the 22nd to the last day of the month"];
      return {
        dueDate: addBusinessDays(periodEnd!, 3, holidays),
        rule: `accelerated threshold 2 — remuneration paid ${label}, due the 3rd working day `
          + "after the end of that period",
      };
    }
  }
}

/**
 * The due date alone. Never null any more: the working-day calendar this used
 * to be missing is `engine/src/payroll-holidays.ts`, and all four CRA
 * schedules are now computed rather than refused.
 */
export function remittanceDueDate(
  periodTo: string,
  remitterType: PayrollFilingAccount["remitterType"] | null,
  options: { quebec?: boolean } = {},
): string {
  return remittanceDueDateExplained(periodTo, remitterType, options).dueDate;
}

/**
 * Materialize one destination's remittance as a draft vendor bill debiting
 * the liability accounts. Fails closed on unassigned accounts. The bill then
 * posts DR liabilities / CR AP and is paid like any other payable.
 *
 * `filingAccountId` selects the payroll program/EIN account being remitted;
 * omit it (or pass null) for the unassigned bucket of a single-account org.
 * One bill per account keeps each PD7A remittance separately traceable.
 */
export async function createRemittanceBill(
  orgId: string,
  actorId: string,
  input: { partyId: string; from: string; to: string; filingAccountId?: string | null },
): Promise<{ documentId: string; documentNumber: string }> {
  const filingAccountId = input.filingAccountId ?? null;
  const groups = await payrollRemittanceSummary(orgId, { from: input.from, to: input.to });
  const group = groups.find(
    (g) => g.partyId === input.partyId && g.filingAccount.id === filingAccountId,
  );
  if (!group) throw new PayrollError("nothing to remit to this vendor for the period");
  const missing = group.components.filter((c) => !c.liabilityAccountId);
  if (missing.length > 0) {
    throw new PayrollError(
      `no liability account for: ${missing.map((c) => c.name).join(", ")} — set it in Payroll setup → Accounts & posting`,
    );
  }

  return await db.transaction(async (tx) => {
    const vendor = (await tx.execute(sql`
      select 1 from vendor_roles where org_id = ${orgId} and party_id = ${input.partyId} and is_active
    `)) as unknown as { rows: unknown[] };
    if (!vendor.rows.length) throw new PayrollError("the remittance destination must be an active vendor");

    const sub = (await tx.execute(sql`
      select s.id, s.base_currency from subsidiaries s
       where s.org_id = ${orgId} and s.parent_id is null and s.is_active
       order by s.created_at limit 1
    `)) as unknown as { rows: { id: string; base_currency: string | null }[] };
    if (!sub.rows[0]) throw new PayrollError("no active root subsidiary");

    const seq = (await tx.execute(sql`
      insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
      values (${orgId}, 'vendor_bill', null, 'BILL-')
      on conflict on constraint sequences_org_kind_sub
      do update set next_number = number_sequences.next_number + 1
      returning prefix, next_number, padding
    `)) as unknown as { rows: { prefix: string; next_number: number; padding: number }[] };
    const number = `${seq.rows[0]!.prefix}${String(seq.rows[0]!.next_number).padStart(seq.rows[0]!.padding, "0")}`;

    const total = sum(group.components.map((c) => c.amount));
    const doc = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, party_id, subsidiary_id, document_date,
                             due_date, currency, status, memo, subtotal, tax_total, total, custom,
                             created_by, updated_by)
      values (${orgId}, 'vendor_bill', ${number}, ${input.partyId}, ${sub.rows[0]!.id}, ${input.to},
              ${remittanceDueDate(input.to, group.filingAccount.remitterType)},
              ${sub.rows[0]!.base_currency}, 'draft',
              ${remittanceMemo(group, input.from, input.to)}, ${total}, '0', ${total},
              ${JSON.stringify({
                payrollRemittance: {
                  partyId: input.partyId, from: input.from, to: input.to, filingAccountId,
                  // Why the due date may be blank: only a regular remitter has
                  // a calendar-only deadline this product can compute.
                  remitterType: group.filingAccount.remitterType,
                },
              })}::jsonb,
              ${actorId}, ${actorId})
      returning id
    `)) as unknown as { rows: { id: string }[] };
    const documentId = doc.rows[0]!.id;
    let lineNumber = 1;
    for (const component of group.components) {
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, created_by, updated_by)
        values (${orgId}, ${documentId}, ${lineNumber++}, ${component.liabilityAccountId},
                ${`${component.name} · ${input.from} – ${input.to}`}, 1, ${component.amount},
                ${component.amount}, ${actorId}, ${actorId})
      `);
    }
    return { documentId, documentNumber: number };
  });
}
