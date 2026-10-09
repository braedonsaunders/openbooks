import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import { importSourceHistory, previewSourceHistory, sourceHistoryHash } from '@openbooks/engine/src/schedule-boards/source-history.ts'
import { listBoards } from '@openbooks/engine/src/schedule-boards/boards.ts'
import { createSetupRecord, deleteSetupRecord } from './write'

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

test('module board deletion archives the native board, retains source evidence and audits, and replays without another change', enabled, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const other = await withBypassContext(() => createScratchOrg())
  try {
    const actorId = await withBypassContext(async () => {
      const id = (await seedFlowActors(org.orgId)).adminId
      const grants = await db.execute(sql`update app_roles set permissions='["admin.setup.manage","hrm.shifts.read","hrm.shifts.approve"]'::jsonb where org_id=${org.orgId} and key='admin' returning id`)
      assert.equal(grants.rows.length, 1, 'the native role receives the actual Setup and scheduling command grants')
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"hrm":true,"hrmShiftPlanning":true}'::jsonb) where id=${org.orgId}`)
      return id
    })
    const actor = { orgId: org.orgId, id: actorId, permissions: ['admin.setup.manage'], allowedSubsidiaryIds: null }
    const board = await withOrgTransaction(org.orgId, () => createSetupRecord(actor, 'schedule-boards', {
      code: 'HISTORY', name: 'Date history', rowKind: 'people', views: ['grid'], defaultView: 'grid',
      rangeDays: 14, timeZone: 'America/Toronto', dayPolicyKnown: false,
    }, { requestId: randomUUID() }))
    assert.equal(board.status, 200, JSON.stringify(board.body))
    const boardId = String(board.body.id)
    const workerId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active) values(${workerId},${org.orgId},'person','Historical person',${org.subsidiaryId},false)`)
      await db.execute(sql`insert into employee_roles(org_id,party_id,is_active) values(${org.orgId},${workerId},false)`)
    })
    const payload = { id: 7, label: 'Literal source value' }
    const batch = { sourceSystem: 'LegacyPlanning', sourceDataset: 'dbo.manpower', captureHash: sourceHistoryHash([payload]), rows: [{
      sourceKey: '7', sourceHash: sourceHistoryHash(payload), payload, disposition: 'recorded' as const,
      boardId, workerPartyId: workerId, onDate: '2025-01-03', label: payload.label, result: null, notes: null,
      visibleInSource: true, linkedEntryId: null, expectedPriorId: null, reason: 'Adopt literal historical date',
    }] }
    const nativeActor = { orgId: org.orgId, actorId }
    const preview = await previewSourceHistory(nativeActor, batch)
    const [created] = await importSourceHistory(nativeActor, batch, preview.approvalHash)
    assert.ok(created)
    const before = await withOrgTransaction(org.orgId, () => db.execute(sql`select * from schedule_source_records where id=${created.id}`))
    const refused = await withOrgTransaction(other.orgId, () => deleteSetupRecord({ ...actor, orgId: other.orgId }, 'schedule-boards', boardId))
    assert.equal(refused.status, 404)
    const result = await withOrgTransaction(org.orgId, () => deleteSetupRecord(actor, 'schedule-boards', boardId))
    assert.equal(result.status, 200, JSON.stringify(result.body))
    const readback = await withOrgTransaction(org.orgId, async () => ({
      board: (await db.execute<{ is_active: boolean }>(sql`select is_active from schedule_boards where id=${boardId}`)).rows[0],
      source: (await db.execute(sql`select * from schedule_source_records where id=${created.id}`)).rows,
      audits: (await db.execute<{ actor_id: string; changes: { before: { is_active: boolean }; after: { is_active: boolean } } }>(sql`select actor_id,changes from audit_log where table_name='schedule_boards' and row_id=${boardId} and action='update'`)).rows,
    }))
    assert.equal(readback.board?.is_active, false)
    assert.deepEqual(readback.source, before.rows)
    assert.equal(readback.audits.length, 1)
    assert.equal(readback.audits[0]!.actor_id, actorId)
    assert.equal(readback.audits[0]!.changes.before.is_active, true)
    assert.equal(readback.audits[0]!.changes.after.is_active, false)
    assert.equal((await listBoards(nativeActor)).some(row => row.id === boardId), false)
    assert.equal((await listBoards(nativeActor, { includeArchived: true })).some(row => row.id === boardId), true)
    assert.equal((await withOrgTransaction(org.orgId, () => deleteSetupRecord(actor, 'schedule-boards', boardId))).status, 200)
    const audits = await withOrgTransaction(org.orgId, () => db.execute<{ n: number }>(sql`select count(*)::int n from audit_log where table_name='schedule_boards' and row_id=${boardId} and action='update'`))
    assert.equal(audits.rows[0]!.n, 1)
  } finally { await dropScratchOrgReporting(org.orgId); await dropScratchOrgReporting(other.orgId) }
})

test('saved hour-column and whole-board sharing settings reopen through the native board read and refuse ownerless sharing',enabled,async()=>{
 const org=await withBypassContext(()=>createScratchOrg());
 try {
  const actorId=await withBypassContext(async()=>{const id=(await seedFlowActors(org.orgId)).adminId;await db.execute(sql`update app_roles set permissions='["admin.setup.manage","hrm.shifts.read"]'::jsonb where org_id=${org.orgId} and key='admin'`);await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"hrm":true,"hrmShiftPlanning":true}'::jsonb) where id=${org.orgId}`);return id});
  const actor={orgId:org.orgId,id:actorId,permissions:['admin.setup.manage'],allowedSubsidiaryIds:null};
  const made=await withOrgTransaction(org.orgId,()=>createSetupRecord(actor,'schedule-boards',{code:'DISPLAY',name:'Display board',rowKind:'people',views:['grid'],defaultView:'grid',rangeDays:14,timeZone:'America/Toronto',dayPolicyKnown:false},{requestId:randomUUID()}));assert.equal(made.status,200,JSON.stringify(made.body));
  const id=String(made.body.id),{updateSetupRecord}=await import('./write');
  const refused=await withOrgTransaction(org.orgId,()=>updateSetupRecord(actor,'schedule-boards',{id,distributionVisibility:'board'}));assert.equal(refused.status,400);assert.match(String(refused.body.error),/legal entity/);
  const saved=await withOrgTransaction(org.orgId,()=>updateSetupRecord(actor,'schedule-boards',{id,subsidiaryId:org.subsidiaryId,showHoursColumn:false,showTotals:true,distributionVisibility:'board'}));assert.equal(saved.status,200,JSON.stringify(saved.body));
  const board=(await listBoards({orgId:org.orgId,actorId})).find(b=>b.id===id)!;assert.equal(board.showHoursColumn,false);assert.equal(board.showTotals,true);assert.equal(board.distributionVisibility,'board');assert.equal(board.dayPolicyKnown,false);
  const evidence=await withOrgTransaction(org.orgId,()=>db.execute<{actor_id:string;changes:{after:{show_hours_column:boolean}}}>(sql`select actor_id,changes from audit_log where table_name='schedule_boards' and row_id=${id} and action='update'`));assert.equal(evidence.rows.length,1);assert.equal(evidence.rows[0]!.actor_id,actorId);
 } finally {await dropScratchOrgReporting(org.orgId)}
});
