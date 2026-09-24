import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

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

function negDecimal(value: string): string {
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

type MirrorLine = {
  line_number: number;
  account_id: string;
  subsidiary_id: string;
  amount: string;
  currency: string;
  txn_amount: string;
  fx_rate: string;
  party_id: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  equipment_unit_id: string | null;
  payment_card_id: string | null;
  tax_code_id: string | null;
  extra_dims: string;
  quantity: string | null;
};

/**
 * Post a reversal entry for `original` the way every engine flow does:
 * draft entry with reverses_entry_id, mirror-negated lines, then posted.
 * Options let negative tests build deficient evidence (draft, wrong book,
 * non-mirroring amounts).
 */
async function postMirrorReversal(
  org: ScratchOrg,
  original: string,
  suffix: string,
  opts: { bookId?: string; post?: boolean; negate?: boolean } = {},
): Promise<string> {
  const reversal = randomUUID();
  const num = `GUARD-REV-${suffix}-${reversal.slice(0, 6)}`;
  await db.execute(sql`insert into journal_entries
    (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, reverses_entry_id)
    values (${reversal}, ${org.orgId}, ${opts.bookId ?? org.bookId}, ${org.subsidiaryId}, ${num}, ${org.date}, ${org.periodId}, ${num}, 'draft', 'manual', ${original})`);
  const src = (await db.execute<MirrorLine>(sql`
    select line_number, account_id, subsidiary_id, amount::text as amount, currency,
           txn_amount::text as txn_amount, fx_rate::text as fx_rate, party_id, department_id,
           project_id, location_id, class_id, equipment_unit_id, payment_card_id, tax_code_id,
           extra_dims::text as extra_dims, quantity::text as quantity
      from journal_lines where entry_id = ${original} and org_id = ${org.orgId} order by line_number`)).rows;
  const legs = src.map(
    (row) => sql`(${org.orgId}, ${reversal}, ${row.line_number}, ${row.account_id}, ${row.subsidiary_id},
      ${opts.negate === false ? row.amount : negDecimal(row.amount)}, ${row.currency},
      ${opts.negate === false ? row.txn_amount : negDecimal(row.txn_amount)}, ${row.fx_rate},
      '', ${row.party_id}, ${row.department_id}, ${row.project_id}, ${row.location_id},
      ${row.class_id}, ${row.equipment_unit_id}, ${row.payment_card_id}, ${row.tax_code_id},
      ${row.extra_dims}::jsonb, ${row.quantity == null ? null : negDecimal(row.quantity)}, '{}'::jsonb)`,
  );
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
       memo, party_id, department_id, project_id, location_id, class_id, equipment_unit_id,
       payment_card_id, tax_code_id, extra_dims, quantity, custom)
    values ${sql.join(legs, sql`, `)}`);
  if (opts.post !== false) {
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${reversal}`);
  }
  return reversal;
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
    await postMirrorReversal(org, entry, "B");
    await db.execute(sql`update journal_entries set status = 'reversed' where id = ${entry}`);
    assert.equal(await statusOf(entry), "reversed");
  }));

/**
 * Finding 5.2: the header guard let posted→reversed through with no
 * supporting reversal evidence and no freeze on accompanying economic
 * changes, while the shared reversal helper preserves dimensions and
 * negates amounts. The flip must retire history, never restate it.
 */
test("posted→reversed without reversal evidence is refused", { skip: !DB }, async () =>
  fixture(async (org) => {
    const entry = await postBalanced(org, "R1");
    await assert.rejects(
      db.execute(sql`update journal_entries set status = 'reversed' where id = ${entry}`),
      (error: unknown) => errorChainMatches(error, /without a posted mirror reversal|can only be reversed/),
      "a bare flip with no reversal entry must raise",
    );
    assert.equal(await statusOf(entry), "posted");
  }));

test("posted→reversed with a draft reversal is refused", { skip: !DB }, async () =>
  fixture(async (org) => {
    const entry = await postBalanced(org, "R2");
    await postMirrorReversal(org, entry, "R2", { post: false });
    await assert.rejects(
      db.execute(sql`update journal_entries set status = 'reversed' where id = ${entry}`),
      (error: unknown) => errorChainMatches(error, /without a posted mirror reversal/),
      "an unposted reversal entry is not evidence",
    );
    assert.equal(await statusOf(entry), "posted");
  }));

test("posted→reversed with a non-mirroring reversal is refused", { skip: !DB }, async () =>
  fixture(async (org) => {
    const entry = await postBalanced(org, "R3");
    await postMirrorReversal(org, entry, "R3", { negate: false });
    await assert.rejects(
      db.execute(sql`update journal_entries set status = 'reversed' where id = ${entry}`),
      (error: unknown) => errorChainMatches(error, /without a posted mirror reversal/),
      "a posted entry that does not negate the original is not a reversal",
    );
    assert.equal(await statusOf(entry), "posted");
  }));

test("posted→reversed with an economic header change is refused", { skip: !DB }, async () =>
  fixture(async (org) => {
    const entry = await postBalanced(org, "R4");
    await postMirrorReversal(org, entry, "R4");
    await assert.rejects(
      db.execute(sql`update journal_entries set status = 'reversed', memo = 'restated' where id = ${entry}`),
      (error: unknown) => errorChainMatches(error, /without other changes/),
      "no economic header change may accompany the status flip",
    );
    assert.equal(await statusOf(entry), "posted");
  }));

test("posted→reversed evidenced by another book's reversal is refused", { skip: !DB }, async () =>
  fixture(async (org) => {
    const entry = await postBalanced(org, "R5");
    const otherBook = randomUUID();
    await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values(${otherBook},${org.orgId},'TAX','Tax',false,true,true)`);
    await postMirrorReversal(org, entry, "R5", { bookId: otherBook });
    await assert.rejects(
      db.execute(sql`update journal_entries set status = 'reversed' where id = ${entry}`),
      (error: unknown) => errorChainMatches(error, /without a posted mirror reversal/),
      "the reversal must live in the same book as the original",
    );
    assert.equal(await statusOf(entry), "posted");
  }));

test("reversed entry accepts no further transition", { skip: !DB }, async () =>
  fixture(async (org) => {
    const entry = await postBalanced(org, "C");
    await postMirrorReversal(org, entry, "C");
    await db.execute(sql`update journal_entries set status = 'reversed' where id = ${entry}`);
    await assert.rejects(
      db.execute(sql`update journal_entries set status = 'draft' where id = ${entry}`),
      (error: unknown) => errorChainMatches(error, /immutable|reversed/),
    );
    assert.equal(await statusOf(entry), "reversed");
  }));

/**
 * Source-contract pin: every je_guard() branch is marked by name so no
 * future rewrite can silently drop one. The draft-post block interior
 * belongs to f2/0168 (source-module recheck) and is pinned only by its
 * marker and its period fence, not by contents this shard does not own.
 */
test("je_guard source contract pins every branch by name", { skip: !DB }, async () =>
  fixture(async () => {
    const r = await db.execute<{ definition: string }>(
      sql`select pg_get_functiondef('public.je_guard()'::regprocedure) as definition`,
    );
    const body = r.rows[0]!.definition;
    assert.match(body, /Branch: journal-entry-delete/, "delete fence branch");
    assert.match(body, /Branch: same-status-amend/, "amend branch");
    assert.match(body, /Branch: posted-immutability/, "posted-immutability branch");
    assert.match(body, /Branch: reversal-evidence/, "reversal-evidence branch");
    assert.match(body, /Branch: reversed-immutable/, "reversed-immutability branch");
    assert.match(body, /Branch: draft-post/, "draft-post branch");
    assert.match(body, /openbooks_reversal_mirrors/, "mirror predicate");
    assert.match(body, /without other changes/, "header-freeze rule");
    assert.match(body, /period_posting_fence/, "period fence");
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

test("amend-delete in a soft_closed period is refused like an amend-update", { skip: !DB }, async () => {
  // G5: the DELETE branch fenced with period_module_is_closed (true only
  // for state = 'closed') while the sibling amend-UPDATE branch uses the
  // soft-close-aware period_module_blocks_write, so an amend-delete in a
  // soft_closed period went through. Both branches must refuse.
  await fixture(async (org) => {
    const entry = await postBalanced(org, "GUARD-DEL-SOFT");
    await db.execute(sql`insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, reason)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'gl', 'soft_closed', 'G5 regression probe')`);
    // The entry delete is attempted with its lines still attached: the
    // BEFORE-trigger fence must fire before the line back-reference is
    // ever consulted. Pre-fix the fence let it through and the delete died
    // on the foreign key instead.
    await assert.rejects(
      withOrgTransaction(org.orgId, async () => {
        await db.execute(sql`select set_config('openbooks.amend', 'on', true)`);
        await db.execute(sql`delete from journal_entries where id = ${entry}`);
      }),
      (error: unknown) => errorChainMatches(error, /period is closed for GL posting/),
    );
    assert.equal(await statusOf(entry), "posted");
  });
});
