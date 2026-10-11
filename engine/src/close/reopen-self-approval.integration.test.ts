import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { createScratchOrg, dropScratchOrg, createScratchUser, seedApprovalFlow } from '../testing/fixtures.ts';
import { CloseError } from "../periods/period-policy.ts";
import { decidePeriodReopen, reopenDecisionPreview, requestPeriodReopen } from "./reopening.ts";
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
    await assert.rejects(
      decidePeriodReopen({
        orgId: org.orgId, requestId, actorId: adminId, approve: true, hours: 2,
        attestation: 'An attestation cannot replace the available second approver',
      }),
      /independent approval/,
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
