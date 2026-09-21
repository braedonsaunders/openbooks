import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

/**
 * Migration 0236 (jl_check_account evidence stamp): the connector's
 * cleared-date mirror stamps source_cleared_date / source_cleared_connector
 * on posted lines. The stamp changes no posting-relevant field, so
 * jl_check_account admits it even when the line's account was deactivated
 * after posting — under exactly the evidence column set jl_guard carves
 * out. Every genuine posting to an inactive, summary, or
 * currency-restricted account is still refused, and moving already-set
 * evidence is still refused append-only by jl_guard.
 *
 * Written to the standard, not executed: this machine runs no database
 * partition. The integration gate runs this file where OPENBOOKS_DB_URL
 * is set.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Drizzle wraps Postgres failures; the guard's text lives down the cause chain. */
function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  const messages: string[] = [];
  for (
    let current: unknown = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    messages.push(String((current as { message?: unknown }).message ?? ""));
  }
  return pattern.test(messages.join(" "));
}

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function draftEntry(org: Org, number: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
    values (${id}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${number}, ${org.date},
            ${org.periodId}, 'draft', 'manual')`);
  return id;
}

/** One multi-row statement: the deferred entry-balance trigger fires at commit. */
async function insertBalancedPair(
  org: Org,
  entryId: string,
  firstAccount: string,
  secondAccount: string,
  currency = "CAD",
): Promise<void> {
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
    values (${org.orgId}, ${entryId}, 1, ${firstAccount}, ${org.subsidiaryId}, 100, ${currency}, 100, 1, ''),
           (${org.orgId}, ${entryId}, 2, ${secondAccount}, ${org.subsidiaryId}, -100, ${currency}, -100, 1, '')`);
}

async function postEntry(org: Org, entryId: string): Promise<void> {
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
}

/**
 * Post a balanced entry and then deactivate one leg's account — the shape
 * the defect arrives in: legally posted while active, deactivated after.
 * Marks the account reconcilable so the connector's mirror predicate
 * (which only stamps reconcilable accounts) selects the line.
 */
async function postedEntryWithDeactivatedAccount(org: Org, number: string): Promise<{ entryId: string; lineId: string }> {
  const entryId = await draftEntry(org, number);
  await insertBalancedPair(org, entryId, org.accounts.bank, org.accounts.revenue);
  await postEntry(org, entryId);
  // Reconcilable accounts must carry a currency restriction
  // (accounts_reconcilable_currency_required); CAD matches the posted legs.
  await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD', is_active = false where id = ${org.accounts.bank} and org_id = ${org.orgId}`);
  const lineId = (await db.execute<{ id: string }>(sql`
    select id from journal_lines where entry_id = ${entryId} and org_id = ${org.orgId} and line_number = 1`)).rows[0]!.id;
  return { entryId, lineId };
}

/** The connector's cleared-date mirror statement (engine/src/banking/banking.ts). */
async function mirrorClearedStamp(org: Org, entryId: string, accountId: string, connector: string) {
  return db.execute<{ id: string }>(sql`
    update journal_lines jl
       set source_cleared_date = ${org.date}, source_cleared_connector = ${connector}
     where jl.org_id = ${org.orgId} and jl.entry_id = ${entryId} and jl.account_id = ${accountId}
       and jl.source_cleared_date is null
       and exists (
         select 1 from accounts a
          where a.id = jl.account_id and a.org_id = jl.org_id and a.reconcilable
       )
    returning jl.id`);
}

test("0236: evidence-only stamp on a deactivated account succeeds and returns the line id", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { entryId, lineId } = await postedEntryWithDeactivatedAccount(org, "EV-0236-A");
    // Pre-fix this raises 'account <uuid> is inactive' and fails the run.
    const stamped = await mirrorClearedStamp(org, entryId, org.accounts.bank, "netsuite");
    assert.equal(stamped.rows.length, 1);
    assert.equal(stamped.rows[0]!.id, lineId);
    const row = (await db.execute<{ d: string; c: string }>(sql`
      select source_cleared_date::text as d, source_cleared_connector as c
        from journal_lines where id = ${lineId} and org_id = ${org.orgId}`)).rows[0]!;
    assert.equal(row.d, org.date);
    assert.equal(row.c, "netsuite");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("0236: inserting a line into an inactive account is still refused", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`update accounts set is_active = false where id = ${org.accounts.bank} and org_id = ${org.orgId}`);
    const entryId = await draftEntry(org, "EV-0236-B");
    await assert.rejects(
      insertBalancedPair(org, entryId, org.accounts.bank, org.accounts.revenue),
      (e: unknown) => errorChainMatches(e, /is inactive/),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("0236: an update touching money on a deactivated account's line is still refused", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { lineId } = await postedEntryWithDeactivatedAccount(org, "EV-0236-C");
    await assert.rejects(
      db.execute(sql`update journal_lines set amount = 200, txn_amount = 200 where id = ${lineId} and org_id = ${org.orgId}`),
      // jl_check_account fires before jl_guard: the refusal names the account rule.
      (e: unknown) => errorChainMatches(e, /is inactive|immutable/),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("0236: retargeting a line at an inactive account is still refused", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { entryId } = await postedEntryWithDeactivatedAccount(org, "EV-0236-D");
    const liveLine = (await db.execute<{ id: string }>(sql`
      select id from journal_lines where entry_id = ${entryId} and org_id = ${org.orgId} and line_number = 2`)).rows[0]!.id;
    await assert.rejects(
      db.execute(sql`update journal_lines set account_id = ${org.accounts.bank} where id = ${liveLine} and org_id = ${org.orgId}`),
      (e: unknown) => errorChainMatches(e, /is inactive|immutable/),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("0236: a summary account still refuses posting", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Freight carries no lines, so reclassifying it does not trip the
    // classification guard; the posting guard must still refuse the line.
    await db.execute(sql`update accounts set is_summary = true where id = ${org.accounts.freight} and org_id = ${org.orgId}`);
    const entryId = await draftEntry(org, "EV-0236-E");
    await assert.rejects(
      insertBalancedPair(org, entryId, org.accounts.freight, org.accounts.revenue),
      (e: unknown) => errorChainMatches(e, /summary account/),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("0236: a currency-restricted account still refuses wrong-currency postings", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`update accounts set currency_restriction = 'CAD' where id = ${org.accounts.bank} and org_id = ${org.orgId}`);
    const entryId = await draftEntry(org, "EV-0236-F");
    await assert.rejects(
      insertBalancedPair(org, entryId, org.accounts.bank, org.accounts.revenue, "USD"),
      (e: unknown) => errorChainMatches(e, /only accepts CAD postings/),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("0236: moving already-set cleared evidence is still refused append-only", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { entryId, lineId } = await postedEntryWithDeactivatedAccount(org, "EV-0236-G");
    await mirrorClearedStamp(org, entryId, org.accounts.bank, "netsuite");
    await assert.rejects(
      db.execute(sql`update journal_lines set source_cleared_date = '2026-09-21', source_cleared_connector = 'netsuite' where id = ${lineId} and org_id = ${org.orgId}`),
      (e: unknown) => errorChainMatches(e, /append-only/),
    );
    await assert.rejects(
      db.execute(sql`update journal_lines set source_cleared_connector = 'other' where id = ${lineId} and org_id = ${org.orgId}`),
      (e: unknown) => errorChainMatches(e, /append-only/),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
