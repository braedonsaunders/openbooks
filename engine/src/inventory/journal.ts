import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { isZero, sum } from "../money/money.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { assertPeriodModulesOpen, CloseError } from "../close/close.ts";
import { InventoryError, type Runner } from "./contracts.ts";
// ---------------------------------------------------------------------------
// Shared kernel poster
// ---------------------------------------------------------------------------

export interface JournalLineInput {
  accountId: string;
  amount: string;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  memo?: string | null;
}

/**
 * Business (GL-dimension) location behind a stock location. Direct inventory
 * movements resolve this exactly like transferInventoryTx does, so every
 * inventory-originated leg carries the location dimension and location-sliced
 * statements tie to the subledger. An explicit caller location always wins; a
 * stock location without a mapped business location stays unstamped.
 */
export async function stockLocationDim(
  runner: SqlExecutor,
  orgId: string,
  stockLocationId: string,
  explicit: string | null | undefined,
): Promise<string | null> {
  if (explicit) return explicit;
  const r = await runner.execute<{ location_id: string | null }>(sql`
    select location_id from stock_locations where org_id = ${orgId} and id = ${stockLocationId}`);
  return r.rows[0]?.location_id ?? null;
}

export async function assertInventoryAccountsPostable(
  tx: Runner,
  orgId: string,
  accountIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(accountIds)];
  if (!ids.length) return;
  const accounts = (await tx.execute<{
    id: string;
    is_active: boolean;
    is_summary: boolean;
  }>(sql`
    select id, is_active, is_summary
      from accounts
     where org_id = ${orgId}
       and id = any(${uuidArray(ids)}::uuid[])
     for share
  `)).rows;
  const byId = new Map(accounts.map((account) => [account.id, account]));
  for (const id of ids) {
    const account = byId.get(id);
    if (!account || !account.is_active || account.is_summary) {
      throw new InventoryError("inventory journal requires active, non-summary accounts");
    }
  }
}

/** Post one balanced inventory journal (draft→lines→posted, origin 'inventory').
 *  Exported for the NRV remeasurement module, which shares this GL path. */
export async function postInventoryEntry(
  tx: Runner,
  p: {
    orgId: string;
    bookId: string;
    subsidiaryId: string;
    /** Authenticated actor retained on both draft and posted journal audit columns. */
    actorId?: string | null;
    currency: string;
    periodId: string;
    date: string;
    entryNumber: string;
    memo: string;
    lines: JournalLineInput[];
    /** Immutable structured source evidence for this inventory operation. */
    custom?: Record<string, unknown>;
  },
): Promise<string> {
  const bal = sum(p.lines.map((l) => l.amount));
  if (!isZero(bal))
    throw new InventoryError(`inventory entry does not balance (sum=${bal})`);
  // Application-level companion to the je_guard Postgres gate (which refuses
  // the draft→posted flip in a GL-closed period): fail fast with a named
  // InventoryError instead of dying at the flip with a raw driver error.
  // Inventory carries no close module of its own; GL is always implied.
  try {
    await assertPeriodModulesOpen(tx, {
      orgId: p.orgId,
      periodId: p.periodId,
      bookId: p.bookId,
      subsidiaryIds: [p.subsidiaryId],
      modules: [],
    });
  } catch (error) {
    if (error instanceof CloseError) throw new InventoryError(error.message);
    throw error;
  }
  await assertInventoryAccountsPostable(tx, p.orgId, p.lines.map((line) => line.accountId));
  const book = (await tx.execute<{ id: string }>(sql`select id from accounting_books
    where org_id=${p.orgId} and id=${p.bookId} and is_active and posts_gl for share`)).rows[0];
  if (!book) throw new InventoryError("inventory journal requires an active posting book");
  const entryRes = (await tx.execute<{ id: string }>(sql`
    insert into journal_entries
      (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom, created_by, updated_by, posted_by)
    values (${p.orgId}, ${p.bookId}, ${p.subsidiaryId}, ${p.entryNumber}, ${p.date}, ${p.periodId}, ${p.memo},
            'draft', 'inventory', ${JSON.stringify(p.custom ?? {})}::jsonb, ${p.actorId ?? null}, ${p.actorId ?? null}, null)
    returning id`));
  const eid = entryRes.rows[0]!.id;
  for (let i = 0; i < p.lines.length; i++) {
    const l = p.lines[i]!;
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
         department_id, project_id, location_id, memo)
      values (${p.orgId}, ${eid}, ${i + 1}, ${l.accountId}, ${p.subsidiaryId}, ${l.amount}, ${p.currency}, ${l.amount}, 1,
              ${l.departmentId ?? null}, ${l.projectId ?? null}, ${l.locationId ?? null}, ${l.memo ?? p.memo})`);
  }
  await tx.execute(
    sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${p.actorId ?? null}, updated_by = ${p.actorId ?? null} where id = ${eid} and org_id = ${p.orgId}`,
  );
  return eid;
}
