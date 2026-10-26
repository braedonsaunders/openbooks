/**
 * Accounting-book decisions of the document posting kernel: which book a
 * document posts to, the account mappings a secondary book applies to the
 * allocation contributions it receives, and replication of the primary
 * posting into full books in the posting transaction.
 */
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { applyBookAccountMaps, BookAccountMapError } from "../journal/book-account-maps.ts";
import { replicateEntryToBooks } from "../journal/book-replication.ts";
import { BookTranslationError } from "../journal/book-translation.ts";
import { postEntry } from "../journal/post-entry.ts";
import { effectivePostingDate, PostingError, type Doc } from "../journal/posting-contracts.ts";

export interface DocumentPostingBook {
  id: string;
  code: string;
  isPrimary: boolean;
  is_active: boolean;
  posts_gl: boolean;
}

/**
 * The primary book, or a book-specific journal's target book. The target
 * must be an active posting book of the organization, and a target other
 * than the primary book needs Multi-book accounting switched on.
 */
export async function resolveDocumentPostingBook(
  tx: SqlExecutor,
  doc: Doc,
  primary: { id: string; is_active: boolean; posts_gl: boolean },
  actorId: string | null,
): Promise<DocumentPostingBook> {
  const targetId = doc.kind === "journal" ? (doc.accountingBookId ?? null) : null;
  const primaryCode = async (): Promise<string> =>
    (
      await tx.execute<{ code: string }>(
        sql`select code from accounting_books where org_id = ${doc.orgId} and id = ${primary.id}`,
        "objects",
      )
    )[0]?.code ?? "";
  if (!targetId) return { ...primary, code: await primaryCode(), isPrimary: true };
  // A book-specific journal adjusts one book only; posting one is its own duty.
  if (!actorId || !(await actorHasPermission(tx, doc.orgId, actorId, "gl.post_book_specific"))) {
    throw new PostingError(
      `journal ${doc.documentNumber} is book-specific; posting it requires the "Post book-specific journals" permission — ask an administrator to grant it, or clear the journal's book to post it to every book`,
    );
  }
  if (targetId === primary.id) return { ...primary, code: await primaryCode(), isPrimary: true };
  const target = (
    await tx.execute<{
      id: string;
      code: string;
      is_active: boolean;
      posts_gl: boolean;
      is_primary: boolean;
    }>(
      sql`
    select id, code, is_active, posts_gl, is_primary from accounting_books
     where org_id = ${doc.orgId} and id = ${targetId}
     for share`,
      "objects",
    )
  )[0];
  if (!target || !target.is_active || !target.posts_gl) {
    throw new PostingError(
      `journal ${doc.documentNumber} targets an accounting book that is not an active posting book — choose an active book or the primary book on the journal`,
    );
  }
  if (!(await lockAndCheckOrgFeature(tx, doc.orgId, "multiBookAccounting"))) {
    throw new PostingError(
      `journal ${doc.documentNumber} targets book ${target.code}, but Multi-book accounting is turned off; turn it on in Company Settings → Features or post the journal to the primary book`,
    );
  }
  return {
    id: target.id,
    code: target.code,
    isPrimary: target.is_primary,
    is_active: target.is_active,
    posts_gl: target.posts_gl,
  };
}

/**
 * Carry a secondary book's allocation contributions through that book's
 * account mappings, preserving line order (lineage indexes follow it).
 */
export async function mapBookContributionAccounts<
  T extends { accountId: string; subsidiaryId?: string | null },
>(
  tx: SqlExecutor,
  doc: Doc,
  book: { id: string; code: string },
  postingDate: string,
  lines: T[],
  fallbackSubsidiaryId: string,
): Promise<T[]> {
  try {
    const mapped = await applyBookAccountMaps(tx, {
      orgId: doc.orgId,
      bookId: book.id,
      bookLabel: book.code,
      postingDate,
      entryLabel: `document ${doc.documentNumber}`,
      lines: lines.map((line) => ({
        ...line,
        subsidiaryId: line.subsidiaryId ?? doc.subsidiaryId ?? fallbackSubsidiaryId,
      })),
    });
    return mapped.lines.map((line, index) => ({ ...lines[index]!, accountId: line.accountId }));
  } catch (error) {
    if (error instanceof BookAccountMapError) throw new PostingError(error.message);
    throw error;
  }
}

/**
 * Replicate a document's primary entry into every full book. A
 * book-specific journal (even one targeting the primary book) stays in its
 * book; the replicable-entry rule enforces that from the document itself.
 */
export async function replicateDocumentEntry(
  tx: SqlExecutor,
  doc: Doc,
  book: DocumentPostingBook,
  entryId: string,
  actorId: string | null,
): Promise<void> {
  if (!book.isPrimary) return;
  try {
    await replicateEntryToBooks(tx, postEntry, {
      orgId: doc.orgId,
      sourceEntryId: entryId,
      actorId,
      requestId: null,
    });
  } catch (error) {
    if (error instanceof PostingError) throw error;
    if (error instanceof BookTranslationError || error instanceof BookAccountMapError) {
      throw new PostingError(
        `document ${doc.documentNumber} (${effectivePostingDate(doc)}): ${error.message}`,
      );
    }
    throw error;
  }
}
