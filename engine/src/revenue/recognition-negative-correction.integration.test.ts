import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '../testing/fixtures.ts';
import { recordRecognitionEvent, runRevenueRecognition } from './recognition.ts';

const enabled = !!process.env.OPENBOOKS_DB_URL;

/**
 * Over-large negative milestone/usage corrections must never drive cumulative
 * net earned negative: +400 recognized then a −500 correction posted net −100.
 *
 * Rule pinned here: a negative plan line is a correction reversing earned
 * revenue, so per book it can reverse at most what that book has earned —
 *   net(book) + planned >= 0,
 * where net(book) counts posted lines net of historical reversals (the same
 * canonical predicate as the unearned-remaining helper and the schedule
 * rebuild). An offending correction is held unposted with a problems[] entry
 * naming the remedy — never floored at zero, which would silently drop the
 * operator's evidence. The plan line and its event stay in place; the
 * operator corrects by recording an offsetting event (events are additive, so
 * the offset replans the held line into a valid correction on rebuild).
 */

async function seedObligation(org: ScratchOrg, method = 'milestone') {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const ruleId = randomUUID(), contractId = randomUUID(), obligationId = randomUUID();
  await db.execute(sql`insert into recognition_rules
    (id, org_id, code, name, method, is_forecast, recognition_periods, deferred_account_id, recognized_account_id)
    values (${ruleId}, ${org.orgId}, ${ruleId}, 'Negative correction control', ${method}, false, 1, ${org.accounts.deferred}, ${org.accounts.recognized})`);
  await db.execute(sql`insert into revenue_contracts
    (id, org_id, customer_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
    values (${contractId}, ${org.orgId}, ${org.customerId}, ${contractId}, 'active', ${org.date}, 'CAD', '1000', ${actorId}, ${actorId})`);
  await db.execute(sql`insert into performance_obligations
    (id, org_id, contract_id, description, recognition_rule_id, booked_amount, allocated_price, recognition_starts_on, created_by, updated_by)
    values (${obligationId}, ${org.orgId}, ${contractId}, 'Milestone deliverable', ${ruleId}, '1000', '1000', ${org.date}, ${actorId}, ${actorId})`);
  const endsOn = (await db.execute<{ ends_on: string }>(sql`select ends_on from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`)).rows[0]!.ends_on;
  return { obligationId, orgId: org.orgId, actorId, periodMonth: `${org.date.slice(0, 7)}-01`, endsOn };
}

async function netRecognized(orgId: string, obligationId: string, bookId: string): Promise<string> {
  const row = (await db.execute<{ net: string }>(sql`
    select coalesce((select sum(case when l.journal_entry_id is not null and l.reversal_journal_entry_id is null then coalesce(l.recognized_amount,0) else 0 end)
      from recognition_schedule_lines l
      join recognition_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
     where l.org_id=${orgId} and s.obligation_id=${obligationId} and s.book_id=${bookId}),0)::text as net`)).rows[0]!;
  return row.net;
}

async function unpostedNegativeLines(orgId: string, obligationId: string) {
  return (await db.execute<{ id: string; planned_amount: string }>(sql`
    select l.id, l.planned_amount
      from recognition_schedule_lines l
      join recognition_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
     where l.org_id=${orgId} and s.obligation_id=${obligationId}
       and l.journal_entry_id is null and l.planned_amount::numeric < 0`)).rows;
}

async function glBalance(orgId: string, accountId: string): Promise<string> {
  const r = await db.execute<{ balance: string }>(sql`
    select coalesce(sum(line.amount), 0)::text as balance
      from journal_lines line
      join journal_entries entry on entry.id = line.entry_id
     where line.org_id = ${orgId}
       and line.account_id = ${accountId}
       and entry.status = 'posted'`);
  return r.rows[0]!.balance;
}

for (const method of ['milestone', 'usage']) {
  test(`${method}: an over-large correction is held unposted with its evidence preserved`, { skip: !enabled }, async () => {
    const org = await createScratchOrg();
    try {
      const input = await seedObligation(org, method);
      await recordRecognitionEvent({ ...input, amount: '400', sourceReference: 'milestone-1' });
      const first = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
      assert.equal(first.posted, 1);
      assert.equal(await netRecognized(org.orgId, input.obligationId, org.bookId), '400.0000');

      // Auditor case: −500 against 400 earned would post net −100.
      await recordRecognitionEvent({ ...input, amount: '-500', sourceReference: 'correction-oversized' });
      const held = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
      assert.equal(held.posted, 0);
      assert.equal(held.skipped, 1);
      assert.equal(held.problems.length, 1);
      assert.match(held.problems[0]!, /correction of -500.*exceeds the 400.*recognized to date/);
      assert.match(held.problems[0]!, /held unposted/);
      assert.match(held.problems[0]!, /record an offsetting recognition event for the excess/);

      // Nothing posted, nothing floored away: net, ledger, and plan evidence unchanged.
      assert.equal(await netRecognized(org.orgId, input.obligationId, org.bookId), '400.0000');
      assert.equal(await glBalance(org.orgId, org.accounts.recognized), '-400.0000');
      const heldLines = await unpostedNegativeLines(org.orgId, input.obligationId);
      assert.equal(heldLines.length, 1);
      assert.equal(heldLines[0]!.planned_amount, '-500.0000');

      // Replay changes nothing: same refusal, still no posting.
      const replay = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
      assert.equal(replay.posted, 0);
      assert.deepEqual(replay.problems, held.problems);
      assert.equal(await netRecognized(org.orgId, input.obligationId, org.bookId), '400.0000');
      assert.equal(await glBalance(org.orgId, org.accounts.recognized), '-400.0000');
    } finally { await dropScratchOrg(org.orgId); }
  });

  test(`${method}: a smaller legitimate correction still posts`, { skip: !enabled }, async () => {
    const org = await createScratchOrg();
    try {
      const input = await seedObligation(org, method);
      await recordRecognitionEvent({ ...input, amount: '400', sourceReference: 'milestone-1' });
      await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
      await recordRecognitionEvent({ ...input, amount: '-100', sourceReference: 'correction-legit' });
      const correction = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
      assert.equal(correction.posted, 1);
      assert.equal(correction.totalAmount, '-100.0000');
      assert.deepEqual(correction.problems, []);
      assert.equal(await netRecognized(org.orgId, input.obligationId, org.bookId), '300.0000');
      assert.equal(await glBalance(org.orgId, org.accounts.recognized), '-300.0000');
    } finally { await dropScratchOrg(org.orgId); }
  });

  test(`${method}: an exhausted unearned remainder does not block a valid negative`, { skip: !enabled }, async () => {
    const org = await createScratchOrg();
    try {
      const input = await seedObligation(org, method);
      await recordRecognitionEvent({ ...input, amount: '400', sourceReference: 'milestone-1' });
      await recordRecognitionEvent({ ...input, amount: '600', sourceReference: 'milestone-2' });
      const full = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
      assert.equal(full.totalAmount, '1000.0000');
      // All 1000 allocated is earned, so the unearned cap is exhausted — a
      // −100 correction must still post (the cap constrains positives only).
      await recordRecognitionEvent({ ...input, amount: '-100', sourceReference: 'correction-after-full' });
      const correction = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
      assert.equal(correction.posted, 1);
      assert.equal(correction.totalAmount, '-100.0000');
      assert.equal(await netRecognized(org.orgId, input.obligationId, org.bookId), '900.0000');
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test('a historical reversal lowers the book net the next correction is measured against', { skip: !enabled }, async () => {
  const org = await createScratchOrg();
  try {
    const input = await seedObligation(org, 'milestone');
    const secondBook = randomUUID();
    await db.execute(sql`insert into accounting_books (id,org_id,code,name,is_primary,is_active,posts_gl)
      values (${secondBook},${org.orgId},'SECOND','Second book',false,true,true)`);
    await recordRecognitionEvent({ ...input, amount: '400', sourceReference: 'milestone-1' });
    const first = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
    assert.equal(first.posted, 2);

    // A −300 correction plans on both books; before posting, a historical
    // reversal of the primary book's +400 lands (same marker the cancellation
    // flow writes). Per-book nets now diverge: primary 0, second 400.
    await recordRecognitionEvent({ ...input, amount: '-300', sourceReference: 'correction-split' });
    // A historical reversal of the primary book's +400 lands before posting,
    // written exactly the way the cancellation flow writes one: a posted
    // compensating entry linked from the schedule line.
    const primaryPosted = (await db.execute<{ id: string; journal_entry_id: string }>(sql`
      select l.id, l.journal_entry_id from recognition_schedule_lines l
        join recognition_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
       where l.org_id=${org.orgId} and s.obligation_id=${input.obligationId} and s.book_id=${org.bookId}
         and l.journal_entry_id is not null`)).rows[0]!;
    const source = (await db.execute<{ book_id: string; subsidiary_id: string; posting_date: string; period_id: string; entry_number: string }>(sql`
      select book_id, subsidiary_id, posting_date::text, period_id, entry_number from journal_entries
       where id = ${primaryPosted.journal_entry_id} and org_id = ${org.orgId}`)).rows[0]!;
    const reversalId = randomUUID();
    await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, reverses_entry_id, created_by, updated_by)
      values (${reversalId}, ${org.orgId}, ${source.book_id}, ${source.subsidiary_id},
              ${`${source.entry_number}-REV-TEST`}, ${source.posting_date}, ${source.period_id},
              'Historical reversal of milestone recognition', 'draft', 'revenue_recognition',
              ${primaryPosted.journal_entry_id}, ${input.actorId}, ${input.actorId})`);
    await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
      select org_id, ${reversalId}, line_number, account_id, subsidiary_id,
             -amount, currency, -txn_amount, fx_rate, 'Historical reversal of milestone recognition'
        from journal_lines where entry_id = ${primaryPosted.journal_entry_id} and org_id = ${org.orgId}
       order by line_number`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${input.actorId}
     where id = ${reversalId} and org_id = ${org.orgId}`);
    await db.execute(sql`update journal_entries set status = 'reversed', updated_at = now(), updated_by = ${input.actorId}
     where id = ${primaryPosted.journal_entry_id} and org_id = ${org.orgId}`);
    await db.execute(sql`update recognition_schedule_lines
       set reversal_journal_entry_id = ${reversalId}, updated_at = now(), updated_by = ${input.actorId}
     where id = ${primaryPosted.id} and org_id = ${org.orgId}`);
    assert.equal(await netRecognized(org.orgId, input.obligationId, org.bookId), '0');
    assert.equal(await netRecognized(org.orgId, input.obligationId, secondBook), '400.0000');

    const run = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
    assert.equal(run.posted, 1);
    assert.equal(run.totalAmount, '-300.0000');
    assert.equal(run.skipped, 1);
    assert.equal(run.problems.length, 1);
    assert.match(run.problems[0]!, /record an offsetting recognition event for the excess/);
    // Second book earned 400, so −300 posts there (net 100); the reversed
    // primary book earned nothing net, so its −300 is held whole — not floored.
    assert.equal(await netRecognized(org.orgId, input.obligationId, secondBook), '100.0000');
    assert.equal(await netRecognized(org.orgId, input.obligationId, org.bookId), '0');
    const heldLines = await unpostedNegativeLines(org.orgId, input.obligationId);
    assert.equal(heldLines.length, 1);
    assert.equal(heldLines[0]!.planned_amount, '-300.0000');
  } finally { await dropScratchOrg(org.orgId); }
});

test('an offsetting event replans the held correction into a valid posting end to end', { skip: !enabled }, async () => {
  const org = await createScratchOrg();
  try {
    const input = await seedObligation(org, 'milestone');
    await recordRecognitionEvent({ ...input, amount: '400', sourceReference: 'milestone-1' });
    await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
    await recordRecognitionEvent({ ...input, amount: '-500', sourceReference: 'correction-oversized' });
    const held = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
    assert.equal(held.posted, 0);
    assert.equal((await unpostedNegativeLines(org.orgId, input.obligationId)).length, 1);

    // The remedy from the problems[] message, through production calls only:
    // events are additive, so the operator records a +200 offset for the
    // excess. The rebuild deletes the held −500 line and replans the period
    // total (+100) less posted (+400) as a −300 line, which is within the
    // recognized balance and posts.
    await recordRecognitionEvent({ ...input, amount: '200', sourceReference: 'correction-offset' });
    const replanned = await unpostedNegativeLines(org.orgId, input.obligationId);
    assert.equal(replanned.length, 1);
    assert.equal(replanned[0]!.planned_amount, '-300.0000');
    const fixed = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
    assert.equal(fixed.posted, 1);
    assert.equal(fixed.totalAmount, '-300.0000');
    assert.deepEqual(fixed.problems, []);

    // Full balances: 400 earned, 300 reversed, 100 net earned remains.
    assert.equal(await netRecognized(org.orgId, input.obligationId, org.bookId), '100.0000');
    assert.equal(await glBalance(org.orgId, org.accounts.recognized), '-100.0000');
    assert.equal(await glBalance(org.orgId, org.accounts.deferred), '100.0000');
    assert.equal((await unpostedNegativeLines(org.orgId, input.obligationId)).length, 0);
  } finally { await dropScratchOrg(org.orgId); }
});
