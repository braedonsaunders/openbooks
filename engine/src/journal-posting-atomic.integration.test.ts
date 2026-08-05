import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext, withOrgTransaction } from "./db.ts";
import { submitAndReleaseIfUngated } from "./flows/submit.ts";
import { postDocument } from "./posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "a failed draft journal post rolls its approval release back atomically",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Journal poster", "admin"),
      );
      const documentId = randomUUID();
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, status, document_number, subsidiary_id,
             document_date, currency, subtotal, tax_total, total, created_by)
          values (
            ${documentId}, ${org.orgId}, 'journal', 'draft', 'JE-ATOMIC-1',
            ${org.subsidiaryId}, ${org.date}, 'CAD', '10', '0', '10', ${actorId}
          )
        `);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, subsidiary_id,
             amount, quantity, unit_price, tax_amount, tax_input_amount)
          values
            (${org.orgId}, ${documentId}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
             '10', '1', '10', '0', '10'),
            (${org.orgId}, ${documentId}, 2, ${org.accounts.cogs}, ${org.subsidiaryId},
             '-10', '1', '-10', '0', '-10')
        `);
        await db.execute(sql`
          insert into period_locks
            (org_id, period_id, book_id, subsidiary_id, module, state,
             locked_at, locked_by, reason, created_by, updated_by)
          values (
            ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
            'gl', 'closed', now(), ${actorId}, 'Atomic post regression',
            ${actorId}, ${actorId}
          )
        `);
      });

      await assert.rejects(
        withOrgTransaction(org.orgId, async () => {
          const released = await submitAndReleaseIfUngated(
            "journal",
            documentId,
            actorId,
          );
          assert.equal(released.autoApproved, true);
          await postDocument(
            documentId,
            {
              control: {
                ar: org.accounts.ar,
                ap: org.accounts.ap,
                bank: org.accounts.bank,
              },
            },
            { deferEffects: true },
          );
        }),
        /period .*closed|closed.*period/i,
      );

      const state = await withOrgContext(org.orgId, async () =>
        (await db.execute(sql`
          select status, submitted_at, posted_entry_id,
                 (select count(*)::int from journal_entries
                   where source_document_id = ${documentId}) as entry_count
            from documents where id = ${documentId}
        `)) as unknown as {
          rows: Array<{
            status: string;
            submitted_at: string | null;
            posted_entry_id: string | null;
            entry_count: number;
          }>;
        },
      );
      assert.deepEqual(state.rows[0], {
        status: "draft",
        submitted_at: null,
        posted_entry_id: null,
        entry_count: 0,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
