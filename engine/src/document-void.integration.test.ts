import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { deleteDocument } from "./document-delete.ts";
import { requestDocumentVoid } from "./document-void.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("controlled void preserves the source and posts an exact open-period reversal", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    await db.execute(sql`
      insert into users (id, org_id, email, name, password_hash, role, is_active)
      values (
        ${actorId}, ${org.orgId}, ${`void-${actorId}@scratch.test`},
        'Void Controller', 'x', 'admin', true
      )
    `);
    const documentId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, posting_date, currency, fx_rate, status,
         subtotal, tax_total, total, created_by)
      values (
        ${documentId}, ${org.orgId}, 'vendor_bill', 'BILL-VOID-1',
        ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
        'CAD', '1', 'approved', '125', '0', '125', ${actorId}
      )
    `);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity,
         unit_price, amount, tax_amount, created_by)
      values (
        ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, '1',
        '125', '125', '0', ${actorId}
      )
    `);
    const sourceEntryId = await postDocument(
      documentId,
      {
        control: {
          ar: org.accounts.ar,
          ap: org.accounts.ap,
          bank: org.accounts.bank,
        },
      },
      { audit: { actorId, source: "test" } },
    );
    await assert.rejects(
      deleteDocument(documentId, actorId),
      /cannot be deleted.*controlled void/i,
    );

    const result = await requestDocumentVoid({
      documentId,
      orgId: org.orgId,
      actorId,
      reason: "Duplicate vendor invoice entered in error",
      reversalDate: org.date,
      source: "api",
    });
    assert.equal(result.status, "voided");
    assert.ok(result.reversalEntryId);

    const document = (await db.execute(sql`
      select status, posted_entry_id, reversal_entry_id, voided_by,
             void_reason, void_requested_at
        from documents
       where id = ${documentId}
    `)) as unknown as {
      rows: {
        status: string;
        posted_entry_id: string;
        reversal_entry_id: string;
        voided_by: string;
        void_reason: string;
        void_requested_at: Date | null;
      }[];
    };
    assert.deepEqual(document.rows[0], {
      status: "voided",
      posted_entry_id: sourceEntryId,
      reversal_entry_id: result.reversalEntryId,
      voided_by: actorId,
      void_reason: "Duplicate vendor invoice entered in error",
      void_requested_at: null,
    });

    const accounting = (await db.execute(sql`
      select
        source.status as source_status,
        reversal.status as reversal_status,
        reversal.reverses_entry_id,
        coalesce((
          select sum(amount) from journal_lines where entry_id = source.id
        ), 0) as source_balance,
        coalesce((
          select sum(amount) from journal_lines where entry_id = reversal.id
        ), 0) as reversal_balance,
        not exists (
          select 1
            from journal_lines source_line
            left join journal_lines reversal_line
              on reversal_line.entry_id = reversal.id
             and reversal_line.line_number = source_line.line_number
           where source_line.entry_id = source.id
             and (
               reversal_line.id is null
               or source_line.amount <> -reversal_line.amount
             )
        )
        and (
          select count(*) from journal_lines where entry_id = source.id
        ) = (
          select count(*) from journal_lines where entry_id = reversal.id
        ) as exact_mirror
      from journal_entries source
      join journal_entries reversal on reversal.id = ${result.reversalEntryId}
     where source.id = ${sourceEntryId}
    `)) as unknown as {
      rows: {
        source_status: string;
        reversal_status: string;
        reverses_entry_id: string;
        source_balance: string;
        reversal_balance: string;
        exact_mirror: boolean;
      }[];
    };
    assert.deepEqual(accounting.rows[0], {
      source_status: "reversed",
      reversal_status: "posted",
      reverses_entry_id: sourceEntryId,
      source_balance: "0.0000",
      reversal_balance: "0.0000",
      exact_mirror: true,
    });

    const audit = (await db.execute(sql`
      select changes->>'mode' as mode,
             changes->>'reason' as reason
        from audit_log
       where org_id = ${org.orgId}
         and table_name = 'documents'
         and row_id = ${documentId}
         and action = 'void'
       order by at desc
       limit 1
    `)) as unknown as { rows: { mode: string; reason: string }[] };
    assert.deepEqual(audit.rows[0], {
      mode: "transaction_void",
      reason: "Duplicate vendor invoice entered in error",
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
