import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  createDocumentCorrectionDraft,
  DocumentCorrectionError,
} from "./document-correction.ts";
import { requestDocumentVoid } from "./document-void.ts";
import { submitAndReleaseIfUngated } from "./flows/submit.ts";
import { postDocument, type PostingDeps } from "./posting.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (pattern.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

test(
  "posted correction is one idempotent retained source -> reversal -> replacement chain",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = randomUUID();
    const sourceDocumentId = randomUUID();
    const sourceLineId = randomUUID();
    const reason = "Controller corrected the supplier invoice amount";
    const deps: PostingDeps = {
      control: {
        ar: org.accounts.ar,
        ap: org.accounts.ap,
        bank: org.accounts.bank,
      },
    };
    try {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status, subtotal,
           tax_total, total, is_final_invoice, custom, extra_dims)
        values
          (${sourceDocumentId}, ${org.orgId}, 'vendor_bill', 'BILL-CORR-001',
           ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 1, 'draft', 100, 0, 100, false, '{}'::jsonb, '{}'::jsonb)
      `);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, quantity,
           unit_price, amount, tax_amount, is_billable, quantity_fulfilled,
           quantity_billed, custom, tax_overridden, extra_dims)
        values
          (${sourceLineId}, ${org.orgId}, ${sourceDocumentId}, 1,
           ${org.accounts.cogs}, 1, 100, 100, 0, false, 0, 0, '{}'::jsonb,
           false, '{}'::jsonb)
      `);
      await db.execute(sql`
        update documents
           set status = 'approved', updated_at = now()
         where id = ${sourceDocumentId} and org_id = ${org.orgId}
      `);
      const sourceEntryId = await postDocument(sourceDocumentId, deps, {
        audit: { actorId, source: "test" },
      });
      const sourceBefore = await db.execute(sql`
        select id, line_number, account_id, amount::text, currency,
               txn_amount::text, fx_rate::text, party_id, is_open_item
          from journal_lines
         where entry_id = ${sourceEntryId}
         order by line_number
      `);

      const attempts = await Promise.all([
        createDocumentCorrectionDraft({
          orgId: org.orgId,
          sourceDocumentId,
          replacementDocumentNumber: "BILL-CORR-001-1",
          actorId,
          reason,
        }),
        createDocumentCorrectionDraft({
          orgId: org.orgId,
          sourceDocumentId,
          replacementDocumentNumber: "BILL-CORR-001-1",
          actorId,
          reason,
        }),
      ]);
      assert.equal(
        new Set(attempts.map((attempt) => attempt.replacementDocumentId)).size,
        1,
      );
      assert.deepEqual(
        attempts.map((attempt) => attempt.created).sort(),
        [false, true],
      );
      const replacementDocumentId = attempts[0]!.replacementDocumentId;

      const retained = (await db.execute<{
          status: string;
          posted_entry_id: string | null;
          amount: string;
          quantity_fulfilled: string;
          quantity_billed: string;
          reason: string;
          requested_by: string;
          requested: boolean;
        }>(sql`
        select replacement.status, replacement.posted_entry_id,
               line.amount::text, line.quantity_fulfilled::text,
               line.quantity_billed::text,
               link.reason, link.requested_by, link.requested_at is not null as requested
          from documents replacement
          join document_lines line on line.document_id = replacement.id
          join document_links link on link.from_document_id = replacement.id
         where replacement.id = ${replacementDocumentId}
           and link.to_document_id = ${sourceDocumentId}
           and link.link_type = 'reverses'
      `));
      assert.deepEqual(retained.rows, [
        {
          status: "draft",
          posted_entry_id: null,
          amount: "100.0000",
          quantity_fulfilled: "0.00000000",
          quantity_billed: "0.00000000",
          reason,
          requested_by: actorId,
          requested: true,
        },
      ]);

      await assert.rejects(
        submitAndReleaseIfUngated(
          "vendor_bill",
          replacementDocumentId,
          actorId,
        ),
        /cannot be submitted until .* void is approved and completed/,
      );
      await assert.rejects(
        createDocumentCorrectionDraft({
          orgId: org.orgId,
          sourceDocumentId,
          replacementDocumentNumber: "COMPETING-CORRECTION",
          actorId,
          reason,
        }),
        (error: unknown) =>
          error instanceof DocumentCorrectionError &&
          /already has correction/.test(error.message),
      );

      await db.execute(sql`
        update document_lines
           set unit_price = 120, amount = 120, updated_at = now()
         where document_id = ${replacementDocumentId}
      `);
      await db.execute(sql`
        update documents
           set subtotal = 120, total = 120, updated_at = now()
         where id = ${replacementDocumentId}
      `);

      const voided = await requestDocumentVoid({
        documentId: sourceDocumentId,
        orgId: org.orgId,
        actorId,
        reason,
        reversalDate: org.date,
        source: "api",
      });
      assert.equal(voided.status, "voided");
      assert.ok(voided.reversalEntryId);

      const release = await submitAndReleaseIfUngated(
        "vendor_bill",
        replacementDocumentId,
        actorId,
      );
      assert.equal(release.autoApproved, true);
      const replacementEntryId = await postDocument(
        replacementDocumentId,
        deps,
        { audit: { actorId, source: "document_correction" } },
      );

      const chain = (await db.execute<{
          source_entry_status: string;
          source_document_status: string;
          reversal_entry_id: string;
          reverses_entry_id: string;
          replacement_status: string;
          replacement_entry_id: string;
          correction_edges: number;
          correction_audits: number;
        }>(sql`
        select
          source.status as source_entry_status,
          original.status as source_document_status,
          original.reversal_entry_id,
          reversal.reverses_entry_id,
          replacement.status as replacement_status,
          replacement.posted_entry_id as replacement_entry_id,
          (
            select count(*)::int
              from document_links link
             where link.org_id = ${org.orgId}
               and link.to_document_id = ${sourceDocumentId}
               and link.link_type = 'reverses'
          ) as correction_edges,
          (
            select count(*)::int
              from audit_log audit
             where audit.org_id = ${org.orgId}
               and audit.row_id = ${replacementDocumentId}
               and audit.changes->>'mode' = 'append_only_document_correction'
          ) as correction_audits
          from documents original
          join journal_entries source on source.id = original.posted_entry_id
          join journal_entries reversal on reversal.id = original.reversal_entry_id
          join documents replacement on replacement.id = ${replacementDocumentId}
         where original.id = ${sourceDocumentId}
      `));
      assert.deepEqual(chain.rows, [
        {
          source_entry_status: "reversed",
          source_document_status: "voided",
          reversal_entry_id: voided.reversalEntryId,
          reverses_entry_id: sourceEntryId,
          replacement_status: "posted",
          replacement_entry_id: replacementEntryId,
          correction_edges: 1,
          correction_audits: 1,
        },
      ]);

      const sourceAfter = await db.execute(sql`
        select id, line_number, account_id, amount::text, currency,
               txn_amount::text, fx_rate::text, party_id, is_open_item
          from journal_lines
         where entry_id = ${sourceEntryId}
         order by line_number
      `);
      assert.deepEqual(
        sourceAfter.rows,
        sourceBefore.rows,
        "the original posted entry remains byte-for-byte intact",
      );

      const net = (await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, sum(amount)::text as amount
          from journal_lines
         where entry_id in (
           ${sourceEntryId}, ${voided.reversalEntryId}, ${replacementEntryId}
         )
         group by account_id
         order by account_id
      `));
      assert.deepEqual(net.rows, [
        { account_id: org.accounts.ap, amount: "-120.0000" },
        { account_id: org.accounts.cogs, amount: "120.0000" },
      ].sort((a, b) => a.account_id.localeCompare(b.account_id)));

      const retry = await createDocumentCorrectionDraft({
        orgId: org.orgId,
        sourceDocumentId,
        replacementDocumentNumber: "BILL-CORR-001-1",
        actorId,
        reason,
      });
      assert.equal(retry.created, false);
      assert.equal(retry.replacementDocumentId, replacementDocumentId);

      await assert.rejects(
        db.execute(sql`
          update document_links
             set reason = 'Tampered correction evidence'
           where from_document_id = ${replacementDocumentId}
             and link_type = 'reverses'
        `),
        (error: unknown) =>
          errorChainMatches(
            error,
            /document correction lineage is immutable/,
          ),
      );
      await assert.rejects(
        db.execute(sql`
          delete from document_links
           where from_document_id = ${replacementDocumentId}
             and link_type = 'reverses'
        `),
        (error: unknown) =>
          errorChainMatches(
            error,
            /document correction lineage is immutable/,
          ),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
