import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/** A journal_entries header as both journal writers insert it: always as a draft. */
export interface DraftEntryHeader {
  /** Explicit entry id; omitted lets the database default apply. */
  id?: string;
  orgId: string;
  bookId: string;
  subsidiaryId: string;
  entryNumber: string;
  postingDate: string;
  periodId: string;
  memo?: string | null;
  origin: string;
  reversesEntryId?: string | null;
  sourceDocumentId?: string | null;
  custom: Record<string, unknown> | null;
  /** Recorded as created_by and updated_by. */
  actorId: string | null;
}

function draftInsert(header: DraftEntryHeader, conflict: SQL): SQL {
  const values = sql`${header.orgId}, ${header.bookId}, ${header.subsidiaryId}, ${header.entryNumber},
    ${header.postingDate}, ${header.periodId}, ${header.memo ?? null}, 'draft',
    ${header.origin}, ${header.reversesEntryId ?? null}, ${header.sourceDocumentId ?? null},
    ${header.custom === null ? "{}" : JSON.stringify(header.custom)}::jsonb,
    ${header.actorId}, ${header.actorId}`;
  return header.id
    ? sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status,
         origin, reverses_entry_id, source_document_id, custom, created_by, updated_by)
      values (${header.id}, ${values})
      ${conflict} returning id`
    : sql`insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status,
         origin, reverses_entry_id, source_document_id, custom, created_by, updated_by)
      values (${values})
      ${conflict} returning id`;
}

/** Inserts the header as a draft and returns its id; no returned row throws `refusal`. */
export async function insertDraftEntry(
  executor: SqlExecutor,
  header: DraftEntryHeader,
  refusal: () => Error,
): Promise<string> {
  const inserted = (
    await executor.execute<{ id: string }>(draftInsert(header, sql``), "objects")
  )[0];
  if (!inserted) throw refusal();
  return inserted.id;
}

/** Inserts a header whose custom carries an idempotencyKey; null means another posting holds it. */
export async function insertKeyedDraftEntry(
  executor: SqlExecutor,
  header: DraftEntryHeader,
): Promise<string | null> {
  // DO NOTHING is the dedupe, not a dropped write: the caller reads the key's holder back and
  // compares its request, and unlike a caught 23505 it never aborts a joined transaction.
  const conflict = sql`on conflict (org_id, (custom->>'idempotencyKey')) where custom ? 'idempotencyKey' do nothing`;
  const inserted = (
    await executor.execute<{ id: string }>(draftInsert(header, conflict), "objects")
  )[0];
  return inserted?.id ?? null;
}

/**
 * Flips the draft just inserted to posted; the storage guard stamps posted_at and rechecks the
 * period. Matching no draft row (a concurrent flip or a vanished entry) throws `refusal`.
 */
export async function flipEntryToPosted(
  executor: SqlExecutor,
  entry: { orgId: string; entryId: string; actorId: string | null },
  refusal: () => Error,
): Promise<void> {
  const flipped = await executor.execute<{ id: string }>(
    sql`
      update journal_entries
         set status = 'posted', posted_by = ${entry.actorId}, updated_by = ${entry.actorId}
       where org_id = ${entry.orgId} and id = ${entry.entryId} and status = 'draft'
       returning id`,
    "objects",
  );
  if (flipped.length !== 1) throw refusal();
}
