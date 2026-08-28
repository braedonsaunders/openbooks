import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { ControlAccountsIncompleteError } from "./control-accounts.ts";
import { db } from "./db.ts";
import { runRevaluation } from "./fx-revaluation.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("period-end FX revaluation rejects a balance-sheet unrealized gain/loss account", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // A legacy/direct settings write can point the P&L leg at an active,
    // postable balance-sheet account. The shared control-account loader must
    // reject the role before revaluation can construct or post any journals.
    await db.execute(sql`
      update orgs
         set settings = settings || jsonb_build_object('controlAccounts',
              coalesce(settings->'controlAccounts', '{}'::jsonb) ||
              jsonb_build_object('fxUnrealizedGainLoss', ${org.accounts.ar}::text))
       where id = ${org.orgId}`);

    await assert.rejects(
      () => runRevaluation(org.orgId, org.periodId, null),
      (error: unknown) =>
        error instanceof ControlAccountsIncompleteError &&
        /fxUnrealizedGainLoss control account type asset_receivable is incompatible/.test(error.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * journal_entries_org_number is unique per ORG, but the revaluation duplicate
 * check is scoped to one (book, period, subsidiary). Two legal entities
 * revaluing the same period must therefore never share an entry number —
 * before the per-journal salt, the second subsidiary's insert violated the
 * index and every multi-subsidiary close reported a problem instead of
 * posting.
 */
test("period-end FX revaluation posts every subsidiary with distinct journal numbers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;

    // The mandatory reversal needs a following period to land in.
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
        from accounting_periods where id = ${org.periodId}`);

    // Second legal entity in the same org/book/period (one root per org, so
    // the branch hangs under the fixture's root subsidiary).
    const branchSubsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${branchSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Branch Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);

    await db.execute(sql`
      update orgs
         set settings = settings || jsonb_build_object('controlAccounts',
              coalesce(settings->'controlAccounts', '{}'::jsonb) ||
              jsonb_build_object('fxUnrealizedGainLoss', ${org.accounts.fxGainLoss}::text))
       where id = ${org.orgId}`);

    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.3700000000')`);

    // A USD receivable carried at the historical 1.36 on each entity's books:
    // period-end spot 1.37 restates +1.00 CAD per subsidiary.
    for (const subsidiaryId of [org.subsidiaryId, branchSubsidiaryId]) {
      const entryId = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, status, origin, created_by, updated_by)
        values (
          ${entryId}, ${org.orgId}, ${org.bookId}, ${subsidiaryId},
          ${"USD-SEED-" + subsidiaryId.slice(0, 8)}, '2026-07-10', ${org.periodId},
          'draft', 'manual', ${actorId}, ${actorId}
        )`);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, is_open_item)
        values
          (${org.orgId}, ${entryId}, 1, ${org.accounts.ar},
           ${subsidiaryId}, 136.00, 'USD', 100.00, 1.36, false),
          (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing},
           ${subsidiaryId}, -136.00, 'CAD', -136.00, 1, false)`);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${actorId}
         where id = ${entryId}`);
    }

    const run = await runRevaluation(org.orgId, org.periodId, actorId);
    assert.deepEqual(run.problems, [], "no subsidiary may fail to post");
    assert.deepEqual(
      run.posted.map((p) => p.subsidiaryId).sort(),
      [branchSubsidiaryId, org.subsidiaryId].sort(),
    );
    for (const posted of run.posted) {
      assert.equal(posted.reversalEntryId !== null, true);
      assert.equal(posted.netDelta, "1.0000");
    }

    const journals = (await db.execute<{ id: string; entry_number: string; reverses_entry_id: string | null }>(sql`
      select id, entry_number, reverses_entry_id
        from journal_entries
       where org_id = ${org.orgId} and origin = 'fx_revaluation'
       order by entry_number`));
    assert.equal(journals.rows.length, 4, "two adjustments plus their two mirrors");
    const numbers = journals.rows.map((row) => row.entry_number);
    assert.equal(new Set(numbers).size, 4, `all four journals need distinct numbers, got ${numbers.join(", ")}`);
    assert.ok(numbers.every((n) => n.startsWith("FXREVAL-2026-07-")));
    for (const posted of run.posted) {
      const adjustment = journals.rows.find((row) => row.id === posted.entryId);
      const mirror = journals.rows.find((row) => row.reverses_entry_id === posted.entryId);
      assert.ok(adjustment && mirror, "each adjustment carries its mirror");
      assert.equal(mirror.entry_number, `${adjustment.entry_number}-R`);
    }

    // Idempotence is unchanged: rerunning skips instead of re-posting.
    const rerun = await runRevaluation(org.orgId, org.periodId, actorId);
    assert.deepEqual(rerun.problems, []);
    assert.deepEqual(rerun.posted, []);
    assert.deepEqual(rerun.skipped.map((s) => s.reason), [
      "already revalued for this period",
      "already revalued for this period",
    ]);
    const afterRerun = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from journal_entries
       where org_id = ${org.orgId} and origin = 'fx_revaluation'`));
    assert.equal(afterRerun.rows[0]?.count, 4);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
