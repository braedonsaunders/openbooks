import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";
import { add } from "@openbooks/engine/src/money/money.ts";

export type ScheduleLineRow = {
  period_name: string;
  period_ends_on: string;
  planned_amount: string;
  recognized_amount: string | null;
  journal_entry_id: string | null;
  superseded_by_change_id?: string | null;
  reversal_journal_entry_id?: string | null;
  revision?: number;
};

export interface ObligationRow {
  id: string;
  description: string;
  allocated_price: string;
  recognition_starts_on: string | null;
  recognition_ends_on: string | null;
  status: string;
  method: string;
  rule_name: string;
  recognition_rule_id?: string;
  standalone_selling_price?: string | null;
  percent_complete?: string | null;
  deferred_account_id?: string | null;
  recognized_account_id?: string | null;
  /** Fair-value range review: set when the allocated per-unit price fell
   *  outside the matched fair value price's [low, high] range. */
  fair_value_flag: "below_range" | "above_range" | null;
  fair_value_low: string | null;
  fair_value_high: string | null;
  planned: string;
  recognized: string;
  lines: ScheduleLineRow[];
}

export interface ContractPayload {
  contract: {
    id: string;
    contract_number: string;
    subsidiary_id?: string | null;
    revision?: number;
    customer: string;
    status: string;
    currency: string | null;
    total_transaction_price: string;
    starts_on: string | null;
    ends_on: string | null;
    /**
     * The source customer invoice for invoice-sourced contracts (one contract
     * per invoice by construction). Null for project percent-complete
     * contracts, which have no invoice and nothing voidable. Carries the
     * cancellation target: the drawer offers Cancel recognition only when
     * this names a live invoice on an active contract.
     */
    sourceInvoiceId: string | null;
    sourceInvoiceNumber: string | null;
  };
  obligations: ObligationRow[];
  changes?: { id: string; effective_on: string; status: string }[];
}

/**
 * Load a revenue contract with its obligations and each obligation's primary-book
 * recognition schedule lines — the operational drill-down for the drawer.
 */
export async function loadContract(
  id: string,
  orgId: string,
  allowedSubsidiaryIds: Set<string> | null = null,
): Promise<ContractPayload | null> {
  const cRes = await db.execute<{
    id: string;
    contract_number: string;
    status: string;
    currency: string | null;
    total_transaction_price: string;
    starts_on: string | null;
    ends_on: string | null;
    customer: string;
    sourceInvoiceId: string | null;
    sourceInvoiceNumber: string | null;
  }>(sql`
    select c.id, c.subsidiary_id,c.revision,c.contract_number, c.status, c.currency, c.total_transaction_price, c.starts_on, c.ends_on,
           coalesce(p.display_name, '—') as customer
      from revenue_contracts c
      left join parties p on p.id = c.customer_id and p.org_id = c.org_id
     where c.id = ${id} and c.org_id = ${orgId} ${subsidiaryVisibleFilter(sql`coalesce(c.subsidiary_id,(select p.subsidiary_id from projects p where p.id=c.project_id and p.org_id=c.org_id),(select coalesce(dl.subsidiary_id,d.subsidiary_id) from performance_obligations o join document_lines dl on dl.id=o.document_line_id and dl.org_id=o.org_id join documents d on d.id=dl.document_id and d.org_id=dl.org_id where o.contract_id=c.id and o.org_id=c.org_id order by o.id limit 1))`, allowedSubsidiaryIds)}`);
  const contract = cRes.rows[0];
  if (!contract) return null;

  // One contract per invoice by construction (revenueContractPostingEffectKey),
  // so at most one source invoice exists; project contracts have none.
  const invRes = await db.execute<{ id: string; document_number: string }>(sql`
    select inv.id, inv.document_number
      from performance_obligations o
      join document_lines dl on dl.id = o.document_line_id and dl.org_id = o.org_id
      join documents inv on inv.id = dl.document_id and inv.org_id = dl.org_id
       and inv.kind = 'customer_invoice'
     where o.contract_id = ${id} and o.org_id = ${orgId}
     order by inv.document_number
     limit 1`);
  contract.sourceInvoiceId = invRes.rows[0]?.id ?? null;
  contract.sourceInvoiceNumber = invRes.rows[0]?.document_number ?? null;

  const oRes = await db.execute<{
    id: string;
    description: string;
    allocated_price: string;
    recognition_starts_on: string | null;
    recognition_ends_on: string | null;
    status: string;
    fair_value_flag: "below_range" | "above_range" | null;
    fair_value_low: string | null;
    fair_value_high: string | null;
    method: string;
    rule_name: string;
  }>(sql`
    select o.id, o.description, o.allocated_price, o.recognition_starts_on, o.recognition_ends_on, o.status,
           o.fair_value_flag, o.fair_value_low, o.fair_value_high,
           r.method, r.name as rule_name,o.recognition_rule_id,o.standalone_selling_price::text,o.percent_complete::text,
           coalesce(o.deferred_account_id,i.deferred_account_id,r.deferred_account_id) as deferred_account_id,
           coalesce(o.recognized_account_id,r.recognized_account_id,i.income_account_id) as recognized_account_id
      from performance_obligations o
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
      left join items i on i.id=o.item_id and i.org_id=o.org_id
     where o.contract_id = ${id} and o.org_id = ${orgId}
     order by o.created_at`);

  const obligations: ObligationRow[] = [];
  for (const o of oRes.rows) {
    const lRes = await db.execute<ScheduleLineRow>(sql`
      select p.name as period_name, p.ends_on as period_ends_on,
             l.planned_amount, l.recognized_amount, l.journal_entry_id,l.superseded_by_change_id,l.revision,l.reversal_journal_entry_id
        from recognition_schedules s
        join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_primary
        join recognition_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
        join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
       where s.obligation_id = ${o.id} and s.org_id = ${orgId}
       order by l.sequence`);
    const planned = lRes.rows.reduce(
      (a, r) =>
        r.superseded_by_change_id || r.reversal_journal_entry_id
          ? a
          : add(
              a,
              String(
                (r.journal_entry_id ? r.recognized_amount : r.planned_amount) ??
                  "0",
              ),
            ),
      "0",
    );
    const recognized = lRes.rows.reduce(
      (a, r) =>
        r.journal_entry_id && !r.reversal_journal_entry_id
          ? add(a, String(r.recognized_amount ?? "0"))
          : a,
      "0",
    );
    obligations.push({
      ...o,
      planned,
      recognized,
      lines: lRes.rows,
    });
  }

  const changes = (
    await db.execute<{
      id: string;
      operation: string;
      effective_on: string;
      status: string;
    }>(
      sql`select id,operation,effective_on::text,status from financial_changes where org_id=${orgId} and domain='revenue' and subject_id=${id} order by created_at desc`,
    )
  ).rows;
  return { contract, obligations, changes };
}

export async function revenueModificationOptions(
  orgId: string,
  allowed: Set<string> | null,
) {
  const [subsidiaries, accounts, rules, books] = await Promise.all([
    db.execute<{ value: string; label: string; currency: string }>(
      sql`select s.id as value,s.name as label,s.base_currency as currency from subsidiaries s where org_id=${orgId} and is_active and not is_elimination ${subsidiaryVisibleFilter(sql`s.id`, allowed)} order by name`,
    ),
    db.execute<{ value: string; label: string }>(
      sql`select id as value,number||' — '||name as label from accounts where org_id=${orgId} and is_active and not is_summary order by number`,
    ),
    db.execute<{ value: string; label: string; method: string }>(
      sql`select id as value,name as label,method from recognition_rules where org_id=${orgId} and is_active and not is_forecast order by name`,
    ),
    db.execute<{ value: string; label: string }>(
      sql`select id as value,name as label from accounting_books where org_id=${orgId} and is_active and posts_gl order by is_primary desc,code`,
    ),
  ]);
  return {
    subsidiaries: subsidiaries.rows,
    accounts: accounts.rows,
    rules: rules.rows,
    books: books.rows,
  };
}
export type RevenueModificationOptions = Awaited<
  ReturnType<typeof revenueModificationOptions>
>;
