import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  postDocument,
  PostingError,
  regenerateGlImpactTx,
  type PostingDeps,
} from "./posting.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "posted GL replay is idempotent for metadata and fails closed for every financial projection change",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const deps: PostingDeps = {
      migration: true,
      control: {
        ar: org.accounts.ar,
        ap: org.accounts.ap,
        bank: org.accounts.bank,
      },
    };
    try {
      const documentId = randomUUID();
      const lineId = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status, subtotal,
           tax_total, total, is_final_invoice, custom, extra_dims)
        values
          (${documentId}, ${org.orgId}, 'vendor_bill', 'REPLAY-IMMUTABLE',
           ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 1, 'approved', '100', '0', '100', false, '{}'::jsonb,
           '{}'::jsonb)
      `);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, quantity,
           unit_price, amount, tax_amount, is_billable, quantity_fulfilled,
           quantity_billed, custom, tax_overridden, extra_dims)
        values
          (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs},
           1, 100, 100, 0, false, 0, 0, '{}'::jsonb, false, '{}'::jsonb)
      `);
      const entryId = await postDocument(documentId, deps);
      const before = (await db.execute<Record<string, unknown>>(sql`
        select jl.id, jl.line_number, jl.account_id, jl.amount::text,
               jl.currency, jl.txn_amount::text, jl.fx_rate::text,
               jl.party_id, jl.is_open_item
          from journal_lines jl
         where jl.entry_id = ${entryId}
         order by jl.line_number
      `));

      await assert.rejects(
        db.transaction((tx) =>
          regenerateGlImpactTx(
            tx,
            documentId,
            { ...deps, migration: false },
            "mirror",
          ),
        ),
        (error: unknown) =>
          error instanceof PostingError && /restricted/.test(error.message),
      );

      const unchanged = await db.transaction((tx) =>
        regenerateGlImpactTx(tx, documentId, deps, "mirror"),
      );
      assert.deepEqual(unchanged, { entryId, changed: false });

      const memoOnly = await db.transaction(async (tx) => {
        await tx.execute(sql`
          update documents
             set memo = 'Non-financial source metadata', updated_at = now()
           where id = ${documentId} and org_id = ${org.orgId}
        `);
        return regenerateGlImpactTx(tx, documentId, deps, "mirror");
      });
      assert.deepEqual(memoOnly, { entryId, changed: false });

      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.amend = on`);
          await tx.execute(sql`
            update documents
               set subtotal = 120, total = 120, updated_at = now()
             where id = ${documentId} and org_id = ${org.orgId}
          `);
          await tx.execute(sql`
            update document_lines
               set unit_price = 120, amount = 120, updated_at = now()
             where id = ${lineId} and org_id = ${org.orgId}
          `);
          return regenerateGlImpactTx(tx, documentId, deps, "mirror");
        }),
        (error: unknown) =>
          error instanceof PostingError &&
          /in-place regeneration is forbidden/.test(error.message),
      );

      await db.execute(sql`
        insert into currencies (code, name, minor_units)
        values ('USD', 'US Dollar', 2)
        on conflict (code) do nothing
      `);
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.amend = on`);
          await tx.execute(sql`
            update documents
               set currency = 'USD', fx_rate = 1, updated_at = now()
             where id = ${documentId} and org_id = ${org.orgId}
          `);
          return regenerateGlImpactTx(tx, documentId, deps, "mirror");
        }),
        (error: unknown) =>
          error instanceof PostingError &&
          /in-place regeneration is forbidden/.test(error.message),
      );

      const after = (await db.execute<Record<string, unknown>>(sql`
        select jl.id, jl.line_number, jl.account_id, jl.amount::text,
               jl.currency, jl.txn_amount::text, jl.fx_rate::text,
               jl.party_id, jl.is_open_item
          from journal_lines jl
         where jl.entry_id = ${entryId}
         order by jl.line_number
      `));
      assert.deepEqual(after.rows, before.rows, "posted journal evidence never changed");
      const persisted = (await db.execute<{
          currency: string;
          subtotal: string;
          total: string;
          memo: string | null;
        }>(sql`
        select currency, subtotal::text, total::text, memo
          from documents
         where id = ${documentId} and org_id = ${org.orgId}
      `));
      assert.deepEqual(persisted.rows[0], {
        currency: "CAD",
        subtotal: "100.0000",
        total: "100.0000",
        memo: "Non-financial source metadata",
      });
      const entryCount = (await db.execute<{ count: number }>(sql`
        select count(*)::int as count
          from journal_entries
         where source_document_id = ${documentId} and org_id = ${org.orgId}
      `));
      assert.equal(entryCount.rows[0]!.count, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
