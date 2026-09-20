import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { add, fromUnits, roundDiv, sum, toUnits } from "../money/money.ts";
import { apportion } from "./recognition.ts";
export interface RevenueCreditSource {
  invoiceId: string;
  deferredAccountId: string;
  baseline: string;
  currency: string;
  fxRate: string;
}
/** Posted deferred credits are attributed by their ACTIVE settlement against
 * this invoice. Partial applications get only their proportion of the credit,
 * rather than the full credit being counted once for every invoice it touches. */
export async function invoiceDeferredCredit(
  tx: SqlExecutor,
  orgId: string,
  bookId: string,
  source: RevenueCreditSource,
): Promise<string> {
  const rows = (
    await tx.execute<{
      id: string;
      currency: string;
      amount: string;
      txn_amount: string;
      applied: string;
      principal: string;
    }>(sql`
 select credit.id,cl.currency,sum(cl.amount)::text as amount,sum(cl.txn_amount)::text as txn_amount,
   (select coalesce(sum(abs(app.target_transaction_amount)),0)::text from applications app join journal_lines fl on fl.id=app.from_line_id and fl.org_id=app.org_id join journal_lines tl on tl.id=app.to_line_id and tl.org_id=app.org_id
     where app.org_id=credit.org_id and app.unapplied_at is null and app.target_transaction_currency=${source.currency} and fl.entry_id=credit.posted_entry_id and tl.entry_id=inv.posted_entry_id) as applied,
   (select coalesce(sum(abs(fl.txn_amount)),0)::text from journal_lines fl where fl.org_id=credit.org_id and fl.entry_id=credit.posted_entry_id and fl.is_open_item and fl.currency=cl.currency) as principal
 from documents inv join documents credit on credit.org_id=inv.org_id and credit.kind='customer_credit' and credit.status='posted'
 join journal_entries ce on (ce.id=credit.posted_entry_id or (ce.source_document_id=credit.id and ce.reverses_entry_id is null)) and ce.org_id=credit.org_id and ce.book_id=${bookId} and ce.status='posted'
 join journal_lines cl on cl.entry_id=ce.id and cl.org_id=ce.org_id and cl.account_id=${source.deferredAccountId} and cl.amount>0
 where inv.org_id=${orgId} and inv.id=${source.invoiceId}
 group by credit.id,credit.org_id,credit.posted_entry_id,inv.posted_entry_id,cl.currency`)
  ).rows;
  return sum(
    rows.map((row) => {
      const applied = toUnits(row.applied),
        principal = toUnits(row.principal);
      if (applied === 0n) return "0.0000";
      if (principal === 0n)
        throw new Error(
          "an applied deferred credit has no settlement principal",
        );
      return fromUnits(roundDiv(toUnits(row.txn_amount) * applied, principal));
    }),
  );
}

export type CreditExposure =
  | { kind: "none" }
  | {
      kind: "invoice";
      source: RevenueCreditSource;
      weights: string[];
      index: number;
    }
  | {
      kind: "modification";
      changeId: string;
      bookId: string;
      groupIndex: number;
      promiseIndex: number;
    };
export interface CreditGroup {
  previous: { exposure: CreditExposure; baseline: string }[];
  weights: string[];
}
/** A modification references its immutable predecessor evidence instead of
 * copying an ever-growing tree. Largest-remainder allocation at every node
 * conserves exact units across both mixed groups and repeated reallocations. */
export async function measureCreditExposure(
  tx: SqlExecutor,
  orgId: string,
  bookId: string,
  exposure: CreditExposure,
): Promise<string> {
  if (exposure.kind === "none") return "0.0000";
  if (exposure.kind === "invoice") {
    const raw = await invoiceDeferredCredit(tx, orgId, bookId, exposure.source);
    return fromUnits(
      apportion(toUnits(raw), exposure.weights.map(toUnits))[exposure.index]!,
    );
  }
  if (exposure.bookId !== bookId)
    throw new Error(
      "deferred-credit evidence belongs to another accounting book",
    );
  const row = (
    await tx.execute<{
      before_state: { creditGroups: Record<string, CreditGroup[]> };
    }>(
      sql`select before_state from financial_changes where org_id=${orgId} and id=${exposure.changeId} and domain='revenue'`,
    )
  ).rows[0];
  const group = row?.before_state.creditGroups[bookId]?.[exposure.groupIndex];
  if (!group)
    throw new Error(
      "the approved deferred-credit allocation evidence is missing",
    );
  const net = sum(
    await Promise.all(
      group.previous.map(async (p) =>
        add(
          await measureCreditExposure(tx, orgId, bookId, p.exposure),
          fromUnits(-toUnits(p.baseline)),
        ),
      ),
    ),
  );
  if (group.weights.every((w) => toUnits(w) === 0n)) return "0.0000";
  return fromUnits(
    apportion(toUnits(net), group.weights.map(toUnits))[exposure.promiseIndex]!,
  );
}
