import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "./db.ts";
import { PostingError, postDocument } from "./posting.ts";
import { setPeriodLockState } from "./close.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * F-t03-004: posting a bill into a closed AP period must refuse as a typed
 * PostingError naming the closed module ("AP is closed for this period and
 * accounting book") — which the documents-actions route answers as a 422 the
 * drawer and the row both pin beside the record (see
 * web/components/document-drawer-post-refusal.test.tsx) — and leave the
 * document approved with no partial journal behind.
 *
 * (Adapted from the unlanded predecessor probe onto withBypassContext and
 * the current fixture surface.)
 */
test(
  "posting a bill into a closed AP period refuses typed with no partial write",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const userId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Accountant", "admin"),
      );
      const id = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
           currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${id}, ${org.orgId}, 'vendor_bill', 'draft', 'BILL-CLOSED-AP',
                ${org.subsidiaryId}, ${org.vendorId}, ${org.date},
                'CAD', 1, '100.0000', '0', '100.0000', ${userId})`);
        await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${id}, 1, ${org.accounts.adjustment},
                '1', '100.0000', '100.0000', '0', '100.0000')`);
        await db.execute(sql`update documents set status = 'approved' where id = ${id} and org_id = ${org.orgId}`);
        await setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          module: "ap",
          state: "closed",
          actorId: userId,
          reason: "F-t03-004 probe: AP closed with the bill still approved",
        });
      });
      await assert.rejects(
        postDocument(id, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        }),
        (error: unknown) =>
          error instanceof PostingError &&
          /AP is closed for this period and accounting book/.test(error.message),
      );
      const untouched = await withBypassContext(() =>
        db.execute<{ status: string; entries: number }>(sql`
      select status,
             (select count(*)::int from journal_entries where source_document_id = ${id}) as entries
        from documents where id = ${id} and org_id = ${org.orgId}
    `),
      );
      assert.deepEqual(untouched.rows[0], { status: "approved", entries: 0 });
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
