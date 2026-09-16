import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

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

async function postLines(
  org: Org,
  entryId: string,
  legs: Array<{ accountId: string; amount: string }>,
): Promise<void> {
  // One multi-row statement: the deferred entry-balance trigger fires at
  // commit, so single-leg inserts are refused mid-construction.
  const values = legs.map(
    (leg, index) =>
      sql`(${org.orgId}, ${entryId}, ${index + 1}, ${leg.accountId}, ${org.subsidiaryId}, ${leg.amount}, 'CAD', ${leg.amount}, '1', '')`,
  );
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
    values ${sql.join(values, sql`, `)}`);
}

async function postBalanced(org: Org, number: string): Promise<string> {
  const entry = await draftEntry(org, number);
  await postLines(org, entry, [
    { accountId: org.accounts.bank, amount: "250.0000" },
    { accountId: org.accounts.revenue, amount: "-250.0000" },
  ]);
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`);
  return entry;
}

async function lineCount(entry: string): Promise<number> {
  const r = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from journal_lines where entry_id = ${entry}`,
  );
  return r.rows[0]!.n;
}

/**
 * Finding 5.1: the journal-line guard evaluates the DESTINATION parent's
 * state but not the ORIGINAL parent's immutability, so moving every line of
 * a posted entry into a draft entry rewrites posted financial evidence while
 * every balance check still passes (both entries balance before and after).
 */
test("moving posted lines into a draft entry is refused", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const posted = await postBalanced(org, "JL-51-A");
    const draft = await draftEntry(org, "JL-51-B");
    await assert.rejects(
      db.execute(sql`update journal_lines set entry_id = ${draft} where entry_id = ${posted}`),
      (error: unknown) => errorChainMatches(error, /lines of a posted journal entry are immutable/),
      "removing lines from a posted entry must raise even when the destination is a draft",
    );
    assert.equal(await lineCount(posted), 2);
    assert.equal(await lineCount(draft), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("moving a draft line into a posted entry is refused", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const posted = await postBalanced(org, "JL-51-C");
    const draft = await draftEntry(org, "JL-51-D");
    await postLines(org, draft, [
      { accountId: org.accounts.bank, amount: "10.0000" },
      { accountId: org.accounts.revenue, amount: "-10.0000" },
    ]);
    await assert.rejects(
      db.execute(sql`update journal_lines set entry_id = ${posted} where entry_id = ${draft}`),
      (error: unknown) => errorChainMatches(error, /lines of a posted journal entry are immutable/),
      "appending lines to a posted entry must raise even when the source is a draft",
    );
    assert.equal(await lineCount(posted), 2);
    assert.equal(await lineCount(draft), 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("moving lines between draft entries stays allowed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const first = await draftEntry(org, "JL-51-E");
    const second = await draftEntry(org, "JL-51-F");
    await postLines(org, first, [
      { accountId: org.accounts.bank, amount: "10.0000" },
      { accountId: org.accounts.revenue, amount: "-10.0000" },
    ]);
    await db.execute(sql`update journal_lines set entry_id = ${second} where entry_id = ${first}`);
    assert.equal(await lineCount(first), 0);
    assert.equal(await lineCount(second), 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("retargeting a posted line at another tenant's entry raises a foreign-key error", { skip: !DB }, async () => {
  const owner = await createScratchOrg();
  const foreign = await createScratchOrg();
  try {
    const posted = await postBalanced(owner, "JL-51-G");
    const foreignDraft = await draftEntry(foreign, "JL-51-H");
    await assert.rejects(
      db.execute(sql`update journal_lines set entry_id = ${foreignDraft} where entry_id = ${posted}`),
      (error: unknown) => errorChainMatches(error, /does not exist in organization|immutable/),
      "a line may never reference another tenant's entry",
    );
  } finally {
    await dropScratchOrg(foreign.orgId);
    await dropScratchOrg(owner.orgId);
  }
});

/**
 * Source-contract pin: the 0158 rewrite once dropped the 0038 tenant lookup
 * and every fresh bootstrap went red. This test fails if a future rewrite of
 * jl_guard() drops the tenant-coherent lookup, the old-parent immutability
 * branch, or the source-cleared evidence rule.
 */
test("jl_guard source contract pins every inherited check", { skip: !DB }, async () => {
  const r = await db.execute<{ definition: string }>(
    sql`select pg_get_functiondef('public.jl_guard()'::regprocedure) as definition`,
  );
  const body = r.rows[0]!.definition;
  assert.match(body, /where id = v_entry and org_id = v_line_org/, "tenant-coherent parent lookup");
  assert.match(body, /journal entry % does not exist in organization %/, "23503 tenant-coherence error");
  assert.match(body, /old\.entry_id/, "original-parent lookup on UPDATE/DELETE");
  assert.match(body, /lines of a % journal entry are immutable/, "posted-immutability branch");
  assert.match(body, /journal-line reconciliation evidence is append-only/, "evidence append-only rule");
  assert.match(body, /source_cleared_date/, "source-cleared evidence rule");
});
