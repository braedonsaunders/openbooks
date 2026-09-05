import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from './db.ts';
import { add } from './money.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from './test-fixtures.ts';
import { buildRecognitionSchedule, recordRecognitionEvent, runRevenueRecognition } from './revenue-recognition.ts';

const enabled = !!process.env.OPENBOOKS_DB_URL;

async function seedObligation(org: ScratchOrg, method = 'milestone', forecast = false, subsidiaryId?: string) {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const ruleId = randomUUID(), contractId = randomUUID(), obligationId = randomUUID();
  let projectId: string | null = null;
  if (subsidiaryId) {
    projectId = randomUUID();
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id)
      values (${projectId}, ${org.orgId}, ${subsidiaryId}, ${projectId}, 'Entity contract', ${org.customerId})`);
  }
  await db.execute(sql`insert into recognition_rules
    (id, org_id, code, name, method, is_forecast, recognition_periods, deferred_account_id, recognized_account_id)
    values (${ruleId}, ${org.orgId}, ${ruleId}, 'Event control', ${method}, ${forecast}, 1, ${org.accounts.deferred}, ${org.accounts.recognized})`);
  await db.execute(sql`insert into revenue_contracts
    (id, org_id, customer_id, project_id, contract_number, status, starts_on, currency, total_transaction_price, created_by, updated_by)
    values (${contractId}, ${org.orgId}, ${org.customerId}, ${projectId}, ${contractId}, 'active', ${org.date}, 'CAD', '1000', ${actorId}, ${actorId})`);
  await db.execute(sql`insert into performance_obligations
    (id, org_id, contract_id, description, recognition_rule_id, booked_amount, allocated_price, recognition_starts_on, created_by, updated_by)
    values (${obligationId}, ${org.orgId}, ${contractId}, 'Private deliverable', ${ruleId}, '1000', '1000', ${org.date}, ${actorId}, ${actorId})`);
  const endsOn = (await db.execute<{ ends_on: string }>(sql`select ends_on from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`)).rows[0]!.ends_on;
  return { obligationId, orgId: org.orgId, actorId, periodMonth: `${org.date.slice(0, 7)}-01`, endsOn };
}

async function postedLines(orgId: string, obligationId: string) {
  return (await db.execute<{ id: string; planned_amount: string; journal_entry_id: string; book_id: string }>(sql`
    select l.id, l.planned_amount, l.journal_entry_id, s.book_id
      from recognition_schedule_lines l join recognition_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
     where l.org_id=${orgId} and s.obligation_id=${obligationId} and l.journal_entry_id is not null
     order by l.id`)).rows;
}

for (const method of ['milestone', 'usage']) {
  test(`${method}: same-period additions and corrections recognize exactly once across books`, { skip: !enabled }, async () => {
    const org = await createScratchOrg();
    try {
      const input = await seedObligation(org, method);
      const secondBook = randomUUID();
      await db.execute(sql`insert into accounting_books (id,org_id,code,name,is_primary,is_active,posts_gl)
        values (${secondBook},${org.orgId},'SECOND','Second book',false,true,true)`);
      await recordRecognitionEvent({ ...input, amount: '400', sourceReference: 'first' });
      const first = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
      assert.deepEqual(first.problems, []);
      assert.equal(first.posted, 2);
      assert.equal((await db.execute<{ status: string }>(sql`select status from performance_obligations where org_id=${org.orgId} and id=${input.obligationId}`)).rows[0]!.status, 'open', 'recognizing only part of the allocated price does not satisfy the obligation');
      const history = await postedLines(org.orgId, input.obligationId);
      await recordRecognitionEvent({ ...input, amount: '600', sourceReference: 'second' });
      const second = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
      assert.deepEqual(second.problems, []);
      assert.equal(second.posted, 2, 'new evidence in a posted period must still recognize');
      assert.equal(second.totalAmount, '1200.0000');
      await recordRecognitionEvent({ ...input, amount: '-100', sourceReference: 'correction' });
      const correction = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
      assert.equal(correction.posted, 2);
      assert.equal(correction.totalAmount, '-200.0000');
      assert.deepEqual((await postedLines(org.orgId, input.obligationId)).filter(line => history.some(old => old.id === line.id)), history);
      for (const bookId of [org.bookId, secondBook]) {
        const total = (await postedLines(org.orgId, input.obligationId)).filter(line => line.book_id === bookId).reduce((sum,line) => add(sum,line.planned_amount), '0');
        assert.equal(total, '900.0000');
      }
      await buildRecognitionSchedule(input.obligationId, org.orgId, input.actorId);
      assert.equal((await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId)).posted, 0);
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test('concurrent distinct recognition events preserve both pending amounts', { skip: !enabled }, async () => {
  const org = await createScratchOrg();
  try {
    const input = await seedObligation(org);
    await Promise.all([
      recordRecognitionEvent({ ...input, amount: '400', sourceReference: 'concurrent-a' }),
      recordRecognitionEvent({ ...input, amount: '600', sourceReference: 'concurrent-b' }),
    ]);
    const run = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
    assert.deepEqual(run.problems, []);
    assert.equal(run.totalAmount, '1000.0000');
    assert.equal((await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId)).posted, 0);
  } finally { await dropScratchOrg(org.orgId); }
});

for (const allowed of ['empty', 'other entity'] as const) {
  test(`recognition ${allowed} scope cannot disclose or update hidden obligations`, { skip: !enabled }, async () => {
    const org = await createScratchOrg();
    try {
      const hidden = randomUUID();
      await db.execute(sql`insert into subsidiaries (id,org_id,parent_id,name,base_currency,country)
        values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`);
      const input = await seedObligation(org, 'milestone', false, hidden);
      await buildRecognitionSchedule(input.obligationId, org.orgId, input.actorId);
      const run = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, undefined, allowed === 'empty' ? [] : [org.subsidiaryId]);
      assert.deepEqual(run.problems, [], 'hidden empty milestone names must not leak');
      const status = (await db.execute<{ status: string }>(sql`select status from recognition_schedules where org_id=${org.orgId} and obligation_id=${input.obligationId}`)).rows[0]!.status;
      assert.equal(status, 'planned', 'hidden schedule lifecycle must remain untouched');
      assert.ok((await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId)).problems.some(p => p.includes('no recognition events')));
      await db.execute(sql`update recognition_rules set method='point_in_time' where org_id=${org.orgId}`);
      await db.execute(sql`update performance_obligations set allocated_price='0' where org_id=${org.orgId} and id=${input.obligationId}`);
      await buildRecognitionSchedule(input.obligationId, org.orgId, input.actorId);
      await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId, allowed === 'empty' ? [] : [org.subsidiaryId]);
      assert.equal((await db.execute<{ status: string }>(sql`select status from performance_obligations where org_id=${org.orgId} and id=${input.obligationId}`)).rows[0]!.status, 'open');
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test('forecast recognition rules never post to the ledger', { skip: !enabled }, async () => {
  const org = await createScratchOrg();
  try {
    const input = await seedObligation(org, 'point_in_time', true);
    await buildRecognitionSchedule(input.obligationId, org.orgId, input.actorId);
    const run = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
    assert.equal(run.posted, 0);
    assert.equal((await postedLines(org.orgId, input.obligationId)).length, 0);
    const status = (await db.execute<{ status: string }>(sql`select status from performance_obligations where org_id=${org.orgId} and id=${input.obligationId}`)).rows[0]!.status;
    assert.equal(status, 'open');
  } finally { await dropScratchOrg(org.orgId); }
});

test('cancelled obligations refuse additional recognition events and schedule rebuilds', { skip: !enabled }, async () => {
  const org = await createScratchOrg();
  try {
    const input = await seedObligation(org);
    await db.execute(sql`update performance_obligations set status='cancelled', cancellation_reason='Contract ended', cancelled_at=now(), cancelled_by=${input.actorId} where org_id=${org.orgId} and id=${input.obligationId}`);
    await assert.rejects(recordRecognitionEvent({ ...input, amount: '1000', sourceReference: 'after-cancellation' }), /cancelled/);
    await assert.rejects(buildRecognitionSchedule(input.obligationId, org.orgId, input.actorId), /cancelled/);
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from recognition_events where org_id=${org.orgId} and obligation_id=${input.obligationId}`)).rows[0]!.n, 0);
  } finally { await dropScratchOrg(org.orgId); }
});

test('event arrival and recognition posting share an obligation lock', { skip: !enabled }, async () => {
  const org = await createScratchOrg();
  try {
    const input = await seedObligation(org);
    await recordRecognitionEvent({ ...input, amount: '400', sourceReference: 'initial' });
    await Promise.all([
      runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId),
      recordRecognitionEvent({ ...input, amount: '600', sourceReference: 'arriving' }),
    ]);
    const run = await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId);
    assert.deepEqual(run.problems, []);
    assert.equal((await postedLines(org.orgId, input.obligationId)).reduce((sum, row) => add(sum, row.planned_amount), '0'), '1000.0000');
    assert.equal((await runRevenueRecognition(org.orgId, input.endsOn, input.actorId, input.obligationId)).posted, 0);
  } finally { await dropScratchOrg(org.orgId); }
});

test('recognition event amounts retain exact persisted precision on first write and replay', { skip: !enabled }, async () => {
  const org = await createScratchOrg();
  try {
    const input = await seedObligation(org, 'usage');
    for (const field of ['amount', 'unitRate', 'quantity'] as const) {
      for (const value of ['1.00001', 'NaN', 'Infinity', '1000000000000000']) {
        await assert.rejects(recordRecognitionEvent({ ...input, amount: '100', sourceReference: `${field}:${value}`, [field]: value }), /decimal|precision/);
      }
    }
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from recognition_events where org_id=${org.orgId}`)).rows[0]!.n, 0);
    const event = { ...input, amount: '100.1234', unitRate: '0.1234', quantity: '1', sourceReference: 'exact' };
    const first = await recordRecognitionEvent(event);
    assert.deepEqual(await recordRecognitionEvent(event), first);
  } finally { await dropScratchOrg(org.orgId); }
});
