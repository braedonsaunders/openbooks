import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { type PostingDeps } from "../ledger/posting.ts";
import { PaymentError } from "./payment-errors.ts";
// ---------------------------------------------------------------------------
// Control accounts
// ---------------------------------------------------------------------------

export async function paymentControlDeps(orgId: string): Promise<PostingDeps> {
  const r = (await db.execute<{ c: Record<string, string> | null }>(
    sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  ));
  const c = r.rows[0]?.c ?? {};
  if (!c.ap || !c.ar || !c.bank) {
    throw new PaymentError(
      "org control accounts are not configured (orgs.settings.controlAccounts.ap/ar/bank)",
    );
  }
  return {
    control: {
      ap: c.ap,
      ar: c.ar,
      bank: c.bank,
      taxCollected: c.taxCollected,
      taxPaid: c.taxPaid,
      employeePayable: c.employeePayable,
      fxRealizedGainLoss: c.fxRealizedGainLoss,
    },
  };
}

/** Keep selectable settlements on the same authoritative book used by posting.
 * The setup writer takes the exclusive advisory lock; writes retain this shared
 * lock and the selected book row through commit. */
export async function paymentBookId(orgId: string): Promise<string> {
  await db.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`accounting-books:${orgId}`}, 0))`);
  const books = (await db.execute<{ id: string; is_active: boolean; posts_gl: boolean }>(sql`
    select id, is_active, posts_gl from accounting_books
     where org_id = ${orgId} and is_primary order by id for share
  `)).rows;
  if (books.length !== 1 || !books[0]!.is_active || !books[0]!.posts_gl) {
    throw new PaymentError("payments require exactly one active primary posting book");
  }
  return books[0]!.id;
}
