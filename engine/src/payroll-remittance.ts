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
import { PayrollError, payrollSettings } from "./payroll-run.ts";

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

const CA_STATUTORY = ["cpp", "cpp2", "ei", "qpip", "income_tax"] as const;
const US_STATUTORY = ["fit", "ss", "medicare", "medicare_addl", "futa", "suta"] as const;

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

/**
 * Accrued-but-unremitted withholding by destination for pay dates in
 * [from, to] (committed and posted runs). Vacation accrual is an internal
 * liability, never remitted, and is excluded.
 */
export async function payrollRemittanceSummary(
  orgId: string,
  range: { from: string; to: string },
): Promise<RemittanceGroup[]> {
  const settings = await payrollSettings(orgId);
  const filingAccount = effectiveFilingAccountSql("prof");
  const rows = (await db.execute(sql`
    select c.id as component_id, c.code, c.name, c.kind, c.system_key, c.remittance_party_id,
           c.liability_account_id, ${filingAccount} as filing_account_id, sum(l.amount) as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id
      left join employee_payroll_profiles prof
        on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
     where l.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       and l.kind in ('deduction', 'employer_contribution')
       and coalesce(c.system_key, '') <> 'vacation_accrual'
     group by c.id, c.code, c.name, c.kind, c.system_key, c.remittance_party_id,
              c.liability_account_id, ${filingAccount}
     order by c.sequence, c.code
  `)) as unknown as {
    rows: {
      component_id: string; code: string; name: string; kind: "deduction" | "employer_contribution";
      system_key: string | null; remittance_party_id: string | null;
      liability_account_id: string | null; filing_account_id: string | null; amount: string;
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

  const statutoryLiability: Record<string, string | null> = {
    income_tax: settings.taxPayableAccountId,
    cpp: settings.cppPayableAccountId,
    cpp2: settings.cppPayableAccountId,
    ei: settings.eiPayableAccountId,
    qpip: settings.eiPayableAccountId,
  };
  const resolveParty = (row: (typeof rows.rows)[0]): string | null => {
    if (row.remittance_party_id) return row.remittance_party_id;
    if (row.system_key && (CA_STATUTORY as readonly string[]).includes(row.system_key)) {
      return settings.craRemittancePartyId;
    }
    return null; // US statutory + unassigned user components: surfaced for setup
  };
  const resolveAccount = (row: (typeof rows.rows)[0]): string | null =>
    row.liability_account_id ?? (row.system_key ? (statutoryLiability[row.system_key] ?? null) : null);

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

/** A withholding total for one component under one filing account. */
export interface RemittanceRow {
  component_id: string;
  code: string;
  name: string;
  kind: "deduction" | "employer_contribution";
  system_key: string | null;
  remittance_party_id: string | null;
  liability_account_id: string | null;
  filing_account_id: string | null;
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
    group.components.push({
      componentId: row.component_id, code: row.code, name: row.name, kind: row.kind,
      systemKey: row.system_key, liabilityAccountId: input.resolveAccount(row),
      accountLabel: null, amount: row.amount,
    });
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
 * The CRA due date for a remittance period — or NOTHING, deliberately.
 *
 * A remitter's due date is a function of `payroll_filing_accounts.remitter_type`
 * (regular | quarterly | accelerated_1 | accelerated_2), which the product
 * stores, edits in Setup and round-trips. Only the REGULAR schedule is a pure
 * calendar rule (the 15th of the month following the month of the pay date).
 * The other three depend on where each pay date falls inside the month and on
 * the next business day when the deadline lands on a weekend or a statutory
 * holiday — a working-day calendar this product does not have yet.
 *
 * Until it does, this returns null for those and the bill carries NO due date.
 * Stamping the 15th on an accelerated remitter's bill would be confidently
 * wrong by weeks, and the CRA penalty for a late remittance is 3–10% of the
 * amount — a blank date an operator must fill in is the cheap failure, an
 * invented one is not. The remitter type travels on the bill so the operator
 * knows why it is blank.
 */
export function remittanceDueDate(
  periodTo: string,
  remitterType: PayrollFilingAccount["remitterType"] | null,
): string | null {
  // No filing account configured = the CRA's default registration for a new
  // employer, which is a regular remitter. That is the previous behaviour of a
  // single-account org, preserved exactly.
  if (remitterType !== null && remitterType !== "regular") return null;
  const [y, m] = periodTo.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m!, 15));
  return next.toISOString().slice(0, 10);
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
