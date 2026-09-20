import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { setPeriodLockState } from "./close.ts";
import { runRevaluation } from "./fx-revaluation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * FX revaluation into a GL-closed period must refuse with a named
 * RevaluationError, not the je_guard backstop's raw driver text. The run
 * records per-subsidiary failures in problems[] by design (siblings keep
 * posting), so the defect is the error's identity: a raw DrizzleQueryError
 * message reaching the operator where every sibling fence (leases,
 * consolidation, asset lifecycle) raises its named domain error.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

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

async function fxRevaluationEntryCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries
     where org_id=${orgId} and origin='fx_revaluation'`));
  return r.rows[0]!.n;
}

test("revaluation into a GL-closed period refuses with a named error", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedUsdCash(org.orgId, org.subsidiaryId, org.accounts, actorId, org.bookId, org.periodId);
    // August stays open as the reversal leg, so the July lock is the refusal cause.
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
        from accounting_periods where id = ${org.periodId}`);
    await setPeriodLockState({
      orgId: org.orgId, periodId: org.periodId, bookId: org.bookId,
      module: "gl", state: "closed", actorId, reason: "July is closed before revaluation",
    });
    const run = await withOrgContext(org.orgId, () =>
      runRevaluation(org.orgId, org.periodId, actorId, [org.subsidiaryId]));
    assert.equal(run.posted.length, 0, "nothing may post into a closed period");
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

test("revaluation refuses with a named error when the reversal period is closed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedUsdCash(org.orgId, org.subsidiaryId, org.accounts, actorId, org.bookId, org.periodId);
    const augustId = randomUUID();
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${augustId}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
        from accounting_periods where id = ${org.periodId}`);
    // July stays open; the August reversal leg is locked.
    await setPeriodLockState({
      orgId: org.orgId, periodId: augustId, bookId: org.bookId,
      module: "gl", state: "closed", actorId, reason: "August is closed before July revaluation",
    });
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
