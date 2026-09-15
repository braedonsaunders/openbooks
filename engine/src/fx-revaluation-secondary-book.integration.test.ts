import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { withOrgContext } from "./db.ts";
import { revaluationReadiness, runRevaluation } from "./fx-revaluation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

/**
 * FX revaluation must run per book. A tax (secondary) book carrying a
 * foreign-currency balance has the same unrealized exposure as primary, and
 * the close's fx-unrevalued check evaluates it — but the run only ever
 * posted primary, so the tax book could never clear readiness and never
 * close. Only origin='fx_revaluation' entries count as effective
 * adjustments, so a manual journal cannot substitute either.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

test("fx revaluation clears unrealized positions on a secondary book", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const taxBookId = randomUUID();
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`
      update orgs set settings = settings || jsonb_build_object('controlAccounts',
        coalesce(settings->'controlAccounts', '{}'::jsonb) ||
        jsonb_build_object('fxUnrealizedGainLoss', ${org.accounts.fxGainLoss}::text))
      where id=${org.orgId}`);
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${taxBookId}, ${org.orgId}, 'TAX', 'Tax book', false, true, true)`);
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
        from accounting_periods where id = ${org.periodId}`);
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.3700000000')`);
    // USD 100 of foreign-currency cash carried at 1.36 — on the TAX book only.
    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, created_by, updated_by)
      values (${entryId}, ${org.orgId}, ${taxBookId}, ${org.subsidiaryId}, 'USD-TAX-SEED', '2026-07-10', ${org.periodId}, 'draft', 'manual', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
      values
        (${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, 136.00, 'USD', 100.00, 1.36, false),
        (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, -136.00, 'CAD', -136.00, 1, false)`);
    await db.execute(sql`update journal_entries set status='posted', posted_at=now(), posted_by=${actorId} where id=${entryId}`);

    const before = await withOrgContext(org.orgId, () =>
      revaluationReadiness(org.orgId, taxBookId, org.periodId, [org.subsidiaryId]),
    );
    assert.ok(before.unrevaluedPositions > 0, "tax book must show the unrealized position");
    const primary = await withOrgContext(org.orgId, () =>
      revaluationReadiness(org.orgId, org.bookId, org.periodId, [org.subsidiaryId]),
    );
    assert.equal(primary.unrevaluedPositions, 0, "primary book has no exposure in this scenario");

    const run = await withOrgContext(org.orgId, () =>
      runRevaluation(org.orgId, org.periodId, actorId, [org.subsidiaryId], taxBookId),
    );
    assert.deepEqual(run.problems, [], `revaluation must post cleanly, got ${JSON.stringify(run.problems)}`);
    assert.equal(run.posted.length, 1, "one subsidiary revalued on the tax book");
    assert.equal(run.posted[0]?.netDelta, "1.0000");

    const postedBook = (await db.execute<{ book_id: string }>(sql`
      select distinct e.book_id from journal_entries e
       where e.org_id = ${org.orgId} and e.origin = 'fx_revaluation'`)).rows.map((r) => r.book_id);
    assert.deepEqual(postedBook, [taxBookId], "adjustment must land on the tax book, never primary");

    const after = await withOrgContext(org.orgId, () =>
      revaluationReadiness(org.orgId, taxBookId, org.periodId, [org.subsidiaryId]),
    );
    assert.equal(after.unrevaluedPositions, 0, "tax-book readiness must clear so the book can close");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
