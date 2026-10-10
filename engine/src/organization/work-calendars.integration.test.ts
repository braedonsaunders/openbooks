import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, type SqlExecutor } from '../platform/db.ts';
import { createScratchOrg, createScratchUser, dropScratchOrg } from '../testing/fixtures.ts';
import { saveCompanyWorkCalendar, WorkCalendarError } from './work-calendars.ts';
const transaction = <T>(work: (tx: SqlExecutor) => Promise<T>) => withBypassContext(() => db.transaction(work));
const weekdays = { '0': false, '1': true, '2': true, '3': true, '4': true, '5': true, '6': false };

test('company calendars retain project defaults, audit replacements and refuse stale, hidden or revoked commands including replay', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg()), foreign = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Calendar manager', 'admin'));
    const other = await withBypassContext(() => createScratchUser(foreign.orgId, 'Other company manager', 'admin'));
    await transaction(tx => tx.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":false,"projectScheduling":false,"inventory":true,"manufacturing":true}'::jsonb) where id=${org.orgId} returning id`));
    const input = { id: randomUUID(), name: 'Production week', workingDays: weekdays, holidays: ['2026-12-25', '2026-12-25'], isDefault: true, reason: 'Set the production working week.' };
    const create = () => transaction(tx => saveCompanyWorkCalendar(tx, org.orgId, actor, input));
    const first = await create(); assert.equal(first.replayed, false); assert.deepEqual(first.holidays, ['2026-12-25']);
    const state = () => transaction(async tx => (await tx.execute(sql`select
      (select jsonb_agg(to_jsonb(calendar) order by id) from schedule_calendars calendar where org_id=${org.orgId}) as calendars,
      (select count(*) from audit_log where org_id=${org.orgId}) as audits`)).rows[0]);
    const original = await state(); assert.equal((await create()).replayed, true); assert.deepEqual(await state(), original);
    await assert.rejects(transaction(tx => saveCompanyWorkCalendar(tx, org.orgId, actor, { ...input, name: 'Another request' })), error => error instanceof WorkCalendarError && error.code === 'work_calendar_idempotency_conflict');
    const project = (await transaction(tx => tx.execute<{ id: string }>(sql`insert into projects(org_id,name,subsidiary_id) values(${org.orgId},'Project calendar owner',${org.subsidiaryId}) returning id`))).rows[0]!;
    const projectCalendar = (await transaction(tx => tx.execute<{ id: string }>(sql`insert into schedule_calendars(org_id,project_id,name,is_default) values(${org.orgId},${project.id},'Project week',true) returning id`))).rows[0]!;
    const second = await transaction(tx => saveCompanyWorkCalendar(tx, org.orgId, actor, { ...input, id: randomUUID(), name: 'Another working pattern' }));
    const defaults = (await transaction(tx => tx.execute<{ id: string }>(sql`select id from schedule_calendars where org_id=${org.orgId} and is_default order by id`))).rows.map(row => row.id);
    assert.deepEqual(defaults.sort(), [projectCalendar.id, second.id].sort());
    assert.equal((await transaction(tx => tx.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='schedule_calendars' and row_id=${first.id} and action='update' and changes->'after'->>'isDefault'='false'`))).rows.length, 1);
    const current = (await transaction(tx => tx.execute<{ revision: string }>(sql`select xmin::text as revision from schedule_calendars where org_id=${org.orgId} and id=${first.id}`))).rows[0]!;
    const edited = await transaction(tx => saveCompanyWorkCalendar(tx, org.orgId, actor, { ...input, isDefault: false, name: 'Updated week', expectedRevision: current.revision }));
    assert.notEqual(edited.revision, current.revision);
    const beforeRefusals = await state();
    await assert.rejects(transaction(tx => saveCompanyWorkCalendar(tx, org.orgId, actor, { ...input, expectedRevision: current.revision })), error => error instanceof WorkCalendarError && error.code === 'work_calendar_stale');
    await assert.rejects(transaction(tx => saveCompanyWorkCalendar(tx, org.orgId, actor, { ...input, id: projectCalendar.id, expectedRevision: '1' })), error => error instanceof WorkCalendarError && error.code === 'not_found');
    await assert.rejects(transaction(tx => saveCompanyWorkCalendar(tx, org.orgId, actor, { ...input, id: randomUUID(), holidays: ['2026-02-30'] })), error => error instanceof WorkCalendarError && error.status === 422);
    for (const denied of [other, randomUUID()]) await assert.rejects(transaction(tx => saveCompanyWorkCalendar(tx, org.orgId, denied, input)));
    await transaction(tx => tx.execute(sql`update app_roles set permissions='["manufacturing.manage"]'::jsonb where org_id=${org.orgId} and id in(select role_id from role_assignments where org_id=${org.orgId} and user_id=${actor}) returning id`));
    await assert.rejects(create());
    await assert.rejects(transaction(tx => saveCompanyWorkCalendar(tx, org.orgId, actor, { ...input, id: randomUUID() })));
    assert.deepEqual(await state(), beforeRefusals);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId)); await withBypassContext(() => dropScratchOrg(foreign.orgId));
  }
});
