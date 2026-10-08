import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { registerQueryObserver } from '../platform/query-observer.ts';
import { assertDedicatedFixtureDatabase } from '../testing/fixtures.ts';
import { DB, withHarness } from '../testing/hrm-harness.ts';
import { checklistActor, openChecklist, setupChecklistHarness } from '../testing/checklist-fixtures.ts';
import { createProcessTemplate, upsertProcessTemplateStep } from '../hrm/processes.ts';
import { actOnInboxItem, countInbox, InboxError, listInbox } from './registry.ts';
import './index.ts';

test('checklist badges count beyond the list window and later pages retain live completion and isolation', { skip: !DB }, async () => {
  await assertDedicatedFixtureDatabase();
  await withHarness(() => setupChecklistHarness(), async h => {
    const actor = checklistActor(h);
    const party = (await db.execute<{ party_id: string }>(sql`select party_id from users
      where org_id=${actor.orgId} and id=${actor.actorId}`)).rows[0]!.party_id;
    const template = await createProcessTemplate({ ...actor, kind: 'onboarding', name: 'Employee checklist' });
    for (let position = 0; position < 105; position++) {
      await upsertProcessTemplateStep({ ...actor, templateId: template.id, position,
        title: `Review item ${position}`, ownerKind: 'named_party', ownerPartyId: party,
        dueOffsetDays: 0, required: true, evidenceKind: 'none' });
    }
    await upsertProcessTemplateStep({ ...actor, templateId: template.id, position: 105,
      title: 'Worker acknowledgement', ownerKind: 'employee', required: true, evidenceKind: 'acknowledgement' });
    const opened = await openChecklist(h, { templateId: template.id });
    const ctx = { ...actor, asOf: '2026-10-08' };
    const before = (await db.execute(sql`select id,status,owner_party_id,owner_kind from hrm_process_steps
      where org_id=${actor.orgId} and process_id=${opened.id} order by id`)).rows;
    assert.equal(before.length, 106);
    const first = await listInbox(ctx, { kinds: ['hrm_process_step'] });
    const last = await listInbox(ctx, { kinds: ['hrm_process_step'], page: { limit: 100, offset: 100 } });
    assert.equal(first.length, 100);
    assert.equal(last.length, 5);
    assert.equal(new Set([...first, ...last].map(item => item.id)).size, 105);
    const statements: string[] = [];
    const stop = registerQueryObserver(statement => statements.push(statement));
    try { assert.equal(await countInbox(ctx, { kinds: ['hrm_process_step'] }), 105); }
    finally { stop(); }
    assert.equal(statements.filter(statement => /select count\(\*\)::int as n/.test(statement)).length, 1);
    assert.equal(statements.some(statement => /select s.id, s.process_id/.test(statement)), false);
    assert.deepEqual((await db.execute(sql`select id,status,owner_party_id,owner_kind from hrm_process_steps
      where org_id=${actor.orgId} and process_id=${opened.id} order by id`)).rows, before);
    await assert.rejects(() => actOnInboxItem(ctx, 'hrm_process_step:not-an-id', 'complete'),
      (error: unknown) => error instanceof InboxError && error.code === 'NOT_FOUND');
    await withHarness(() => setupChecklistHarness(), async foreign => {
      const foreignCtx = { ...ctx, orgId: foreign.org.orgId, actorId: foreign.managerId };
      assert.equal(await countInbox(foreignCtx, { kinds: ['hrm_process_step'] }), 0);
      await assert.rejects(() => actOnInboxItem(foreignCtx, last[0]!.id, 'complete'),
        (error: unknown) => error instanceof InboxError && error.code === 'NOT_FOUND');
    });
    await actOnInboxItem(ctx, last[0]!.id, 'complete');
    assert.equal(await countInbox(ctx, { kinds: ['hrm_process_step'] }), 104);
    await assert.rejects(() => actOnInboxItem(ctx, last[0]!.id, 'complete'),
      (error: unknown) => error instanceof InboxError && error.code === 'NOT_FOUND');
    const after = (await db.execute(sql`select id,status,owner_party_id,owner_kind from hrm_process_steps
      where org_id=${actor.orgId} and process_id=${opened.id} order by id`)).rows;
    assert.equal(after.filter(row => row.status === 'done').length, 1);
    assert.deepEqual(after.filter(row => row.id !== last[0]!.source.id),
      before.filter(row => row.id !== last[0]!.source.id));
    const disabled = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,hrm}','false'::jsonb)
      where id=${actor.orgId} returning id`);
    assert.equal(disabled.rows.length, 1);
    assert.equal(await countInbox(ctx, { kinds: ['hrm_process_step'] }), 0);
    await assert.rejects(() => actOnInboxItem(ctx, first[0]!.id, 'complete'),
      (error: unknown) => error instanceof InboxError && error.code === 'NOT_FOUND');
    assert.deepEqual((await db.execute(sql`select id,status,owner_party_id,owner_kind from hrm_process_steps
      where org_id=${actor.orgId} and process_id=${opened.id} order by id`)).rows, after);
  });
});
