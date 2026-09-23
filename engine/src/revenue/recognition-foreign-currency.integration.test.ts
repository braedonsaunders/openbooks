import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { postDocument } from "../ledger/posting-document.ts";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";
import { runRevenueRecognition } from "./recognition.ts";

// Foreign-currency revenue recognition (0256): a schedule never amended
// used to convert its plan at FX rate 1 in the functional currency, while
// the invoice credited deferred revenue at the invoice's own rate —
// stranding the difference in deferred revenue forever. Deferred revenue
// is a non-monetary liability, so recognition drains it at the historical
// deferral rate stamped on the schedule at creation, with no revaluation.

const MIGRATION_URL = new URL(
  "../../../schema/migrations/generated/0256_recognition_schedule_transaction_rate.sql",
  import.meta.url,
);

async function runMigration(): Promise<void> {
  // Execute the shipped migration bytes verbatim, minus the runner-owned
  // SET header: those session GUCs belong to the migration runner, and
  // running them here would leak onto this pooled test connection. The
  // statement is re-runnable (ADD COLUMN IF NOT EXISTS, backfill fills
  // only unstamped schedules), so it is a no-op once the template ships it.
  const body = readFileSync(MIGRATION_URL, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("SET "))
    .join("\n");
  assert.match(body, /0256_recognition_schedule_transaction_rate/, "migration file must be the shipped artifact");
  await db.execute(sql.raw(body));
}

const DB = !!process.env.OPENBOOKS_DB_URL;

async function glBalance(orgId: string, accountId: string): Promise<string> {
  const r = await db.execute<{ balance: string }>(sql`
    select coalesce(sum(line.amount), 0)::text as balance
      from journal_lines line
      join journal_entries entry on entry.id = line.entry_id
     where line.org_id = ${orgId}
       and line.account_id = ${accountId}
       and entry.status = 'posted'
  `);
  return r.rows[0]!.balance;
}

test("a euro invoice recognizes out its full dollar-deferred balance at the historical rate", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  try {
    await runMigration();
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values ('EUR', 'Euro', 2) on conflict (code) do nothing`);
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId}, 'EUR', 'CAD', ${org.date}, 'spot', '1.1000000000', 'manual')`);
    // One-period term keeps the arithmetic exact: EUR 1,000 @ 1.10 defers
    // CAD 1,100 and must recognize exactly CAD 1,100.
    await db.execute(sql`
      update recognition_rules set recognition_periods = 1 where org_id = ${org.orgId}`);
    const documentId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, posting_date, due_date, currency, fx_rate, status,
         subtotal, tax_total, total, is_final_invoice, custom, extra_dims,
         created_by, updated_by)
      values
        (${documentId}, ${org.orgId}, 'customer_invoice', 'INV-FX-EUR',
         ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
         ${org.date}, 'EUR', '1.10', 'draft', 1000, 0, 1000, false,
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
         ${org.items.service}, ${org.accounts.revenue}, 1, 1000, 1000, 0,
         false, 0, 0, '{}'::jsonb, false, '{}'::jsonb,
         ${actors.adminId}, ${actors.adminId})
    `);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where id = ${documentId} and org_id = ${org.orgId}
    `);
    await postDocument(
      documentId,
      { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
      { audit: { actorId: actors.adminId, source: "test" } },
    );

    // The invoice credited deferred revenue at its own rate.
    assert.equal(await glBalance(org.orgId, org.accounts.deferred), "-1100.0000");

    // The schedule stamped the invoice currency and historical rate at creation.
    const schedule = (await db.execute<{ transaction_currency: string | null; transaction_fx_rate: string | null }>(sql`
      select transaction_currency, transaction_fx_rate::text as transaction_fx_rate
        from recognition_schedules where org_id = ${org.orgId} limit 1`)).rows[0];
    assert.equal(schedule?.transaction_currency, "EUR");
    assert.equal(schedule?.transaction_fx_rate, "1.1000000000");

    const run = await runRevenueRecognition(org.orgId, "2026-07-31", actors.adminId);
    assert.equal(run.posted, 1);

    // The full deferred balance drains: before the fix recognition posted
    // CAD 1,000 against CAD 1,100 deferred, stranding CAD 100 forever.
    assert.equal(await glBalance(org.orgId, org.accounts.deferred), "0.0000");
    assert.equal(await glBalance(org.orgId, org.accounts.recognized), "-1100.0000");

    // Every deferred-side line converts in invoice currency at the
    // historical rate — no rate-1 functional-currency leg remains.
    const legs = (await db.execute<{ currency: string; fx_rate: string }>(sql`
      select distinct currency, fx_rate::text as fx_rate from journal_lines
       where org_id = ${org.orgId} and account_id = ${org.accounts.deferred}`)).rows;
    assert.deepEqual(legs, [{ currency: "EUR", fx_rate: "1.1000000000" }]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
