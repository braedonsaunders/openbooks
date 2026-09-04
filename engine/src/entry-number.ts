/**
 * Journal entry number allocation.
 *
 * Entry numbers are unique per organization across every document kind
 * (journal_entries_org_number). Two independent pressures collide with that:
 *
 *   - Source systems number per TRANSACTION TYPE, so a vendor bill and an
 *     expense report are both legitimately "1000". An importer cannot ask a
 *     human to renumber the source, so the ledger qualifies the loser by kind.
 *
 *   - Derived entries (a source-correction reversal and its replacement, a
 *     void, a source deletion) mint their name by suffixing the entry they
 *     derive from. That name is only unique if the lineage is walked once, and
 *     a re-migration walks it again, so each derived name steps to the next
 *     free generation.
 *
 * Both live here rather than in posting.ts so the sync and void paths can share
 * them without importing the posting kernel and forming a cycle.
 */
import { sql } from "drizzle-orm";
import type { db } from "./db.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class EntryNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntryNumberError";
  }
}

/**
 * The first unused entry number at or after `preferred`.
 *
 * Derived entries — a source-correction reversal, its replacement, a void, a
 * source deletion — mint their number by suffixing the entry or document they
 * derive from. Each of those suffixes is only unique if that lineage has been
 * walked exactly once, and a re-migration walks it again: the second pass
 * recomputes the SAME name and dies on journal_entries_org_number, losing the
 * write. Rather than teach each site its own generation counter (one already
 * has one, and it can still be defeated), every derived name resolves through
 * here and steps to the next free generation, in the same -N style the
 * source-correction replacement already used.
 *
 * Unlike allocateEntryNumber this never reuses a number the document already
 * holds: a derived entry is always an ADDITIONAL entry for that document.
 *
 * The caller holds `for update` on the org row, so this read-then-insert is
 * atomic against another posting in the same organization.
 */
export async function nextFreeEntryNumber(
  tx: Tx,
  orgId: string,
  preferred: string,
): Promise<string> {
  for (let generation = 1; generation <= 200; generation += 1) {
    const candidate = generation === 1 ? preferred : `${preferred}-${generation}`;
    const taken = await tx.execute(sql`
      select 1 from journal_entries
       where org_id = ${orgId} and entry_number = ${candidate}
       limit 1`);
    if (taken.rows.length === 0) return candidate;
  }
  throw new EntryNumberError(
    `could not allocate a journal entry number derived from "${preferred}"`,
  );
}

/**
 * Resolve the entry number for a document's posting, qualifying it only when
 * the natural number is already held by a DIFFERENT document.
 *
 * Entry numbers are unique per organization across every document kind, but
 * source systems number per transaction type — a vendor bill and an expense
 * report are both legitimately "1000". The importer cannot renumber the
 * source, so the ledger resolves the clash itself rather than refusing the
 * document.
 *
 * Deterministic given the ledger's state, and stable once assigned: a document
 * that already holds a number keeps it, so re-posting and repair paths do not
 * renumber. Document numbers are unique within a kind, so the kind-qualified
 * form cannot itself collide; the counter is a belt-and-braces terminator, not
 * an expected path.
 *
 * The caller holds `for update` on the org row, which serializes posting within
 * an organization and makes this read-then-insert atomic.
 */
export async function allocateEntryNumber(
  tx: Tx,
  orgId: string,
  documentId: string,
  preferred: string,
  kind: string,
): Promise<string> {
  const holder = async (candidate: string): Promise<string | null | undefined> => {
    const found = await tx.execute<{ source_document_id: string | null }>(sql`
      select source_document_id from journal_entries
       where org_id = ${orgId} and entry_number = ${candidate}
       limit 1`);
    return found.rows.length === 0 ? undefined : found.rows[0]!.source_document_id;
  };

  const held = await holder(preferred);
  // Free, or already this document's own number.
  if (held === undefined || held === documentId) return preferred;

  // Qualify by kind, matching the -SOURCE-CORR / -SOURCE-REV suffix style.
  const qualified = `${preferred}-${kind.toUpperCase()}`;
  const qualifiedHeld = await holder(qualified);
  if (qualifiedHeld === undefined || qualifiedHeld === documentId) return qualified;

  for (let generation = 2; generation <= 50; generation += 1) {
    const candidate = `${qualified}-${generation}`;
    const candidateHeld = await holder(candidate);
    if (candidateHeld === undefined || candidateHeld === documentId) return candidate;
  }
  throw new EntryNumberError(
    `could not allocate a journal entry number for document number "${preferred}"`,
  );
}

