import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { refreshCloseRun, startCloseRun } from "./close.ts";
import { runAutoElimination } from "./consolidation.ts";
import { db } from "./db.ts";
import { runRevaluation } from "./fx-revaluation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Close readiness for the consolidation and foreign-exchange diagnostics must
 * be decided by the same rules the engines that satisfy them apply:
 *   - intercompany residuals are measured in the consolidation currency,
 *     through the period's consolidated rates, with the elimination
 *     subsidiary's own lines included — a group runAutoElimination balanced
 *     reads zero; a foreign entity with no consolidated rate is its own
 *     explicit exception, never a phantom residual;
 *   - fx revaluation readiness is decided by the revaluation engine's own
 *     population, spot-rate lookup, and delta arithmetic — a position already
 *     at the period-end rate needs no entry, a monetary override is honoured,
 *     and a missing following period is reported as the actionable cause.
 */

/** Open exceptions of one code on a run: [] when clear. */
async function openExceptions(orgId: string, runId: string, code: string): Promise<{ count: number }[]> {
  const rows = (await db.execute<{ details: { count: number } }>(sql`
    select details from close_exceptions
     where org_id = ${orgId} and run_id = ${runId} and code = ${code} and status = 'open'`));
  return rows.rows.map((row) => ({ count: Number(row.details.count) }));
}

async function postEntry(
  org: ScratchOrg,
  args: {
    subsidiaryId: string;
    periodId: string;
    tag: string;
    postingDate: string;
    lines: { accountId: string; amount: string; currency: string; txnAmount: string; fxRate: string }[];
  },
): Promise<string> {
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${args.subsidiaryId}, ${args.tag}, ${args.postingDate},
            ${args.periodId}, ${args.tag}, 'draft', 'manual')`);
  // One statement for every line: the kernel's balance trigger evaluates the
  // entry per statement, so lines land together.
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
    values ${sql.join(
      args.lines.map((line, index) => sql`(${org.orgId}, ${entryId}, ${index + 1}, ${line.accountId}, ${args.subsidiaryId},
        ${line.amount}, ${line.currency}, ${line.txnAmount}, ${line.fxRate}, false)`),
      sql`, `,
    )}`);
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
  return entryId;
}

test("a group that eliminates cleanly at consolidated rates has no intercompany residual exception", { skip: !DB }, async () => {
  // Regression (G3): the readiness check summed functional-currency amounts
  // across entities of different currencies, so a reconciled CAD/USD group
  // (120 CAD due-from vs 100 USD due-to at 1.20) reported a residual forever.
  const org = await createScratchOrg();
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const usdId = randomUUID();
    const eliminationId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${usdId}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb),
        (${eliminationId}, ${org.orgId}, ${org.subsidiaryId}, 'Eliminations', 'CAD', 'CA', '{}'::jsonb, true, true, '{}'::jsonb)`);
    await db.execute(sql`update accounts set eliminate = true where id in (${org.accounts.ar}, ${org.accounts.ap})`);
    await db.execute(sql`
      insert into consolidated_fx_rates
        (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate, source)
      values (${org.orgId}, ${org.periodId}, 'USD', 'CAD', '1.2000000000', '1.1900000000', '1.1000000000', 'manual')`);
    await postEntry(org, {
      subsidiaryId: org.subsidiaryId, periodId: org.periodId, tag: "IC-CAD", postingDate: org.date,
      lines: [
        { accountId: org.accounts.ar, amount: "120.0000", currency: "CAD", txnAmount: "120.0000", fxRate: "1" },
        { accountId: org.accounts.bank, amount: "-120.0000", currency: "CAD", txnAmount: "-120.0000", fxRate: "1" },
      ],
    });
    await postEntry(org, {
      subsidiaryId: usdId, periodId: org.periodId, tag: "IC-USD", postingDate: org.date,
      lines: [
        { accountId: org.accounts.ap, amount: "-100.0000", currency: "USD", txnAmount: "-100.0000", fxRate: "1" },
        { accountId: org.accounts.bank, amount: "100.0000", currency: "USD", txnAmount: "100.0000", fxRate: "1" },
      ],
    });
    const elimination = await runAutoElimination(org.orgId, org.periodId, actorId);
    assert.equal(elimination.lineCount, 2);

    const runId = await startCloseRun({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, actorId });
    await refreshCloseRun(org.orgId, runId, actorId);
    assert.deepEqual(await openExceptions(org.orgId, runId, "intercompany-residual"), [],
      "a group balanced at consolidated rates carries no residual");
    assert.deepEqual(await openExceptions(org.orgId, runId, "consolidated-rates-missing"), []);

    // Without the USD→CAD consolidated rate the USD entity cannot be measured:
    // that is an explicit "rates missing" exception, not a false residual.
    await db.execute(sql`delete from consolidated_fx_rates where org_id = ${org.orgId}`);
    await refreshCloseRun(org.orgId, runId, actorId);
    assert.deepEqual(await openExceptions(org.orgId, runId, "consolidated-rates-missing"), [{ count: 1 }]);
    assert.deepEqual(await openExceptions(org.orgId, runId, "intercompany-residual"), []);

    // A genuine one-sided posting is still a residual once rates are back.
    await db.execute(sql`
      insert into consolidated_fx_rates
        (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate, source)
      values (${org.orgId}, ${org.periodId}, 'USD', 'CAD', '1.2000000000', '1.1900000000', '1.1000000000', 'manual')`);
    await postEntry(org, {
      subsidiaryId: org.subsidiaryId, periodId: org.periodId, tag: "IC-BROKEN", postingDate: org.date,
      lines: [
        { accountId: org.accounts.ar, amount: "5.0000", currency: "CAD", txnAmount: "5.0000", fxRate: "1" },
        { accountId: org.accounts.bank, amount: "-5.0000", currency: "CAD", txnAmount: "-5.0000", fxRate: "1" },
      ],
    });
    await refreshCloseRun(org.orgId, runId, actorId);
    assert.deepEqual(await openExceptions(org.orgId, runId, "intercompany-residual"), [{ count: 1 }]);
    assert.deepEqual(await openExceptions(org.orgId, runId, "consolidated-rates-missing"), []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("fx readiness is satisfied when the revaluation engine has nothing to post and honours the monetary override", { skip: !DB }, async () => {
  // Regression (G4, parts 1 and 3): a foreign balance already carried at the
  // period-end rate produces no revaluation entry (delta zero → the engine
  // skips), yet the check demanded one; and the check hard-coded three
  // account types while the engine honours accounts.monetary.
  const org = await createScratchOrg();
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
        from accounting_periods where id = ${org.periodId}`);
    await db.execute(sql`
      update orgs
         set settings = settings || jsonb_build_object('controlAccounts',
              coalesce(settings->'controlAccounts', '{}'::jsonb) ||
              jsonb_build_object('fxUnrealizedGainLoss', ${org.accounts.fxGainLoss}::text))
       where id = ${org.orgId}`);
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.3600000000')`);
    // USD 100 receivable already carried at the period-end 1.36: zero delta.
    await postEntry(org, {
      subsidiaryId: org.subsidiaryId, periodId: org.periodId, tag: "USD-AR", postingDate: "2026-07-10",
      lines: [
        { accountId: org.accounts.ar, amount: "136.0000", currency: "USD", txnAmount: "100.0000", fxRate: "1.36" },
        { accountId: org.accounts.clearing, amount: "-136.0000", currency: "CAD", txnAmount: "-136.0000", fxRate: "1" },
      ],
    });
    const skipped = await runRevaluation(org.orgId, org.periodId, actorId);
    assert.deepEqual(skipped.posted, []);
    assert.deepEqual(skipped.skipped.map((s) => s.reason), ["no revaluation needed"]);

    const runId = await startCloseRun({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, actorId });
    await refreshCloseRun(org.orgId, runId, actorId);
    assert.deepEqual(await openExceptions(org.orgId, runId, "fx-unrevalued"), [],
      "a balance already at the period-end rate needs no revaluation entry");
    assert.deepEqual(await openExceptions(org.orgId, runId, "fx-reversal-period-missing"), []);

    // A long-term USD loan flagged monetary (outside the three default types)
    // carried at a stale rate IS an exposure the engine revalues — and the
    // check must see it through the same predicate.
    const loanId = randomUUID();
    await db.execute(sql`
      insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, monetary,
         required_dimensions, custom, subsidiary_include_children)
      values (${loanId}, ${org.orgId}, '2700', 'USD term loan', 'liability_long_term', false, true, false, false, true,
              '[]'::jsonb, '{}'::jsonb, true)`);
    await postEntry(org, {
      subsidiaryId: org.subsidiaryId, periodId: org.periodId, tag: "USD-LOAN", postingDate: "2026-07-12",
      lines: [
        { accountId: org.accounts.clearing, amount: "1300.0000", currency: "CAD", txnAmount: "1300.0000", fxRate: "1" },
        { accountId: loanId, amount: "-1300.0000", currency: "USD", txnAmount: "-1000.0000", fxRate: "1.30" },
      ],
    });
    await refreshCloseRun(org.orgId, runId, actorId);
    assert.deepEqual(await openExceptions(org.orgId, runId, "fx-unrevalued"), [{ count: 1 }],
      "the monetary-flagged loan is an unrevalued exposure");

    const posted = await runRevaluation(org.orgId, org.periodId, actorId);
    assert.equal(posted.posted.length, 1);
    assert.equal(posted.posted[0]!.netDelta, "-60.0000", "USD 1000 at 1.36 vs carried 1300");
    await refreshCloseRun(org.orgId, runId, actorId);
    assert.deepEqual(await openExceptions(org.orgId, runId, "fx-unrevalued"), []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a missing following period is reported as its own actionable fx exception and clears once periods exist", { skip: !DB }, async () => {
  // Regression (G4, part 2): the engine refuses to revalue without a period
  // for the mandatory reversal, so the run was stuck on "unrevalued" with no
  // hint that generating periods was the fix.
  const org = await createScratchOrg();
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await db.execute(sql`
      update orgs
         set settings = settings || jsonb_build_object('controlAccounts',
              coalesce(settings->'controlAccounts', '{}'::jsonb) ||
              jsonb_build_object('fxUnrealizedGainLoss', ${org.accounts.fxGainLoss}::text))
       where id = ${org.orgId}`);
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.3700000000')`);
    await postEntry(org, {
      subsidiaryId: org.subsidiaryId, periodId: org.periodId, tag: "USD-AR", postingDate: "2026-07-10",
      lines: [
        { accountId: org.accounts.ar, amount: "136.0000", currency: "USD", txnAmount: "100.0000", fxRate: "1.36" },
        { accountId: org.accounts.clearing, amount: "-136.0000", currency: "CAD", txnAmount: "-136.0000", fxRate: "1" },
      ],
    });
    const refused = await runRevaluation(org.orgId, org.periodId, actorId);
    assert.deepEqual(refused.posted, []);
    assert.equal(refused.problems.length, 1);

    const runId = await startCloseRun({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, actorId });
    await refreshCloseRun(org.orgId, runId, actorId);
    assert.deepEqual(await openExceptions(org.orgId, runId, "fx-unrevalued"), [{ count: 1 }]);
    assert.deepEqual(await openExceptions(org.orgId, runId, "fx-reversal-period-missing"), [{ count: 1 }],
      "the cause (no period to reverse into) is its own exception");

    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
        from accounting_periods where id = ${org.periodId}`);
    await refreshCloseRun(org.orgId, runId, actorId);
    assert.deepEqual(await openExceptions(org.orgId, runId, "fx-reversal-period-missing"), []);
    assert.deepEqual(await openExceptions(org.orgId, runId, "fx-unrevalued"), [{ count: 1 }]);

    const posted = await runRevaluation(org.orgId, org.periodId, actorId);
    assert.equal(posted.posted.length, 1);
    await refreshCloseRun(org.orgId, runId, actorId);
    assert.deepEqual(await openExceptions(org.orgId, runId, "fx-unrevalued"), []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
