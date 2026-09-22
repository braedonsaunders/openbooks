import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, toUnits } from "../money/money.ts";
import { PaymentError } from "./payment-errors.ts";
import { sameCurrencyAllocation, validateAllocationInputs, type AllocationInput } from "./settlement-policy.ts";
import { type OpenItemSide, type CreditAllocationInput } from "./payment-contracts.ts";
import { paymentControlDeps } from "./payment-accounts.ts";
/** Validate credit workpapers against the payment, not merely against each
 * other. Endpoint locks serialize cash and credit capacity checks together. */
export async function validateCreditAllocations(
  credits: CreditAllocationInput[], allocations: AllocationInput[],
  scope: { orgId: string; partyId: string | null; subsidiaryId: string | null; bookId: string; side: OpenItemSide; controlAccountId: string | null },
): Promise<void> {
  if (!credits.length) return;
  if (!scope.partyId || !scope.subsidiaryId) throw new PaymentError("credit applications require a payment party and subsidiary");
  validateAllocationInputs(credits.map(a => sameCurrencyAllocation(`${a.fromLineId}:${a.toLineId}`, a.amount)));
  const ids = [...new Set([...allocations.map(a => a.openLineId), ...credits.flatMap(a => [a.fromLineId, a.toLineId])])];
  await db.execute(sql`select id from journal_lines where org_id = ${scope.orgId} and id in ${ids} order by id for update`);
  const rows = (await db.execute<{
    id: string; account_id: string; party_id: string | null; subsidiary_id: string;
    book_id: string; status: string; is_open_item: boolean; amount: string; source_document_id: string | null;
    source_document_kind: string | null;
    currency: string; base_currency: string; txn_amount: string;
    source_used: string; target_used: string; source_txn_used: string; target_txn_used: string;
  }>(sql`
    select jl.id, jl.account_id, jl.party_id, jl.subsidiary_id, je.book_id, je.status,
           jl.is_open_item, jl.amount, jl.currency, jl.txn_amount, s.base_currency, d.id as source_document_id,
           d.kind as source_document_kind,
           coalesce(ap.source_used,0) as source_used, coalesce(ap.target_used,0) as target_used,
           coalesce(ap.source_txn_used,0) as source_txn_used, coalesce(ap.target_txn_used,0) as target_txn_used
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
      join subsidiaries s on s.id = jl.subsidiary_id and s.org_id = jl.org_id
      left join documents d on d.id = je.source_document_id and d.org_id = jl.org_id
      left join lateral (
        select sum(a.source_amount) filter(where a.from_line_id=jl.id) as source_used,
               sum(a.amount) filter(where a.to_line_id=jl.id) as target_used,
               sum(a.source_transaction_amount) filter(where a.from_line_id=jl.id) as source_txn_used,
               sum(a.target_transaction_amount) filter(where a.to_line_id=jl.id) as target_txn_used
          from applications a where a.org_id=jl.org_id and a.unapplied_at is null
           and (a.from_line_id=jl.id or a.to_line_id=jl.id)
      ) ap on true
     where jl.org_id=${scope.orgId} and jl.id in ${ids}
  `)).rows;
  const byId = new Map(rows.map(row => [row.id, row]));
  const targetAccounts = new Set(allocations.map(a => byId.get(a.openLineId)?.account_id));
  const deps = scope.controlAccountId ? null : await paymentControlDeps(scope.orgId);
  const account = scope.controlAccountId ?? (targetAccounts.size === 1 ? [...targetAccounts][0] : null)
    ?? (scope.side === "ap" ? deps!.control.ap : deps!.control.ar);
  const sourceAmounts = new Map<string, bigint>();
  const targetAmounts = new Map<string, bigint>();
  for (const allocation of allocations) targetAmounts.set(allocation.openLineId,
    (targetAmounts.get(allocation.openLineId) ?? 0n) + toUnits(allocation.targetTransactionAmount));
  for (const credit of credits) {
    if (!credit.sourceDocumentId || byId.get(credit.fromLineId)?.source_document_id !== credit.sourceDocumentId) {
      throw new PaymentError("credit source document must match the tenant-owned posted credit entry");
    }
    // The "credit" in a credit settlement must be a credit MEMO. The source-
    // document match alone does not say which document kind supplied the
    // line: any posted open item of the right sign (a receipt's on-account
    // residual, another invoice's receivable) passes the checks above, and
    // settling it through the credit path stamps
    // settlement_rate_source='same_currency', reference='credit applied
    // without cash' on balance that arose from cash - then its unapply
    // refusal points at the destructive void for evidence this path
    // created. The shipped panel only ever names the credit's own line, so
    // this closes the engine to what the product means, not only what the
    // UI offers.
    const expectedKind = scope.side === "ap" ? "vendor_credit" : "customer_credit";
    if (byId.get(credit.fromLineId)?.source_document_kind !== expectedKind) {
      throw new PaymentError(
        `the credit in a ${scope.side} settlement must be a posted ${expectedKind} line; cash-sourced or invoice open items settle through a payment, not the credit path`,
      );
    }
    for (const [id, source] of [[credit.fromLineId, true], [credit.toLineId, false]] as const) {
      const row = byId.get(id);
      if (!row || row.party_id !== scope.partyId || row.subsidiary_id !== scope.subsidiaryId ||
          row.book_id !== scope.bookId || row.account_id !== account || row.status !== "posted" || !row.is_open_item) {
        throw new PaymentError("credit applications must use posted open items in the payment's party, control account, subsidiary, and book");
      }
      const positive = scope.side === "ap" ? source : !source;
      if ((positive ? cmp(row.amount, "0") <= 0 : cmp(row.amount, "0") >= 0)) {
        throw new PaymentError("credit application endpoints have the wrong payment side or sign");
      }
      if (row.currency !== row.base_currency || cmp(row.amount, row.txn_amount) !== 0) {
        throw new PaymentError("foreign-currency credit applications require explicit transaction amounts");
      }
    }
    const units = toUnits(credit.amount);
    sourceAmounts.set(credit.fromLineId, (sourceAmounts.get(credit.fromLineId) ?? 0n) + units);
    targetAmounts.set(credit.toLineId, (targetAmounts.get(credit.toLineId) ?? 0n) + units);
  }
  for (const [amounts, source] of [[sourceAmounts, true], [targetAmounts, false]] as const) {
    for (const [id, amount] of amounts) {
      const row = byId.get(id);
      // Cash-only foreign targets already undergo dual-currency validation.
      if (!row || (!source && !credits.some(a => a.toLineId === id))) continue;
      const abs = (v: string) => { const n = toUnits(v); return n < 0n ? -n : n; };
      if (amount > abs(row.amount) - toUnits(source ? row.source_used : row.target_used) ||
          amount > abs(row.txn_amount) - toUnits(source ? row.source_txn_used : row.target_txn_used)) {
        throw new PaymentError("credit and cash applications exceed an endpoint's open balance");
      }
    }
  }
}
