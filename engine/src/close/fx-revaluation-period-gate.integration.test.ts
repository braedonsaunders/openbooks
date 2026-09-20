import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { runRevaluation } from "./fx-revaluation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * One period gate for FX revaluation (fleet 8, P7): the adjustment-leg and
 * reversal-leg checks route through assertPeriodModulesOpen instead of raw
 * period_module_is_closed SQL. Policy is preserved — revaluation mints new
 * local journals, not historical replay, so a source-owned imported lock
 * refuses exactly like a user lock on either leg. User-closed refusal on
 * both legs is already pinned by fx-revaluation-closed-period; this file
 * pins the open-period sanity post and both imported-lock flavors.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

const IMPORTED_REASON = "close.importedPeriodLockReason";

async function seedUsdCash(orgId: string, subsidiaryId: string, accounts: { bank: string; clearing: string; fxGainLoss: string }, actorId: string, bookId: string, periodId: string): Promise<void> {
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${orgId}`);
  await db.execute(sql`
    update orgs set settings = settings || jsonb_build_object('controlAccounts',
      coalesce(settings->'controlAccounts', '{}'::jsonb) ||
      jsonb_build_object('fxUnrealizedGainLoss', ${accounts.fxGainLoss}::text))
    where id=${orgId}`);
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
    values (${orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.3700000000')`);
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, created_by, updated_by)
    values (${entryId}, ${orgId}, ${bookId}, ${subsidiaryId}, 'USD-SEED', '2026-07-10', ${periodId}, 'draft', 'manual', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
    values
      (${orgId}, ${entryId}, 1, ${accounts.bank}, ${subsidiaryId}, 136.00, 'USD', 100.00, 1.36, false),
      (${orgId}, ${entryId}, 2, ${accounts.clearing}, ${subsidiaryId}, -136.00, 'CAD', -136.00, 1, false)`);
  await db.execute(sql`update journal_entries set status='posted', posted_at=now(), posted_by=${actorId} where id=${entryId}`);
}

async function seedAugust(orgId: string, periodId: string): Promise<string> {
  const augustId = randomUUID();
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    select ${augustId}, ${orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
      from accounting_periods where id = ${periodId}`);
  return augustId;
}

/**
 * Source-owned close, mirroring exactly what the migration mirror lands
 * (engine/src/sync/migrate.ts): every module locked with the imported reason.
 */
async function closeAllImported(orgId: string, periodId: string, bookId: string): Promise<void> {
  for (const module of ["ar", "ap", "banking", "assets", "tax", "gl"] as const) {
    await db.execute(sql`
      insert into period_locks
        (org_id, period_id, book_id, module, state, locked_at, reason)
      values (${orgId}, ${periodId}, ${bookId}, ${module},
              'closed', now(), ${IMPORTED_REASON})
      on conflict (org_id, period_id, book_id, subsidiary_id, module)
      do update set state = excluded.state,
        locked_at = excluded.locked_at,
        reason = excluded.reason,
        reopen_expires_at = null,
        version = period_locks.version + 1,
        updated_at = now()`);
  }
}

async function fxRevaluationEntryCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries
     where org_id=${orgId} and origin='fx_revaluation'`));
  return r.rows[0]!.n;
}

test("open periods: revaluation still posts its pair (setup can post, refusal is load-bearing)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedUsdCash(org.orgId, org.subsidiaryId, org.accounts, actorId, org.bookId, org.periodId);
    await seedAugust(org.orgId, org.periodId);
    const run = await withOrgContext(org.orgId, () =>
      runRevaluation(org.orgId, org.periodId, actorId, [org.subsidiaryId]));
    assert.equal(run.problems.length, 0, `expected no problems, got ${JSON.stringify(run.problems)}`);
    assert.ok(run.posted.length >= 1, "expected the adjustment+reversal pair to post");
    assert.equal(await fxRevaluationEntryCount(org.orgId), 2, "adjustment and reversal must both land");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("revaluation refuses an imported lock on the adjustment period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedUsdCash(org.orgId, org.subsidiaryId, org.accounts, actorId, org.bookId, org.periodId);
    await seedAugust(org.orgId, org.periodId);
    await closeAllImported(org.orgId, org.periodId, org.bookId);
    const run = await withOrgContext(org.orgId, () =>
      runRevaluation(org.orgId, org.periodId, actorId, [org.subsidiaryId]));
    assert.equal(run.posted.length, 0, "nothing may post into an imported lock");
    assert.equal(run.problems.length, 1, `one named refusal expected, got ${JSON.stringify(run)}`);
    assert.match(
      run.problems[0]!,
      /FX revaluation cannot post into the closed GL period/,
      `refusal must be named, got: ${run.problems[0]}`,
    );
    assert.equal(await fxRevaluationEntryCount(org.orgId), 0, "the backstop must leave no partial pair");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("revaluation refuses an imported lock on the reversal period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedUsdCash(org.orgId, org.subsidiaryId, org.accounts, actorId, org.bookId, org.periodId);
    const augustId = await seedAugust(org.orgId, org.periodId);
    await closeAllImported(org.orgId, augustId, org.bookId);
    const run = await withOrgContext(org.orgId, () =>
      runRevaluation(org.orgId, org.periodId, actorId, [org.subsidiaryId]));
    assert.equal(run.posted.length, 0, "the pair is atomic: no adjustment without its reversal");
    assert.equal(run.problems.length, 1, `one named refusal expected, got ${JSON.stringify(run)}`);
    assert.match(
      run.problems[0]!,
      /FX revaluation cannot post its reversal into the closed GL period/,
      `refusal must be named, got: ${run.problems[0]}`,
    );
    assert.equal(await fxRevaluationEntryCount(org.orgId), 0, "no half pair may survive");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
