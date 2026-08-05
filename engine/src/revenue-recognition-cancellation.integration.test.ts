import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument } from "./posting.ts";
import {
  cancelRevenueRecognitionForInvoice,
  runRevenueRecognition,
} from "./revenue-recognition.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "./test-fixtures.ts";

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
  "revenue-recognition cancellation preserves one exact source -> reversal lineage and voids the invoice",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actors = await seedFlowActors(org.orgId);
    const documentId = randomUUID();
    try {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, due_date, currency, fx_rate, status,
           subtotal, tax_total, total, is_final_invoice, custom, extra_dims,
           created_by, updated_by)
        values
          (${documentId}, ${org.orgId}, 'customer_invoice', 'REV-CANCEL-001',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           ${org.date}, 'CAD', 1, 'approved', 1200, 0, 1200, false,
           '{}'::jsonb, '{}'::jsonb, ${actors.adminId}, ${actors.adminId})
      `);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id,
           quantity, unit_price, amount, tax_amount, is_billable,
           quantity_fulfilled, quantity_billed, custom, tax_overridden,
           extra_dims, created_by, updated_by)
        values
          (${randomUUID()}, ${org.orgId}, ${documentId}, 1,
           ${org.items.service}, ${org.accounts.revenue}, 1, 1200, 1200, 0,
           false, 0, 0, '{}'::jsonb, false, '{}'::jsonb,
           ${actors.adminId}, ${actors.adminId})
      `);
      await postDocument(
        documentId,
        {
          control: {
            ar: org.accounts.ar,
            ap: org.accounts.ap,
            bank: org.accounts.bank,
          },
        },
        { audit: { actorId: actors.adminId, source: "test" } },
      );

      const recognized = await runRevenueRecognition(
        org.orgId,
        "2026-07-31",
        actors.adminId,
      );
      assert.equal(recognized.posted, 1);
      assert.equal(recognized.totalAmount, "100.0000");
      const sourceRecognitionId = recognized.entries[0]!.entryId;
      const sourceLines = await db.execute(sql`
        select line_number, account_id, amount::text, currency,
               txn_amount::text, fx_rate::text, subsidiary_id,
               department_id, project_id, location_id, class_id,
               equipment_unit_id, extra_dims
          from journal_lines
         where entry_id = ${sourceRecognitionId}
         order by line_number
      `);

      const request = {
        documentId,
        orgId: org.orgId,
        actorId: actors.adminId,
        reason: "Customer contract terminated before the remaining service term",
        reversalDate: "2026-07-31",
      };
      const concurrent = await Promise.all([
        cancelRevenueRecognitionForInvoice(request),
        cancelRevenueRecognitionForInvoice(request),
      ]);
      assert.deepEqual(
        concurrent.map((result) => result.status),
        ["cancelled", "cancelled"],
      );
      assert.equal(
        new Set(
          concurrent.flatMap((result) => result.recognitionReversalEntryIds),
        ).size,
        1,
      );
      assert.equal(
        new Set(concurrent.map((result) => result.invoiceReversalEntryId)).size,
        1,
      );
      const recognitionReversalId =
        concurrent[0]!.recognitionReversalEntryIds[0]!;

      const lineage = (await db.execute(sql`
        select document.status as document_status,
               document.reversal_entry_id as invoice_reversal_id,
               obligation.status as obligation_status,
               obligation.cancellation_reason,
               schedule.status as schedule_status,
               schedule_line.journal_entry_id,
               schedule_line.reversal_journal_entry_id,
               source.status as source_status,
               reversal.status as reversal_status,
               reversal.reverses_entry_id
          from documents document
          join document_lines document_line
            on document_line.document_id = document.id
          join performance_obligations obligation
            on obligation.document_line_id = document_line.id
          join recognition_schedules schedule
            on schedule.obligation_id = obligation.id
          join recognition_schedule_lines schedule_line
            on schedule_line.schedule_id = schedule.id
           and schedule_line.journal_entry_id is not null
          join journal_entries source
            on source.id = schedule_line.journal_entry_id
          join journal_entries reversal
            on reversal.id = schedule_line.reversal_journal_entry_id
         where document.id = ${documentId}
      `)) as unknown as {
        rows: {
          document_status: string;
          invoice_reversal_id: string;
          obligation_status: string;
          cancellation_reason: string;
          schedule_status: string;
          journal_entry_id: string;
          reversal_journal_entry_id: string;
          source_status: string;
          reversal_status: string;
          reverses_entry_id: string;
        }[];
      };
      assert.equal(lineage.rows.length, 1);
      assert.deepEqual(lineage.rows[0], {
        document_status: "voided",
        invoice_reversal_id: concurrent[0]!.invoiceReversalEntryId,
        obligation_status: "cancelled",
        cancellation_reason: request.reason,
        schedule_status: "cancelled",
        journal_entry_id: sourceRecognitionId,
        reversal_journal_entry_id: recognitionReversalId,
        source_status: "reversed",
        reversal_status: "posted",
        reverses_entry_id: sourceRecognitionId,
      });

      const reversalLines = await db.execute(sql`
        select line_number, account_id, (-amount)::text as amount, currency,
               (-txn_amount)::text as txn_amount, fx_rate::text, subsidiary_id,
               department_id, project_id, location_id, class_id,
               equipment_unit_id, extra_dims
          from journal_lines
         where entry_id = ${recognitionReversalId}
         order by line_number
      `);
      assert.deepEqual(reversalLines.rows, sourceLines.rows);

      const net = (await db.execute(sql`
        select coalesce(sum(line.amount), 0)::text as amount
          from journal_lines line
          join journal_entries entry on entry.id = line.entry_id
         where entry.id in (
           select posted_entry_id from documents where id = ${documentId}
           union all
           select reversal_entry_id from documents where id = ${documentId}
           union all
           select journal_entry_id
             from recognition_schedule_lines
            where journal_entry_id = ${sourceRecognitionId}
           union all
           select reversal_journal_entry_id
             from recognition_schedule_lines
            where journal_entry_id = ${sourceRecognitionId}
         )
      `)) as unknown as { rows: { amount: string }[] };
      assert.equal(net.rows[0]!.amount, "0.0000");

      const rerun = await runRevenueRecognition(
        org.orgId,
        "2026-12-31",
        actors.adminId,
      );
      assert.equal(rerun.posted, 0);
      const retry = await cancelRevenueRecognitionForInvoice(request);
      assert.equal(
        retry.recognitionReversalEntryIds[0],
        recognitionReversalId,
      );
      assert.equal(
        retry.invoiceReversalEntryId,
        concurrent[0]!.invoiceReversalEntryId,
      );

      await assert.rejects(
        db.execute(sql`
          update recognition_schedule_lines
             set planned_amount = planned_amount + 1
           where journal_entry_id = ${sourceRecognitionId}
        `),
        (error) => errorChainMatches(error, /financial history is immutable/),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
