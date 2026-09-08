import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { runRevaluation } from "./fx-revaluation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

test("FX reversal failure removes its adjustment and preserves other entities inside a caller transaction", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const branchId = randomUUID();
  const constraint = `audit_fx_reversal_failure_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
        from accounting_periods where id=${org.periodId}`);
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Valid FX branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
    await db.execute(sql`
      update orgs set settings=settings || jsonb_build_object('controlAccounts',
        coalesce(settings->'controlAccounts', '{}'::jsonb) ||
        jsonb_build_object('fxUnrealizedGainLoss', ${org.accounts.fxGainLoss}::text)) where id=${org.orgId}`);
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.3700000000')`);
    for (const subsidiaryId of [org.subsidiaryId, branchId]) {
      const entryId = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, created_by, updated_by)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${subsidiaryId}, ${`FX-SEED-${subsidiaryId}`},
                '2026-07-10', ${org.periodId}, 'draft', 'manual', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
        values (${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${subsidiaryId}, 136, 'USD', 100, 1.36, false),
               (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${subsidiaryId}, -136, 'CAD', -136, 1, false)`);
      await db.execute(sql`update journal_entries set status='posted', posted_at=now(), posted_by=${actorId}
        where id=${entryId} and org_id=${org.orgId}`);
    }
    // The first entity's adjustment posts before its required reversal fails.
    await db.execute(sql.raw(`alter table journal_entries add constraint ${constraint}
      check (org_id <> '${org.orgId}'::uuid or subsidiary_id <> '${org.subsidiaryId}'::uuid
             or origin <> 'fx_revaluation' or reverses_entry_id is null) not valid`));
    await withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`update parties set display_name='Surviving FX caller'
        where org_id=${org.orgId} and id=${org.customerId}`);
      const result = await runRevaluation(org.orgId, org.periodId, actorId, [org.subsidiaryId, branchId]);
      assert.equal(result.problems.length, 1);
      assert.equal(result.posted.length, 1);
      assert.equal(result.posted[0]?.subsidiaryId, branchId);
      await db.execute(sql`select 1 as usable`);
    });
    const entries = (await db.execute<{ subsidiary_id: string; reverses_entry_id: string | null; status: string }>(sql`
      select subsidiary_id, reverses_entry_id, status from journal_entries
       where org_id=${org.orgId} and origin='fx_revaluation'`)).rows;
    assert.equal(entries.length, 2, "only the successful branch's adjustment and reversal remain");
    assert.ok(entries.every((entry) => entry.subsidiary_id === branchId && entry.status === "posted"));
    assert.equal(entries.filter((entry) => entry.reverses_entry_id !== null).length, 1);
    const caller = (await db.execute<{ name: string }>(sql`
      select display_name as name from parties where org_id=${org.orgId} and id=${org.customerId}`)).rows[0];
    assert.equal(caller?.name, "Surviving FX caller");
  } finally {
    await db.execute(sql.raw(`alter table journal_entries drop constraint if exists ${constraint}`));
    await dropScratchOrg(org.orgId);
  }
});
