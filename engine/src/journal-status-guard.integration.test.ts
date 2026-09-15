import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

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

/**
 * The kernel guard's documented contract (0002_kernel_hardening) is that
 * je_guard() rejects ANY update to a posted or reversed entry — posted
 * history is immutable except through controlled reversal (posted→reversed,
 * which the void/correction flows rely on) and the engine's same-status
 * amend path. A posted→draft regression must therefore raise: otherwise a
 * posted entry can be silently suppressed from every posted-only reader
 * (trial balance, statements, registers, partner snapshot) while its
 * document and cached open balance keep reporting it, with no audit trace.
 */

async function postBalanced(org: ScratchOrg, memo: string): Promise<string> {
  const entry = randomUUID();
  const num = `GUARD-${memo}-${entry.slice(0, 6)}`;
  await db.execute(sql`insert into journal_entries
    (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${num}, ${org.date}, ${org.periodId}, ${num}, 'draft', 'manual')`);
  await db.execute(sql`insert into journal_lines
    (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
    values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, '250.0000', 'CAD', '250.0000', '1', ${num}),
           (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, '-250.0000', 'CAD', '-250.0000', '1', ${num})`);
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`);
  return entry;
}

async function statusOf(entry: string): Promise<string> {
  const r = await db.execute<{ status: string }>(sql`select status from journal_entries where id = ${entry}`);
  return r.rows[0]!.status;
}

async function fixture(work: (org: ScratchOrg) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    await work(org);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

test("posted entry cannot regress to draft", { skip: !DB }, async () =>
  fixture(async (org) => {
    const entry = await postBalanced(org, "A");
    await assert.rejects(
      db.execute(sql`update journal_entries set status = 'draft' where id = ${entry}`),
      (error: unknown) => errorChainMatches(error, /immutable|posted/),
      "posted→draft must raise: posted history is immutable except through controlled reversal",
    );
    assert.equal(await statusOf(entry), "posted");
  }));

test("controlled reversal posted→reversed stays allowed", { skip: !DB }, async () =>
  fixture(async (org) => {
    const entry = await postBalanced(org, "B");
    await db.execute(sql`update journal_entries set status = 'reversed' where id = ${entry}`);
    assert.equal(await statusOf(entry), "reversed");
  }));

test("reversed entry accepts no further transition", { skip: !DB }, async () =>
  fixture(async (org) => {
    const entry = await postBalanced(org, "C");
    await db.execute(sql`update journal_entries set status = 'reversed' where id = ${entry}`);
    await assert.rejects(
      db.execute(sql`update journal_entries set status = 'draft' where id = ${entry}`),
      (error: unknown) => errorChainMatches(error, /immutable|reversed/),
    );
    assert.equal(await statusOf(entry), "reversed");
  }));

test("draft lifecycle still works: header edit then post", { skip: !DB }, async () =>
  fixture(async (org) => {
    const entry = randomUUID();
    await db.execute(sql`insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'GUARD-D1', ${org.date}, ${org.periodId}, 'before', 'draft', 'manual')`);
    await db.execute(sql`insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, '10.0000', 'CAD', '10.0000', '1', 'x'),
             (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, '-10.0000', 'CAD', '-10.0000', '1', 'x')`);
    await db.execute(sql`update journal_entries set memo = 'after' where id = ${entry}`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`);
    assert.equal(await statusOf(entry), "posted");
  }));
