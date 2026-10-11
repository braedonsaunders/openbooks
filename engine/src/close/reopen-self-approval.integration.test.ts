import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { createScratchOrg, dropScratchOrg, createScratchUser, seedApprovalFlow } from '../testing/fixtures.ts';
import { CloseError } from "../periods/period-policy.ts";
import { decidePeriodReopen, recloseApprovedReopen, reopenDecisionPreview, requestPeriodReopen, withdrawPeriodReopen } from "./reopening.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";

async function grantReopen(orgId: string, roleKey: string): Promise<void> {
  await db.execute(sql`update app_roles set permissions = '["close.reopen"]'::jsonb where org_id = ${orgId} and key = ${roleKey}`);
}

async function closeGl(orgId: string, periodId: string, bookId: string, actorId: string): Promise<void> {
  await setPeriodLockState({ orgId, periodId, bookId, module: 'gl', state: 'closed', actorId, reason: 'Close for review' });
}

test('a sole eligible approver self-approves with an attestation and a distinct audit entry', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const soloId = await createScratchUser(org.orgId, 'Solo Admin', 'admin');
    await grantReopen(org.orgId, 'admin');
    await closeGl(org.orgId, org.periodId, org.bookId, soloId);
    const preview_before = await reopenDecisionPreview(org.orgId,
      await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: soloId, reason: 'Correction window' }),
      soloId);
    assert.equal(preview_before.ownRequest, true);
    assert.equal(preview_before.independenceRequired, false);
    assert.equal(preview_before.selfApprovalAllowed, true);
    // Without the attestation the self-approval is refused and audited nowhere.
    const unattestedId = await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: soloId, reason: 'Missing attestation' });
    await assert.rejects(
      decidePeriodReopen({ orgId: org.orgId, requestId: unattestedId, actorId: soloId, approve: true, hours: 2 }),
      /attestation/,
    );
    assert.equal((await db.execute<{ status: string }>(sql`select status from close_reopen_requests where id = ${unattestedId}`)).rows[0]!.status, 'requested');
    // With the attestation the same sole approver reopens.
    const requestId = await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: soloId, reason: 'Correction window' });
    await decidePeriodReopen({
      orgId: org.orgId, requestId, actorId: soloId, approve: true, hours: 2,
      attestation: 'I am the only administrator; this correction cannot wait for another approver',
    });
    assert.equal((await db.execute<{ status: string }>(sql`select status from close_reopen_requests where id = ${requestId}`)).rows[0]!.status, 'approved');
    const audit = (await db.execute<{ action: string; changes: { after: { note?: string; attestation?: string; conflicts?: unknown[] } } }>(sql`
      select action, changes from audit_log
       where org_id = ${org.orgId} and table_name = 'close_reopen_requests' and row_id = ${requestId}`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.action, 'self_approve');
    assert.equal(audit[0]!.changes.after.note, 'self-approved: no other eligible approver');
    assert.ok((audit[0]!.changes.after.attestation ?? '').includes('only administrator'));
    const event = (await db.execute<{ payload: { selfApproved?: boolean; note?: string } }>(sql`
      select payload from close_events
       where org_id = ${org.orgId} and event_type = 'period.reopen_decision' and payload->>'requestId' = ${requestId}`)).rows[0]!.payload;
    assert.equal(event.selfApproved, true);
    assert.equal(event.note, 'self-approved: no other eligible approver');
  } finally { await dropScratchOrg(org.orgId); }
});

test('a sole approver conflict is retained in the self-approval audit instead of refusing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const soloId = await createScratchUser(org.orgId, 'Solo Admin', 'admin');
    await grantReopen(org.orgId, 'admin');
    await closeGl(org.orgId, org.periodId, org.bookId, soloId);
    const docId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, subsidiary_id, kind, status, document_number, document_date,
         posting_date, posting_period_id, currency, subtotal, tax_total, total, created_by, submitted_by)
      values (${docId}, ${org.orgId}, ${org.subsidiaryId}, 'customer_invoice', 'approved', ${docId},
              ${org.date}, ${org.date}, ${org.periodId}, 'CAD', '10.0000', '0.0000', '10.0000',
              ${soloId}, ${soloId})`);
    const requestId = await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: soloId, reason: 'Correction window' });
    await decidePeriodReopen({
      orgId: org.orgId, requestId, actorId: soloId, approve: true, hours: 2,
      attestation: 'Only administrator on record; accepting my own conflict explicitly',
    });
    assert.equal((await db.execute<{ status: string }>(sql`select status from close_reopen_requests where id = ${requestId}`)).rows[0]!.status, 'approved');
    const audit = (await db.execute<{ changes: { after: { conflicts?: { count: number }[] } } }>(sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'close_reopen_requests' and row_id = ${requestId}`)).rows[0]!.changes;
    const total = (audit.after.conflicts ?? []).reduce((sum, item) => sum + item.count, 0);
    assert.ok(total > 0, 'the self-approval audit must retain the conflict detail');
  } finally { await dropScratchOrg(org.orgId); }
});

test('self-approval still refuses when another eligible approver exists', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const adminId = await createScratchUser(org.orgId, 'Admin', 'admin');
    await createScratchUser(org.orgId, 'Second Admin', 'second_admin');
    await grantReopen(org.orgId, 'admin');
    await grantReopen(org.orgId, 'second_admin');
    await closeGl(org.orgId, org.periodId, org.bookId, adminId);
    const requestId = await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: adminId, reason: 'Correction window' });
    const preview = await reopenDecisionPreview(org.orgId, requestId, adminId);
    assert.equal(preview.independenceRequired, true);
    assert.equal(preview.selfApprovalAllowed, false);
    // The requester is told whom to ask, never just "another approver".
    assert.ok(preview.eligibleApprovers.includes('Second Admin'));
    assert.ok(!preview.eligibleApprovers.includes('Admin'));
    await assert.rejects(
      decidePeriodReopen({
        orgId: org.orgId, requestId, actorId: adminId, approve: true, hours: 2,
        attestation: 'An attestation cannot replace the available second approver',
      }),
      /independent approval: .*Second Admin.* can decide it from My approvals/,
    );
    assert.equal((await db.execute<{ status: string }>(sql`select status from close_reopen_requests where id = ${requestId}`)).rows[0]!.status, 'requested');
  } finally { await dropScratchOrg(org.orgId); }
});

test('self-approval still refuses while a Flow requires independent approval', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const soloId = await createScratchUser(org.orgId, 'Solo Admin', 'admin');
    await grantReopen(org.orgId, 'admin');
    await closeGl(org.orgId, org.periodId, org.bookId, soloId);
    await seedApprovalFlow(org.orgId, { subjectKind: 'close_run', assignees: [{ type: 'role', role: 'approver' }], mode: 'any' });
    const requestId = await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: soloId, reason: 'Correction window' });
    const preview = await reopenDecisionPreview(org.orgId, requestId, soloId);
    assert.equal(preview.independenceRequired, true);
    assert.equal(preview.selfApprovalAllowed, false);
    await assert.rejects(
      decidePeriodReopen({
        orgId: org.orgId, requestId, actorId: soloId, approve: true, hours: 2,
        attestation: 'The configured approval flow still requires independence',
      }),
      /independent approval/,
    );
    assert.equal((await db.execute<{ status: string }>(sql`select status from close_reopen_requests where id = ${requestId}`)).rows[0]!.status, 'requested');
    // A Flow that opts out of preventSelfApproval does not block the sole approver.
    await db.execute(sql`update flows set enabled = false where org_id = ${org.orgId}`);
    await seedApprovalFlow(org.orgId, { subjectKind: 'close_run', assignees: [{ type: 'role', role: 'approver' }], mode: 'any', preventSelfApproval: false });
    const openId = await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: soloId, reason: 'Correction window' });
    await decidePeriodReopen({
      orgId: org.orgId, requestId: openId, actorId: soloId, approve: true, hours: 2,
      attestation: 'The configured flow permits self-approval and no other approver exists',
    });
    assert.equal((await db.execute<{ status: string }>(sql`select status from close_reopen_requests where id = ${openId}`)).rows[0]!.status, 'approved');
  } finally { await dropScratchOrg(org.orgId); }
});

test('a user without the reopen permission is not an eligible approver', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const soloId = await createScratchUser(org.orgId, 'Solo Admin', 'admin');
    await grantReopen(org.orgId, 'admin');
    await createScratchUser(org.orgId, 'Viewer', 'viewer');
    await closeGl(org.orgId, org.periodId, org.bookId, soloId);
    const requestId = await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: soloId, reason: 'Correction window' });
    const preview = await reopenDecisionPreview(org.orgId, requestId, soloId);
    assert.equal(preview.independenceRequired, false);
    await decidePeriodReopen({
      orgId: org.orgId, requestId, actorId: soloId, approve: true, hours: 2,
      attestation: 'The only other user holds no reopen permission',
    });
    assert.equal((await db.execute<{ status: string }>(sql`select status from close_reopen_requests where id = ${requestId}`)).rows[0]!.status, 'approved');
  } finally { await dropScratchOrg(org.orgId); }
});

test('the surfaces read decision and end evidence from the stored audit trail', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // Both reopen surfaces (Setup drawer, accounting page) select these four
  // evidence columns verbatim from audit_log: the decision action with its
  // quoted attestation and the explicit end with its actor and reason.
  // This pins the SQL text against a live self-approved then ended window.
  const org = await createScratchOrg();
  try {
    const soloId = await createScratchUser(org.orgId, 'Solo Admin', 'admin');
    await grantReopen(org.orgId, 'admin');
    await closeGl(org.orgId, org.periodId, org.bookId, soloId);
    const requestId = await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: soloId, reason: 'Correction window' });
    await decidePeriodReopen({
      orgId: org.orgId, requestId, actorId: soloId, approve: true, hours: 2,
      attestation: 'I am the only administrator; this correction cannot wait for another approver',
    });
    await recloseApprovedReopen({
      orgId: org.orgId, requestId, actorId: soloId, reason: 'Correction posted and reviewed; ending the window',
    });
    const evidence = (await db.execute<{
      decision_action: string | null;
      decision_attestation: string | null;
      end_actor_name: string | null;
      end_reason: string | null;
    }>(sql`
      select (select a.action from audit_log a
               where a.org_id = r.org_id and a.table_name = 'close_reopen_requests' and a.row_id = r.id
                 and a.action in ('approve', 'self_approve')
               order by a.at desc limit 1) as decision_action,
             (select a.changes#>>'{after,attestation}' from audit_log a
               where a.org_id = r.org_id and a.table_name = 'close_reopen_requests' and a.row_id = r.id
                 and a.action in ('approve', 'self_approve')
               order by a.at desc limit 1) as decision_attestation,
             (select ender.name from audit_log a
                left join users ender on ender.id = a.actor_id
               where a.org_id = r.org_id and a.table_name = 'close_reopen_requests' and a.row_id = r.id
                 and a.action = 'end'
               order by a.at desc limit 1) as end_actor_name,
             (select coalesce(a.changes#>>'{after,reason}', a.changes->>'reason') from audit_log a
               where a.org_id = r.org_id and a.table_name = 'close_reopen_requests' and a.row_id = r.id
                 and a.action = 'end'
               order by a.at desc limit 1) as end_reason
        from close_reopen_requests r
       where r.org_id = ${org.orgId} and r.id = ${requestId}
    `)).rows[0]!;
    assert.equal(evidence.decision_action, 'self_approve');
    assert.ok((evidence.decision_attestation ?? '').includes('only administrator'));
    assert.equal(evidence.end_actor_name, 'Solo Admin');
    assert.ok((evidence.end_reason ?? '').includes('ending the window'));
  } finally { await dropScratchOrg(org.orgId); }
});

test('the requester withdraws a pending reopen with a reason, audited and no longer decidable', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const requesterId = await createScratchUser(org.orgId, 'Requester', 'admin');
    const approverId = await createScratchUser(org.orgId, 'Second Admin', 'second_admin');
    await grantReopen(org.orgId, 'admin');
    await grantReopen(org.orgId, 'second_admin');
    const requestId = await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: requesterId, reason: 'Correction window' });
    await withdrawPeriodReopen({
      orgId: org.orgId, requestId, actorId: requesterId, reason: 'Changed my mind; the correction is no longer needed',
    });
    assert.equal((await db.execute<{ status: string }>(sql`select status from close_reopen_requests where id = ${requestId}`)).rows[0]!.status, 'withdrawn');
    const audit = (await db.execute<{ action: string; actor_id: string; changes: { before: { status: string }; after: { status: string; reason: string } } }>(sql`
      select action, actor_id, changes from audit_log
       where org_id = ${org.orgId} and table_name = 'close_reopen_requests' and row_id = ${requestId}`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.action, 'withdraw');
    assert.equal(audit[0]!.actor_id, requesterId);
    assert.equal(audit[0]!.changes.before.status, 'requested');
    assert.equal(audit[0]!.changes.after.status, 'withdrawn');
    assert.ok(audit[0]!.changes.after.reason.includes('no longer needed'));
    const events = (await db.execute<{ payload: { reason?: string } }>(sql`
      select payload from close_events
       where org_id = ${org.orgId} and event_type = 'period.reopen_withdrawn' and payload->>'requestId' = ${requestId}`)).rows;
    assert.equal(events.length, 1);
    assert.ok((events[0]!.payload.reason ?? '').includes('no longer needed'));
    // A withdrawn request is no longer pending: neither a second withdrawal nor a decision can land.
    await assert.rejects(withdrawPeriodReopen({ orgId: org.orgId, requestId, actorId: requesterId, reason: 'Withdrawing a second time' }), /pending reopen request not found/);
    await assert.rejects(decidePeriodReopen({ orgId: org.orgId, requestId, actorId: approverId, approve: true, hours: 2, attestation: 'Attempting to approve a withdrawn request' }), /pending reopen request not found/);
    await assert.rejects(decidePeriodReopen({ orgId: org.orgId, requestId, actorId: approverId, approve: false, decisionReason: 'Attempting to reject a withdrawn request' }), /pending reopen request not found/);
  } finally { await dropScratchOrg(org.orgId); }
});

test('only the requester can withdraw, and a withdrawal reason must be 10-500 characters', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const requesterId = await createScratchUser(org.orgId, 'Requester', 'admin');
    const approverId = await createScratchUser(org.orgId, 'Second Admin', 'second_admin');
    await grantReopen(org.orgId, 'admin');
    await grantReopen(org.orgId, 'second_admin');
    const requestId = await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: requesterId, reason: 'Correction window' });
    await assert.rejects(
      withdrawPeriodReopen({ orgId: org.orgId, requestId, actorId: approverId, reason: 'An approver tries to withdraw this' }),
      /Only the requester can withdraw a reopen request; an approver rejects it with a reason/,
    );
    await assert.rejects(
      withdrawPeriodReopen({ orgId: org.orgId, requestId, actorId: requesterId, reason: 'too short' }),
      /10-500 character withdrawal reason/,
    );
    await assert.rejects(
      withdrawPeriodReopen({ orgId: org.orgId, requestId, actorId: requesterId, reason: 'x'.repeat(501) }),
      /10-500 character withdrawal reason/,
    );
    const row = (await db.execute<{ status: string }>(sql`select status from close_reopen_requests where id = ${requestId}`)).rows[0]!;
    assert.equal(row.status, 'requested', 'refused withdrawals leave the request pending');
    const withdrawals = (await db.execute<{ n: string }>(sql`
      select count(*) as n from audit_log
       where org_id = ${org.orgId} and table_name = 'close_reopen_requests' and row_id = ${requestId} and action = 'withdraw'`)).rows[0]!;
    assert.equal(Number(withdrawals.n), 0, 'refused withdrawals write no audit row');
  } finally { await dropScratchOrg(org.orgId); }
});

test('a rejection requires an approver reason that the audit keeps, and the requester cannot reject their own request', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const requesterId = await createScratchUser(org.orgId, 'Requester', 'admin');
    const approverId = await createScratchUser(org.orgId, 'Second Admin', 'second_admin');
    await grantReopen(org.orgId, 'admin');
    await grantReopen(org.orgId, 'second_admin');
    const requestId = await requestPeriodReopen({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, modules: ['gl'], actorId: requesterId, reason: 'Correction window' });
    const rejectionRefusal = /Rejecting a reopen request requires a 10-500 character reason/;
    await assert.rejects(decidePeriodReopen({ orgId: org.orgId, requestId, actorId: approverId, approve: false }), rejectionRefusal);
    await assert.rejects(decidePeriodReopen({ orgId: org.orgId, requestId, actorId: approverId, approve: false, decisionReason: 'too short' }), rejectionRefusal);
    await assert.rejects(
      decidePeriodReopen({ orgId: org.orgId, requestId, actorId: requesterId, approve: false, decisionReason: 'I no longer need this window' }),
      /cannot reject their own reopen request; withdraw it with a reason instead/,
    );
    assert.equal((await db.execute<{ status: string }>(sql`select status from close_reopen_requests where id = ${requestId}`)).rows[0]!.status, 'requested');
    const reason = 'The window is broader than the correction needs';
    await decidePeriodReopen({ orgId: org.orgId, requestId, actorId: approverId, approve: false, decisionReason: reason });
    assert.equal((await db.execute<{ status: string }>(sql`select status from close_reopen_requests where id = ${requestId}`)).rows[0]!.status, 'rejected');
    const audit = (await db.execute<{ action: string; actor_id: string; changes: { after: { decisionReason?: string; reason: string } } }>(sql`
      select action, actor_id, changes from audit_log
       where org_id = ${org.orgId} and table_name = 'close_reopen_requests' and row_id = ${requestId}`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.action, 'reject');
    assert.equal(audit[0]!.actor_id, approverId);
    assert.equal(audit[0]!.changes.after.decisionReason, reason);
    assert.equal(audit[0]!.changes.after.reason, 'Correction window', 'the requester reason stays on the audit beside the decision reason');
    const event = (await db.execute<{ payload: { decision?: string; decisionReason?: string } }>(sql`
      select payload from close_events
       where org_id = ${org.orgId} and event_type = 'period.reopen_decision' and payload->>'requestId' = ${requestId}`)).rows[0]!.payload;
    assert.equal(event.decision, 'rejected');
    assert.equal(event.decisionReason, reason);
  } finally { await dropScratchOrg(org.orgId); }
});
