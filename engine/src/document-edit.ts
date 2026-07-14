import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { toUnits } from "./money.ts";

/**
 * Reopening a posted document for editing.
 *
 * The kernel forbids mutating a posted journal entry — corrections are
 * reversals, never edits (see AGENTS.md + kernel-constraints.sql je_guard).
 * So "edit a posted document" is really: reverse its GL posting and return
 * the document to an editable draft. Re-submitting/posting then produces a
 * fresh entry, exactly like NetSuite's edit-a-posted-transaction behaviour.
 *
 * `reopenDocument` does this in ONE transaction:
 *   1. Insert a reversing journal entry — mirror-image lines of the posted
 *      entry (same accounts/dims/party/period, negated amounts), origin
 *      'document', reverses_entry_id = the posted entry — and post it.
 *   2. Flip the original entry to 'reversed'.
 *   3. Return the document to 'draft' and clear posted_entry_id.
 *
 * The original + reversal net to zero, so the GL balance is unchanged until
 * the document is re-posted. Guards: only posted/approved documents reopen,
 * and a document whose posted entry lives in a GL-closed period is refused
 * (the reversal would have to post into that closed period, which the kernel
 * blocks). FOR UPDATE on the document row makes it concurrency-safe and
 * idempotent under races.
 */

export class ReopenError extends Error {}

/** Negate a signed numeric string without float math ('0' stays '0'). */
function negStr(a: string): string {
  return toUnits(a) === 0n ? "0" : a.startsWith("-") ? a.slice(1) : `-${a}`;
}

export interface ReopenResult {
  documentId: string;
  /** The reversing entry created (null when the doc was 'approved', not posted). */
  reversalEntryId: string | null;
}

export async function reopenDocument(documentId: string, userId: string): Promise<ReopenResult> {
  return db.transaction(async (tx) => {
    // Lock the document row so concurrent reopen/post attempts serialize.
    const locked = (await tx.execute(sql`
      select id, org_id, document_number, status, posted_entry_id
        from documents
       where id = ${documentId}
       for update
    `)) as unknown as {
      rows: { id: string; org_id: string; document_number: string; status: string; posted_entry_id: string | null }[];
    };
    const doc = locked.rows[0];
    if (!doc) throw new ReopenError(`document ${documentId} not found`);

    // Idempotency: already editable.
    if (doc.status === "draft") return { documentId, reversalEntryId: null };

    if (doc.status !== "posted" && doc.status !== "approved") {
      throw new ReopenError(`document ${doc.document_number} is ${doc.status} and cannot be reopened for editing`);
    }

    // An approved-but-unposted document has no GL impact yet — just reopen it.
    if (doc.status === "approved" || !doc.posted_entry_id) {
      await tx
        .update(schema.documents)
        .set({ status: "draft", postedEntryId: null })
        .where(eq(schema.documents.id, documentId));
      return { documentId, reversalEntryId: null };
    }

    // -- posted: reverse the GL posting -------------------------------------
    const entryId = doc.posted_entry_id;
    const [entry] = await tx
      .select()
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.id, entryId));
    if (!entry) throw new ReopenError(`posted entry ${entryId} for ${doc.document_number} not found`);
    if (entry.status !== "posted") {
      throw new ReopenError(`posted entry for ${doc.document_number} is ${entry.status}, not posted`);
    }

    // Refuse if the entry's period is closed for GL — the reversal posts into
    // that same period, which the kernel (je_guard) would reject anyway.
    const closed = (await tx.execute(sql`
      select 1 from accounting_periods
       where id = ${entry.periodId} and gl_closed_at is not null
    `)) as unknown as { rows: unknown[] };
    if (closed.rows.length > 0) {
      throw new ReopenError(
        `${doc.document_number} posted into a period that is closed for GL — reopen the period or post a correcting entry instead`,
      );
    }

    // Refuse if the posting has live payment applications against it — editing
    // would strand those applications and misstate the party's open balance.
    // The user must unapply the payment(s) first.
    const applied = (await tx.execute(sql`
      select 1
        from applications a
        join journal_lines jl on jl.id = a.to_line_id or jl.id = a.from_line_id
       where jl.entry_id = ${entryId} and a.unapplied_at is null
       limit 1
    `)) as unknown as { rows: unknown[] };
    if (applied.rows.length > 0) {
      throw new ReopenError(
        `${doc.document_number} has payments applied to it — unapply them before editing`,
      );
    }

    const lines = await tx
      .select()
      .from(schema.journalLines)
      .where(eq(schema.journalLines.entryId, entryId));

    // Mirror-image reversal entry: same book/period/dims, negated amounts.
    const [rev] = await tx
      .insert(schema.journalEntries)
      .values({
        orgId: doc.org_id,
        bookId: entry.bookId,
        entryNumber: `${entry.entryNumber}-R`,
        postingDate: entry.postingDate,
        periodId: entry.periodId,
        memo: `Edit reversal of ${doc.document_number}`,
        status: "draft",
        sourceDocumentId: entry.sourceDocumentId,
        origin: "document",
        reversesEntryId: entryId,
        postedBy: userId,
      })
      .returning({ id: schema.journalEntries.id });

    await tx.insert(schema.journalLines).values(
      lines.map((l) => ({
        orgId: doc.org_id,
        entryId: rev.id,
        lineNumber: l.lineNumber,
        accountId: l.accountId,
        amount: negStr(l.amount),
        currency: l.currency,
        txnAmount: negStr(l.txnAmount),
        fxRate: l.fxRate,
        partyId: l.partyId,
        departmentId: l.departmentId,
        projectId: l.projectId,
        locationId: l.locationId,
        classId: l.classId,
        paymentCardId: l.paymentCardId,
        taxCodeId: l.taxCodeId,
        memo: l.memo,
        dueDate: null,
        isOpenItem: false,
      })),
    );

    // Post the reversal, then flip the original to reversed. je_guard rejects
    // posting into a GL-closed period (already pre-checked above for a clear
    // error) and allows posted → reversed.
    await tx
      .update(schema.journalEntries)
      .set({ status: "posted", postedAt: new Date() })
      .where(eq(schema.journalEntries.id, rev.id));

    await tx
      .update(schema.journalEntries)
      .set({ status: "reversed" })
      .where(eq(schema.journalEntries.id, entryId));

    // Return the document to an editable draft; its existing PATCH autosave
    // route now applies, and re-posting mints a brand-new entry.
    await tx
      .update(schema.documents)
      .set({ status: "draft", postedEntryId: null })
      .where(eq(schema.documents.id, documentId));

    return { documentId, reversalEntryId: rev.id };
  });
}
