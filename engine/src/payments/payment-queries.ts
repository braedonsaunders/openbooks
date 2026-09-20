import { sql } from "drizzle-orm";
import { db, orgContext } from "../platform/db.ts";
import { cmp, fromUnits, sum, toUnits } from "../money/money.ts";
import { PaymentError } from "./payment-errors.ts";
import { sameCurrencyAllocation, type AllocationInput } from "./settlement-policy.ts";
import { type PaymentKind, type OpenItemSide, type OpenItem, type SuggestedApplication } from "./payment-contracts.ts";
import { paymentBookId } from "./payment-accounts.ts";
/**
 * Automated cash application: propose how an incoming amount settles a party's
 * open items. Prefers a reference-number hit, then an exact single-item match,
 * then oldest-first (FIFO) allocation. Pure over `openItemsForParty`, so the
 * caller confirms and posts via `postPaymentWithApplications`.
 */
export async function suggestApplications(
  partyId: string,
  amount: string,
  side: OpenItemSide = "ar",
  opts?: { reference?: string | null; sourceCurrency: string; orgId?: string; allowedSubsidiaryIds?: ReadonlySet<string> | null },
): Promise<SuggestedApplication> {
  if (!opts?.sourceCurrency) throw new PaymentError("payment currency is required for automatic application");
  // Automated allocation is intentionally limited to open items already in the
  // payment currency. Cross-currency rows require explicit rate evidence and
  // source/target amounts from the accountant or bank advice.
  const items = (await openItemsForParty(partyId, side, opts.orgId, opts.allowedSubsidiaryIds)).filter((item) => item.currency === opts.sourceCurrency);
  const target = toUnits(amount);
  if (target <= 0n || items.length === 0) {
    return { allocations: [], applied: "0", remaining: fromUnits(target < 0n ? 0n : target), strategy: "none" };
  }

  // 1) reference match — the payment memo/ref names a specific invoice
  const ref = opts?.reference?.trim().toLowerCase();
  if (ref) {
    const m = items.find(
      (i) => (i.documentNumber ?? "").toLowerCase() === ref || (i.referenceNumber ?? "").toLowerCase() === ref,
    );
    if (m) {
      const take = toUnits(m.transactionOpen) <= target ? toUnits(m.transactionOpen) : target;
      return { allocations: [sameCurrencyAllocation(m.lineId, fromUnits(take))], applied: fromUnits(take), remaining: fromUnits(target - take), strategy: "reference" };
    }
  }

  // 2) exact single-item match — paid one invoice to the cent
  const exact = items.find((i) => toUnits(i.transactionOpen) === target);
  if (exact) {
    return { allocations: [sameCurrencyAllocation(exact.lineId, amount)], applied: amount, remaining: "0", strategy: "exact" };
  }

  // 3) FIFO oldest-first (openItemsForParty is ordered by due/posting date)
  const allocations: AllocationInput[] = [];
  let remaining = target;
  for (const i of items) {
    if (remaining <= 0n) break;
    const take = toUnits(i.transactionOpen) <= remaining ? toUnits(i.transactionOpen) : remaining;
    if (take > 0n) {
      allocations.push(sameCurrencyAllocation(i.lineId, fromUnits(take)));
      remaining -= take;
    }
  }
  return { allocations, applied: fromUnits(target - remaining), remaining: fromUnits(remaining), strategy: allocations.length ? "fifo" : "none" };
}

/**
 * Open AP (credit) or AR (debit) journal lines for a party: is_open_item
 * lines on posted entries, with applied-to-date sums and remaining balance.
 */
function paymentSubsidiaryScope(column: ReturnType<typeof sql>, allowed?: ReadonlySet<string> | null) {
  if (allowed == null) return sql``;
  if (allowed.size === 0) return sql` and false`;
  return sql` and ${column} = any(${`{${[...allowed].join(',')}}`}::uuid[])`;
}

export async function openItemsForParty(partyId: string, side: OpenItemSide, orgId?: string, allowedSubsidiaryIds?: ReadonlySet<string> | null): Promise<OpenItem[]> {
  const tenantId = orgId ?? orgContext.getStore()?.orgId;
  if (!tenantId) throw new PaymentError("organization is required to select payment open items");
  const bookId = await paymentBookId(tenantId);
  const signFilter = side === "ap" ? sql`jl.amount < 0` : sql`jl.amount > 0`;
  const orgFilter = sql`jl.org_id = ${tenantId} and je.book_id = ${bookId} and`;
  const r = (await db.execute<{
      line_id: string;
      amount: string;
      due_date: string | null;
      memo: string | null;
      entry_id: string;
      entry_number: string;
      posting_date: string;
      document_id: string | null;
      document_number: string | null;
      document_kind: string | null;
      reference_number: string | null;
      applied: string;
      currency: string;
      fx_rate: string;
      transaction_amount: string;
      transaction_applied: string;
    }>(sql`
    select jl.id as line_id, abs(jl.amount) as amount, jl.due_date, jl.memo,
           jl.currency, jl.fx_rate, abs(jl.txn_amount) as transaction_amount,
           je.id as entry_id, je.entry_number, je.posting_date,
           d.id as document_id, d.document_number, d.kind as document_kind, d.reference_number,
           coalesce(ap.applied, 0) as applied,
           coalesce(ap.transaction_applied, 0) as transaction_applied
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
      left join documents d on d.id = je.source_document_id and d.org_id = je.org_id
      left join lateral (
        select sum(a.amount) as applied, sum(a.target_transaction_amount) as transaction_applied
          from applications a
         where a.to_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
      ) ap on true
     where ${orgFilter} jl.party_id = ${partyId} and jl.is_open_item and ${signFilter}
       ${paymentSubsidiaryScope(sql`jl.subsidiary_id`, allowedSubsidiaryIds)}
     order by jl.due_date nulls last, je.posting_date, je.entry_number
  `));
  return r.rows
    .map((row) => ({
      lineId: row.line_id,
      entryId: row.entry_id,
      entryNumber: row.entry_number,
      postingDate: row.posting_date,
      dueDate: row.due_date,
      documentId: row.document_id,
      documentNumber: row.document_number,
      documentKind: row.document_kind,
      referenceNumber: row.reference_number,
      memo: row.memo,
      amount: row.amount,
      applied: row.applied,
      open: sum([row.amount, negStr(String(row.applied))]),
      currency: row.currency,
      fxRate: row.fx_rate,
      transactionAmount: row.transaction_amount,
      transactionApplied: row.transaction_applied,
      transactionOpen: sum([row.transaction_amount, negStr(String(row.transaction_applied))]),
    }))
    .filter((i) => cmp(i.open, "0") > 0);
}

function negStr(a: string): string {
  return toUnits(a) === 0n ? "0" : a.startsWith("-") ? a.slice(1) : `-${a}`;
}

/**
 * Posted, still-open credit-memo lines available as application sources for a
 * party: the mirror of openItemsForParty, which lists only debit items a
 * payment can extinguish. Credits carry the opposite sign (AR: amount < 0,
 * AP: amount > 0) and are consumed from the from_line side of applications.
 * Only lines with remaining open balance are returned.
 */
export async function creditItemsForParty(
  partyId: string,
  side: OpenItemSide = "ar",
  orgId?: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<OpenItem[]> {
  const tenantId = orgId ?? orgContext.getStore()?.orgId;
  if (!tenantId) throw new PaymentError("organization is required to select credit open items");
  const bookId = await paymentBookId(tenantId);
  const creditKind = side === "ap" ? "vendor_credit" : "customer_credit";
  const signFilter = side === "ap" ? sql`jl.amount > 0` : sql`jl.amount < 0`;
  const r = (await db.execute<{
    line_id: string;
    amount: string;
    due_date: string | null;
    memo: string | null;
    entry_id: string;
    entry_number: string;
    posting_date: string;
    document_id: string | null;
    document_number: string | null;
    document_kind: string | null;
    reference_number: string | null;
    applied: string;
    currency: string;
    fx_rate: string;
    transaction_amount: string;
    transaction_applied: string;
  }>(sql`
    select jl.id as line_id, abs(jl.amount) as amount, jl.due_date, jl.memo,
           jl.currency, jl.fx_rate, abs(jl.txn_amount) as transaction_amount,
           je.id as entry_id, je.entry_number, je.posting_date,
           d.id as document_id, d.document_number, d.kind as document_kind, d.reference_number,
           coalesce(ap.applied, 0) as applied,
           coalesce(ap.transaction_applied, 0) as transaction_applied
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
      join documents d on d.id = je.source_document_id and d.org_id = je.org_id and d.kind = ${creditKind}
      left join lateral (
        select sum(a.source_amount) as applied, sum(a.source_transaction_amount) as transaction_applied
          from applications a
         where a.from_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
      ) ap on true
     where jl.org_id = ${tenantId} and je.book_id = ${bookId} and jl.party_id = ${partyId}
       and jl.is_open_item and ${signFilter}
       ${paymentSubsidiaryScope(sql`jl.subsidiary_id`, allowedSubsidiaryIds)}
     order by jl.due_date nulls last, je.posting_date, je.entry_number
  `));
  return r.rows
    .map((row) => ({
      lineId: row.line_id,
      entryId: row.entry_id,
      entryNumber: row.entry_number,
      postingDate: row.posting_date,
      dueDate: row.due_date,
      documentId: row.document_id,
      documentNumber: row.document_number,
      documentKind: row.document_kind,
      referenceNumber: row.reference_number,
      memo: row.memo,
      amount: row.amount,
      applied: row.applied,
      open: sum([row.amount, negStr(String(row.applied))]),
      currency: row.currency,
      fxRate: row.fx_rate,
      transactionAmount: row.transaction_amount,
      transactionApplied: row.transaction_applied,
      transactionOpen: sum([row.transaction_amount, negStr(String(row.transaction_applied))]),
    }))
    .filter((i) => cmp(i.open, "0") > 0);
}

/**
 * Full drawer payload for a payment document: header, stored draft
 * allocations, and (once posted) the live applications with their targets.
 */
export async function loadPaymentDocument(id: string, kind: PaymentKind, orgId: string, allowedSubsidiaryIds?: ReadonlySet<string> | null) {
  const doc = (await db.execute<Record<string, unknown>>(sql`
    select d.*, (d.revision_seq)::text as updated_at,
           p.display_name as party_name, e.id as entry_id, e.entry_number,
           ba.id as bank_account_id_line, ba.number as bank_account_number, ba.name as bank_account_name
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
      left join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id and dl.line_number = 1
      left join accounts ba on ba.id = coalesce((d.custom->>'bankAccountId')::uuid, dl.account_id) and ba.org_id = d.org_id
     where d.id = ${id} and d.kind = ${kind} and d.org_id = ${orgId}
       ${paymentSubsidiaryScope(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `));
  const row = doc.rows[0];
  if (!row) return null;

  const custom = (row.custom ?? {}) as { bankAccountId?: string; allocations?: AllocationInput[] };
  const applied =
    row.status === "posted" && row.posted_entry_id
      ? ((await db.execute<Record<string, unknown>>(sql`
          select a.id, a.amount, a.source_amount,
                 a.source_transaction_amount, a.source_transaction_currency,
                 a.target_transaction_amount, a.target_transaction_currency,
                 a.settlement_rate, a.settlement_rate_source,
                 a.settlement_rate_reference, a.settlement_fx_rate_id,
                 a.fx_gain_loss_entry_id, a.applied_on,
                 te.entry_number as target_entry_number, te.posting_date as target_posting_date,
                 tl.due_date as target_due_date, abs(tl.amount) as target_amount,
                 abs(tl.txn_amount) as target_transaction_original,
                 td.id as target_document_id, td.document_number as target_document_number,
                 td.kind as target_document_kind, td.reference_number as target_reference_number
            from journal_lines jl
            join applications a on a.from_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
            join journal_lines tl on tl.id = a.to_line_id and tl.org_id = jl.org_id
            join journal_entries te on te.id = tl.entry_id and te.org_id = tl.org_id
            left join documents td on td.id = te.source_document_id and td.org_id = te.org_id
           where jl.entry_id = ${row.posted_entry_id} and jl.org_id = ${orgId}
           order by te.posting_date, te.entry_number
        `))).rows
      : [];

  return {
    doc: row,
    bankAccountId: custom.bankAccountId ?? null,
    allocations: custom.allocations ?? [],
    applied,
  };
}
