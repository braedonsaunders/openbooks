import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../../../engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../../../engine/src/testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const migrationSql = readFileSync(
  new URL("./0265_filing_currency_and_ship_to_snapshot.sql", import.meta.url),
  "utf8",
);

/**
 * UPG-0265: the upgrade must succeed on an install that already holds tax
 * filings. The baseline tax_filing_immutable guard refuses every UPDATE but
 * prepared->filed, and the functional_currency backfill is an UPDATE, so the
 * released file died on the first populated install while empty installs
 * passed.
 *
 * The pre-0265 shape is planted with functional_currency and the ship-to
 * columns NULL (the columns already exist here, and every 0265 DDL is IF NOT
 * EXISTS), then the real file body is applied. Everything runs in one
 * transaction that always rolls back, so the org's data and the trigger state
 * are restored whatever happens.
 */
const ROLLBACK = Symbol("0265-test-rollback");

test("0265 backfills prepared and filed filings and a posted invoice, and leaves the filing guard enforcing", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  const prepared = randomUUID();
  const filed = randomUUID();
  const documentId = randomUUID();
  const lineId = randomUUID();
  const entryId = randomUUID();
  const configId = randomUUID();
  const hash = "a".repeat(64);
  try {
    await withBypass(() =>
      db.transaction(async () => {
        const [{ ccy }] = (await db.execute<{ ccy: string }>(sql`
          select base_currency as ccy from subsidiaries where id = ${org.subsidiaryId}`)).rows;

        await db.execute(sql`
          insert into tax_filings
            (id, org_id, form_code, form_name, country, period_from, period_to, version,
             status, submission_channel, boxes, snapshot_hash, filing_reference, filed_at)
          values
            (${prepared}, ${org.orgId}, 'TEST_FORM', 'Test return', 'CA', '2026-01-01', '2026-03-31', 1,
             'prepared', 'paper', '[]'::jsonb, ${hash}, null, null),
            (${filed}, ${org.orgId}, 'TEST_FORM', 'Test return', 'CA', '2025-10-01', '2025-12-31', 1,
             'filed', 'paper', '[]'::jsonb, ${hash}, 'REF-1', now())`);

        // A posted invoice with provider-quote evidence and no ship-to stamp:
        // the documents half of the backfill must pass its guards too.
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, origin)
          values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'UPG-0265',
                  ${org.date}, ${org.periodId}, 'pre-0265 shell', 'manual')`);
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, status, document_number, subsidiary_id, party_id,
             document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
          values (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', 'UPG-0265-1',
                  ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
                  ${ccy}, '1', '100.0000', '0.0000', '100.0000')`);
        await db.execute(sql`
          insert into document_lines
            (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
             tax_amount, quantity, unit_price)
          values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue},
                  '100.0000', '100.0000', '0.0000', '1', '100.0000')`);
        await db.execute(sql`
          update documents
             set status = 'posted', posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}
           where id = ${documentId} and org_id = ${org.orgId}`);
        await db.execute(sql`
          insert into tax_rate_provider_configs (id, org_id, provider, display_name, is_enabled)
          values (${configId}, ${org.orgId}, 'taxjar', 'Evidence provider', false)`);
        await db.execute(sql`
          insert into tax_rate_quotes
            (id, org_id, provider_config_id, provider, quoted_on, currency, ship_from, ship_to,
             taxable_amount, tax_amount, components, document_line_id, created_by, updated_by)
          values (${randomUUID()}, ${org.orgId}, ${configId}, 'taxjar', ${org.date}, ${ccy},
                  '{"country": "US", "region": "CA"}'::jsonb,
                  '{"country": "US", "region": "TX"}'::jsonb,
                  '100.0000', '0.0000', '[]'::jsonb, ${lineId}, null, null)`);

        // The runner applies the file in a fresh transaction; fire the seed's
        // deferred constraint events first so the file's ALTERs see the same
        // clean state (a pending event would refuse ALTER TABLE).
        await db.execute(sql`set constraints all immediate`);
        // The released body failed right here on any populated install.
        await db.execute(sql.raw(migrationSql));

        const filings = (await db.execute<{ id: string; functional_currency: string | null }>(sql`
          select id, functional_currency from tax_filings
           where org_id = ${org.orgId} order by period_from`)).rows;
        assert.deepEqual(
          filings.map((row) => row.functional_currency),
          [ccy, ccy],
          "both the filed and the prepared filing carry the entity's single functional currency",
        );

        const [stamp] = (await db.execute<{ ship_to_country: string | null; ship_to_region: string | null }>(sql`
          select ship_to_country, ship_to_region from documents where id = ${documentId}`)).rows;
        assert.deepEqual(stamp, { ship_to_country: "US", ship_to_region: "TX" });

        // The guard is back: an ordinary edit to a stored filing is refused.
        // An explicit savepoint keeps the refusal from aborting the outer
        // (rolled-back) transaction.
        await db.execute(sql`savepoint guard_probe`);
        await assert.rejects(
          db.execute(sql`update tax_filings set form_name = 'edited' where id = ${prepared}`),
          (error: unknown) => {
            const cause = (error as { cause?: { message?: string } }).cause;
            assert.match(cause?.message ?? String(error), /tax filing snapshots are immutable/);
            return true;
          },
        );
        await db.execute(sql`rollback to savepoint guard_probe`);

        // Re-running the body (the reapply transition) changes nothing further.
        await db.execute(sql.raw(migrationSql));
        const again = (await db.execute<{ functional_currency: string | null }>(sql`
          select functional_currency from tax_filings where org_id = ${org.orgId} order by period_from`)).rows;
        assert.deepEqual(again.map((row) => row.functional_currency), [ccy, ccy]);

        throw ROLLBACK;
      }),
    ).catch((error) => {
      if (error !== ROLLBACK) throw error;
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
