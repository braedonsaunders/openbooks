import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, sum } from "./money.ts";
import { PayrollError, payrollSettings } from "./payroll-run.ts";

/**
 * Payroll remittance execution — the PD7A-shaped bridge from accrued
 * withholding liabilities to money out the door.
 *
 * Committed pay runs credit each component's liability account; a remittance
 * run sums those amounts for a period, grouped by remittance destination
 * (the component's remittance party — union funds set theirs on their
 * auto-provisioned components; CA statutory components fall back to the org's
 * CRA remittance vendor), and materializes ONE vendor bill per destination
 * that DEBITS the liability accounts. The bill then rides the normal AP
 * review/post/pay machinery — payroll never grows a second payment path.
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
  components: RemittanceComponentLine[];
  total: string;
  /** PD7A worksheet context: gross pay and employee count in the period. */
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
  const rows = (await db.execute(sql`
    select c.id as component_id, c.code, c.name, c.kind, c.system_key, c.remittance_party_id,
           c.liability_account_id, sum(l.amount) as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id
     where l.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       and l.kind in ('deduction', 'employer_contribution')
       and coalesce(c.system_key, '') <> 'vacation_accrual'
     group by c.id, c.code, c.name, c.kind, c.system_key, c.remittance_party_id, c.liability_account_id
     order by c.sequence, c.code
  `)) as unknown as {
    rows: {
      component_id: string; code: string; name: string; kind: "deduction" | "employer_contribution";
      system_key: string | null; remittance_party_id: string | null;
      liability_account_id: string | null; amount: string;
    }[];
  };
  if (rows.rows.length === 0) return [];

  const context = (await db.execute(sql`
    select coalesce(sum(s.gross), 0) as gross, count(distinct s.employee_party_id)::int as employees
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
     where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
  `)) as unknown as { rows: { gross: string; employees: number }[] };

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

  const groups = new Map<string, RemittanceGroup>();
  for (const row of rows.rows) {
    if (cmp(row.amount, "0") === 0) continue;
    const partyId = resolveParty(row);
    const key = partyId ?? "";
    const group = groups.get(key) ?? {
      partyId, partyName: null, components: [], total: "0",
      grossPayroll: context.rows[0]?.gross ?? "0",
      employeeCount: context.rows[0]?.employees ?? 0,
      existingBills: [],
    };
    group.components.push({
      componentId: row.component_id, code: row.code, name: row.name, kind: row.kind,
      systemKey: row.system_key, liabilityAccountId: resolveAccount(row),
      accountLabel: null, amount: row.amount,
    });
    group.total = add(group.total, row.amount);
    groups.set(key, group);
  }

  // Names + account labels + prior bills for the same destination/period.
  const partyIds = [...groups.keys()].filter(Boolean);
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
      select id, document_number, status, total, party_id, custom
        from documents
       where org_id = ${orgId} and kind = 'vendor_bill'
         and custom->'payrollRemittance'->>'from' = ${range.from}
         and custom->'payrollRemittance'->>'to' = ${range.to}
         and status <> 'voided'`),
  ])) as unknown as [
    { rows: { id: string; display_name: string }[] },
    { rows: { id: string; number: string | null; name: string }[] },
    { rows: { id: string; document_number: string; status: string; total: string; party_id: string | null }[] },
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
      .filter((b) => (b.party_id ?? null) === group.partyId)
      .map((b) => ({ documentId: b.id, documentNumber: b.document_number, status: b.status, total: b.total }));
  }
  return [...groups.values()].sort((a, b) => (a.partyName ?? "￿").localeCompare(b.partyName ?? "￿"));
}

/** The 15th of the month after the period end — the regular remitter due date. */
function remittanceDueDate(periodTo: string): string {
  const [y, m] = periodTo.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m!, 15));
  return next.toISOString().slice(0, 10);
}

/**
 * Materialize one destination's remittance as a draft vendor bill debiting
 * the liability accounts. Fails closed on unassigned accounts. The bill then
 * posts DR liabilities / CR AP and is paid like any other payable.
 */
export async function createRemittanceBill(
  orgId: string,
  actorId: string,
  input: { partyId: string; from: string; to: string },
): Promise<{ documentId: string; documentNumber: string }> {
  const groups = await payrollRemittanceSummary(orgId, { from: input.from, to: input.to });
  const group = groups.find((g) => g.partyId === input.partyId);
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
              ${remittanceDueDate(input.to)}, ${sub.rows[0]!.base_currency}, 'draft',
              ${`Payroll remittance ${input.from} – ${input.to}`}, ${total}, '0', ${total},
              ${JSON.stringify({ payrollRemittance: { partyId: input.partyId, from: input.from, to: input.to } })}::jsonb,
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
