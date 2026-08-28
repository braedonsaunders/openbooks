import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { requestDocumentVoid } from "./document-void.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "./test-fixtures.ts";
import { mirrorSourceDeletion } from "./sync/source-deletions.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedPostedEntryWithDimensions(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actorId: string,
  lines: Array<{
    accountId: string;
    amount: string;
    quantity: string;
    unit: string;
    custom: Record<string, string>;
  }>,
): Promise<string> {
  const entryId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values (
        ${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
        ${`REV-FIELDS-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId},
        'Reversal field preservation test', 'draft', 'manual', ${actorId}, ${actorId}
      )
    `);
    let lineNumber = 0;
    for (const line of lines) {
      lineNumber += 1;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, quantity, unit, custom, is_open_item)
        values (
          ${org.orgId}, ${entryId}, ${lineNumber}, ${line.accountId},
          ${org.subsidiaryId}, ${line.amount}, 'CAD', ${line.amount}, 1,
          ${line.quantity}, ${line.unit}, ${JSON.stringify(line.custom)}::jsonb, false
        )
      `);
    }
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_at = now(), posted_by = ${actorId}
       where id = ${entryId} and org_id = ${org.orgId}
    `);
  });
  return entryId;
}

async function readReversalLineDimensions(
  orgId: string,
  reversalEntryId: string,
) {
  return db.execute<{
    quantity: string | null;
    unit: string | null;
    custom: Record<string, string>;
  }>(sql`
    select quantity::text, unit, custom
      from journal_lines
     where org_id = ${orgId}
       and entry_id = ${reversalEntryId}
       and line_number = 1
  `);
}

test(
  "void reversals preserve quantity unit and custom from source journal lines",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Reversal Dimensions", "admin");
      const documentId = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status,
           subtotal, tax_total, total, created_by)
        values (
          ${documentId}, ${org.orgId}, 'vendor_bill', 'BILL-REV-FIELDS',
          ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
          'CAD', '1', 'draft', '125', '0', '125', ${actorId}
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
      await db.execute(sql`
        update documents
           set status = 'approved', updated_at = now()
         where id = ${documentId} and org_id = ${org.orgId}
      `);
      const sourceEntryId = await seedPostedEntryWithDimensions(org, actorId, [
        {
          accountId: org.accounts.cogs,
          amount: "125.0000",
          quantity: "10.0000",
          unit: "hours",
          custom: { lot: "A" },
        },
        {
          accountId: org.accounts.ap,
          amount: "-125.0000",
          quantity: "0",
          unit: "each",
          custom: {},
        },
      ]);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${sourceEntryId},
               posting_period_id = ${org.periodId},
               status = 'posted'
         where id = ${documentId} and org_id = ${org.orgId}
      `);

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

      const reversal = await readReversalLineDimensions(org.orgId, result.reversalEntryId!);
      assert.deepEqual(reversal.rows[0], {
        quantity: "-10.0000",
        unit: "hours",
        custom: { lot: "A" },
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "source deletion reversals preserve quantity unit and custom from source journal lines",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Source Delete Dimensions", "admin");
      const documentId = randomUUID();
      const sourceRef = `posted-dims-${randomUUID()}`;
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, custom)
        values (
          ${documentId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-REV-FIELDS',
          ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
          '100', '0', '100', ${JSON.stringify({ nsId: sourceRef })}::jsonb
        )`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount, tax_input_amount)
        values (
          ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, '1', '100',
          '100', '0', '0'
        )`);
      await db.execute(sql`
        update documents
           set status = 'approved', updated_at = now()
         where id = ${documentId} and org_id = ${org.orgId}
      `);
      const sourceEntryId = await seedPostedEntryWithDimensions(org, actorId, [
        {
          accountId: org.accounts.ar,
          amount: "100.0000",
          quantity: "4.5000",
          unit: "tonnes",
          custom: { batch: "B-17" },
        },
        {
          accountId: org.accounts.revenue,
          amount: "-100.0000",
          quantity: "0",
          unit: "each",
          custom: {},
        },
      ]);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${sourceEntryId},
               posting_period_id = ${org.periodId},
               status = 'posted'
         where id = ${documentId} and org_id = ${org.orgId}
      `);

      const result = await mirrorSourceDeletion({
        orgId: org.orgId,
        source: "netsuite",
        sourceRef,
      });
      assert.deepEqual(result, { documentId, deleted: true });

      const reversalEntry = await db.execute<{ id: string }>(sql`
        select id
          from journal_entries
         where org_id = ${org.orgId}
           and reverses_entry_id = ${sourceEntryId}
      `);
      const reversal = await readReversalLineDimensions(
        org.orgId,
        reversalEntry.rows[0]!.id,
      );
      assert.deepEqual(reversal.rows[0], {
        quantity: "-4.5000",
        unit: "tonnes",
        custom: { batch: "B-17" },
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
