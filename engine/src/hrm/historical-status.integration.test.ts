import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { DB, gateOf, seedEmployment, seedFlow, seedPlan, seedWindow, seededContributionTerms, setupHarness, withHarness } from '../testing/hrm-harness.ts';
import { createChangeRequestDraft, getChangeRequest, submitChangeRequest } from './change-requests.ts';
import { electEnrollment } from './benefits/enrollments.ts';
import { decideGate } from '../flows/gates.ts';
import { installEngineSeams } from '../composition/install.ts';

installEngineSeams();
const SPEC = { users: [
  { key: 'author', name: 'Status Author', handle: 'status_author', permissions: ['hrm.employment.read', 'hrm.employment.manage', 'hrm.benefits.manage'], link: true },
  { key: 'approver', name: 'Status Approver', handle: 'status_approver', permissions: ['hrm.employment.read', 'hrm.employment.approve'], link: true },
  { key: 'outsider', name: 'Status Reader', handle: 'status_reader', permissions: ['hrm.employment.read'], link: true },
] } as const;
const observation = { kind: 'status_change', status: 'active', effectiveFrom: '2020-01-03', effectiveTo: '2020-01-04',
  historicalObservation: { sourceReference: 'Dated employment declaration, January 3' } };

async function versions(orgId: string, employmentId: string) {
  return (await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(v) as row
    from worker_employment_versions v where org_id=${orgId} and employment_id=${employmentId} order by version_no`)).rows.map(r => r.row);
}

test('approved historical status fills one documented day, preserves current history and admits only that Benefits date', { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SPEC), async h => {
    await seedFlow(h.org.orgId, h.approver);
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { from: '2026-08-09' });
    // Service inception is independent evidence, not inferred from the observation.
    await db.execute(sql`update worker_employments set service_start='2019-01-01', service_start_provenance='Independent service declaration' where id=${employmentId}`);
    const before = await versions(h.org.orgId, employmentId);
    const aggregateBefore = (await db.execute<{ service_start: string; service_start_provenance: string }>(sql`
      select service_start::text,service_start_provenance from worker_employments where id=${employmentId}`)).rows[0];
    const draft = await createChangeRequestDraft({ orgId: h.org.orgId, actorId: h.author, employmentId, payload: observation });
    // A second proposal binds the same revision; it cannot silently append after the first applies.
    const stale = await createChangeRequestDraft({ orgId: h.org.orgId, actorId: h.author, employmentId,
      payload: { ...observation, effectiveFrom: '2020-01-04', effectiveTo: '2020-01-05' } });
    for (const request of [draft, stale]) await submitChangeRequest({ orgId: h.org.orgId, actorId: h.author, requestId: request.id, reason: 'Record the independently declared status window' });
    const gate = await gateOf(draft.id);
    await decideGate({ gateId: gate.id, decision: 'approved', userId: h.approver });
    const applied = await getChangeRequest({ orgId: h.org.orgId, actorId: h.author, requestId: draft.id });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.appliedEmploymentRevision, 2);
    const after = await versions(h.org.orgId, employmentId);
    assert.deepEqual(after[0], before[0], 'no old version is closed, rewritten or linked to a successor');
    assert.equal(after.length, 2);
    assert.equal(after[1]!.status, 'active');
    assert.equal(after[1]!.effective_from, '2020-01-03');
    assert.equal(after[1]!.effective_to, '2020-01-04');
    assert.equal(after[1]!.recorded_until, null);
    assert.deepEqual((await db.execute(sql`select service_start::text,service_start_provenance from worker_employments where id=${employmentId}`)).rows[0], aggregateBefore);
    const event = (await db.execute<{ closed_versions: unknown[]; prior_snapshot: { historicalObservation: unknown } }>(sql`
      select closed_versions,prior_snapshot from employment_changes where id=${applied.appliedEmploymentChangeId}`)).rows[0]!;
    assert.deepEqual(event.closed_versions, []);
    assert.deepEqual(event.prior_snapshot.historicalObservation, observation.historicalObservation);
    const audits = (await db.execute<{ actor_id: string; changes: { before: null; after: unknown; sourceReference: string } }>(sql`
      select actor_id,changes from audit_log where org_id=${h.org.orgId} and table_name='worker_employment_versions' and row_id=${after[1]!.id as string}`)).rows;
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.actor_id, h.approver);
    assert.equal(audits[0]!.changes.before, null);
    assert.deepEqual(audits[0]!.changes.after, after[1]);
    assert.equal(audits[0]!.changes.sourceReference, observation.historicalObservation.sourceReference);
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from hrm_processes where org_id=${h.org.orgId}`)).rows[0]!.n, 0);
    await assert.rejects(async () => decideGate({ gateId: (await gateOf(stale.id)).id, decision: 'approved', userId: h.approver }), /employment changed|revision|stale/i);
    assert.equal((await versions(h.org.orgId, employmentId)).length, 2);
    const { planId } = await seedPlan(h.org.orgId);
    const windowId = await seedWindow(h.org.orgId, { opensOn: '2020-01-01', closesOn: '2020-01-05' });
    const elect = (date: string) => electEnrollment({ orgId: h.org.orgId, actorId: h.author, employmentId, planId, windowId,
      effectiveFrom: date, contributionTerms: undefined });
    await assert.rejects(elect('2020-01-04'), /no employment episode covers/);
    await assert.rejects(elect('2020-01-02'), /no employment episode covers/);
    const elected = await electEnrollment({ orgId: h.org.orgId, actorId: h.author, employmentId, planId, windowId,
      effectiveFrom: '2020-01-03', effectiveTo: '2020-01-03', contributionTerms: await seededContributionTerms(h.org.orgId, planId) });
    assert.equal(elected.status, 'active');
  });
});

test('historical observations refuse overlap, future windows and denied authors without canonical writes', { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SPEC), async h => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { from: '2026-08-09' });
    const before = await versions(h.org.orgId, employmentId);
    const draft = (payload: unknown, actorId = h.author) => createChangeRequestDraft({ orgId: h.org.orgId, actorId, employmentId, payload });
    await assert.rejects(draft({ ...observation, effectiveFrom: '2026-08-09', effectiveTo: '2026-08-10' }), /uncovered employment window/);
    await assert.rejects(draft({ ...observation, effectiveFrom: '9999-01-01', effectiveTo: '9999-01-02' }), /historical status window/);
    await assert.rejects(draft(observation, h.outsider), /permission|manage|not allowed|not authorized/i);
    await withHarness(() => setupHarness(SPEC), async foreign => {
      await assert.rejects(createChangeRequestDraft({ orgId: foreign.org.orgId, actorId: foreign.author,
        employmentId, payload: observation }), /not found|not visible|organization|employment/i);
    });
    assert.deepEqual(await versions(h.org.orgId, employmentId), before);
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from hrm_employment_change_requests where org_id=${h.org.orgId}`)).rows[0]!.n, 0);
  });
});

async function committedFixture(orgId: string, subsidiaryId: string, actorId: string, workerPartyId: string, employmentId: string) {
  const scheduleId = randomUUID(), runId = randomUUID();
  await db.execute(sql`insert into pay_schedules(id,org_id,name,frequency,periods_per_year,anchor_period_end,pay_date_offset_days,is_active,created_by,updated_by)
    values (${scheduleId},${orgId},'Historical coverage','weekly',52,'2020-01-03',0,true,${actorId},${actorId})`);
  await db.execute(sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,status,created_by,updated_by)
    values (${runId},${orgId},'pay_run','PAY-HISTORY',${subsidiaryId},'2020-01-03','USD','approved',${actorId},${actorId})`);
  await db.execute(sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,created_by,updated_by)
    values (${runId},${orgId},${scheduleId},'2020-01-01','2020-01-03','2020-01-03',2020,'committed',${actorId},${actorId})`);
  await db.execute(sql`insert into pay_stubs(org_id,pay_run_document_id,employee_party_id,employment_id,province,periods_per_year,pay_date,tax_year,currency_code,gross,created_by,updated_by)
    values (${orgId},${runId},${workerPartyId},${employmentId},'BC',52,'2020-01-03',2020,'USD','100',${actorId},${actorId})`);
  return runId;
}

test('a committed subject period appearing after submission refuses observation approval atomically', { skip: !DB }, async () => {
  await withHarness(() => setupHarness(SPEC), async h => {
    await seedFlow(h.org.orgId, h.approver);
    const { employmentId, workerPartyId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { from: '2026-08-09' });
    const draft = await createChangeRequestDraft({ orgId: h.org.orgId, actorId: h.author, employmentId, payload: observation });
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.author, requestId: draft.id, reason: 'Document historical status' });
    const runId = await committedFixture(h.org.orgId, h.org.subsidiaryId, h.author, workerPartyId, employmentId);
    const before = (await db.execute(sql`select to_jsonb(s) as row from pay_stubs s where pay_run_document_id=${runId}`)).rows;
    const gate = await gateOf(draft.id);
    await assert.rejects(decideGate({ gateId: gate.id, decision: 'approved', userId: h.approver }), /committed.*employment window/);
    assert.equal((await getChangeRequest({ orgId: h.org.orgId, actorId: h.author, requestId: draft.id })).status, 'pending_approval');
    assert.equal((await versions(h.org.orgId, employmentId)).length, 1);
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from employment_changes where employment_id=${employmentId}`)).rows[0]!.n, 0);
    assert.deepEqual((await db.execute(sql`select to_jsonb(s) as row from pay_stubs s where pay_run_document_id=${runId}`)).rows, before);
    await assert.rejects(createChangeRequestDraft({ orgId: h.org.orgId, actorId: h.author, employmentId, payload: observation }), /committed.*employment window/);
  });
});
