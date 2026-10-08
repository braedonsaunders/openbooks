import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { applyBoardChanges, publishBoard, type BoardChange } from "./entries.ts";
import { ScheduleError } from "./errors.ts";
import { scheduledWork } from "./prefill.ts";
import { loadBoardWindow } from "./window.ts";
import { importSourceHistory, previewSourceHistory, sourceHistoryHash, type SourceScheduleBatch } from './source-history.ts';

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
type Org = Awaited<ReturnType<typeof createScratchOrg>>;
type Fixture = { org: Org; actorId: string; ana: string; ben: string; projectId: string; otherProjectId: string; taskId: string; otherTaskId: string; codeId: string; live: string; staged: string; second: string };

const affected = (result: { rowCount: number | null }, label: string) => {
  if (result.rowCount !== 1) throw new Error(`${label} did not affect one row`);
};

async function grantScheduling(orgId: string, roleKey: string): Promise<void> {
  affected(await db.execute(sql`update app_roles set permissions = '["hrm.shifts.read","hrm.shifts.manage","hrm.shifts.approve","projects.read","projects.manage","assets.read","assets.manage"]'::jsonb
    where org_id = ${orgId} and key = ${roleKey}`), "role permissions");
}

async function board(orgId: string, code: string, publishPolicy: "live" | "staged", extra: { prefillTimesheets?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  affected(await db.execute(sql`insert into schedule_boards (id, org_id, code, name, row_kind, views, default_view, time_zone, publish_policy, prefill_timesheets)
    values (${id}, ${orgId}, ${code}, ${`Board ${code}`}, 'people', '{grid,targets}', 'grid', 'America/Toronto', ${publishPolicy}, ${extra.prefillTimesheets ?? false})`), "board setup");
  return id;
}

async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const ids = await withBypassContext(async () => {
      const actorId = await createScratchUser(org.orgId, "Dispatcher", "dispatcher");
      await grantScheduling(org.orgId, "dispatcher");
      affected(await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
        || '{"hrm":true,"hrmShiftPlanning":true,"projects":true,"projectScheduling":true,"equipment":true}'::jsonb) where id = ${org.orgId}`), "feature setup");
      const person = async (name: string) => {
        const id = randomUUID();
        affected(await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${id}, ${org.orgId}, 'person', ${name}, ${org.subsidiaryId}, true, '{}'::jsonb)`), "person setup");
        affected(await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${org.orgId}, ${id}, 'Millwright', '2026-01-01', true)`), "role setup");
        return id;
      };
      const project = async (name: string) => {
        const id = randomUUID();
        affected(await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${`SB-${id.slice(0, 6)}`}, ${name}, ${org.customerId}, 'active', true, '{}'::jsonb)`), "project setup");
        const taskId = randomUUID();
        affected(await db.execute(sql`insert into project_tasks (id, org_id, project_id, name, created_by, updated_by) values (${taskId}, ${org.orgId}, ${id}, 'Install', ${actorId}, ${actorId})`), "task setup");
        return { id, taskId };
      };
      const ana = await person("Ana Field");
      const ben = await person("Ben Shop");
      const first = await project("Kiln rebuild");
      const other = await project("Conveyor");
      const codeId = randomUUID();
      affected(await db.execute(sql`insert into schedule_codes (id, org_id, code, label, category, color) values (${codeId}, ${org.orgId}, 'TRAIN', 'Training', 'work', '#38bdf8')`), "code setup");
      return {
        actorId, ana, ben, projectId: first.id, taskId: first.taskId, otherProjectId: other.id, otherTaskId: other.taskId, codeId,
        live: await board(org.orgId, "FIELD", "live", { prefillTimesheets: true }),
        staged: await board(org.orgId, "PLANT", "staged"),
        second: await board(org.orgId, "SHOP", "live"),
      };
    });
    await run({ org, ...ids });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

const actor = (f: Fixture) => ({ orgId: f.org.orgId, actorId: f.actorId });
const day = (_f: Fixture, workerPartyId: string, onDate: string, target: { kind: "project" | "code"; id: string } | null): Extract<BoardChange, { op: "create" }> => ({
  op: "create", id: randomUUID(), workerPartyId, onDate, target, span: { mode: "day" },
});
const statusOf = async (orgId: string, id: string) => (await withBypassContext(() => db.execute<{ status: string }>(sql`select status from schedule_entries where org_id = ${orgId} and id = ${id}`))).rows[0]?.status;

test("a live board publishes as it books, and a person is never booked twice across boards", enabled, async () => fixture(async (f) => {
  const booked = day(f, f.ana, "2026-10-13", { kind: "project", id: f.projectId });
  const first = await applyBoardChanges({ ...actor(f), boardId: f.live, changes: [booked] });
  assert.equal(first.results[0]?.ok, true);
  assert.equal(await statusOf(f.org.orgId, booked.id), "published");

  // The same day on another board collides with the published booking; the
  // second change in the batch still saves.
  const clash = day(f, f.ana, "2026-10-13", { kind: "code", id: f.codeId });
  const fine = day(f, f.ben, "2026-10-13", { kind: "code", id: f.codeId });
  const second = await applyBoardChanges({ ...actor(f), boardId: f.second, changes: [clash, fine] });
  const [refused, saved] = second.results;
  assert.equal(refused?.ok, false);
  assert.equal(refused && !refused.ok ? refused.code : null, "schedule_double_booked");
  assert.equal(saved?.ok, true);
  assert.equal(await statusOf(f.org.orgId, clash.id), undefined);
  assert.equal(await statusOf(f.org.orgId, fine.id), "published");
}));

test("changing a published booking cancels it and records a successor; undoing restores the original target", enabled, async () => fixture(async (f) => {
  const booked = day(f, f.ana, "2026-10-14", { kind: "project", id: f.projectId });
  await applyBoardChanges({ ...actor(f), boardId: f.live, changes: [booked] });
  const moved = await applyBoardChanges({ ...actor(f), boardId: f.live, changes: [{ op: "update", id: booked.id, expectedRevision: 1, fields: { target: { kind: "code", id: f.codeId } } }] });
  const result = moved.results[0]!;
  assert.ok(result.ok && result.entry);
  assert.equal(result.replacedId, booked.id);
  assert.equal(await statusOf(f.org.orgId, booked.id), "cancelled");
  assert.equal(result.entry.supersedesId, booked.id);
  assert.equal(result.entry.target?.kind, "code");

  // A stale revision is refused rather than overwriting someone else's change.
  const stale = await applyBoardChanges({ ...actor(f), boardId: f.live, changes: [{ op: "cancel", id: result.entry.id, expectedRevision: 99 }] });
  assert.equal(stale.results[0]?.ok, false);

  const undo = await applyBoardChanges({ ...actor(f), boardId: f.live, changes: [{ op: "update", id: result.entry.id, expectedRevision: result.entry.revision, fields: { target: { kind: "project", id: f.projectId } } }] });
  assert.ok(undo.results[0]?.ok && undo.results[0].entry?.target?.id === f.projectId);
  const history = await withBypassContext(() => db.execute<{ count: string }>(sql`select count(*)::text as count from audit_log where org_id = ${f.org.orgId} and table_name = 'schedule_entries'`));
  assert.ok(Number(history.rows[0]?.count) >= 5);
}));

test("a staged board publishes all changes together, or none when one is blocked", enabled, async () => fixture(async (f) => {
  const a = day(f, f.ana, "2026-10-15", { kind: "project", id: f.projectId });
  const b = day(f, f.ben, "2026-10-15", { kind: "project", id: f.projectId });
  await applyBoardChanges({ ...actor(f), boardId: f.staged, changes: [a, b] });
  assert.equal(await statusOf(f.org.orgId, a.id), "draft");

  // Ana gets booked elsewhere before the staged board publishes.
  await applyBoardChanges({ ...actor(f), boardId: f.live, changes: [day(f, f.ana, "2026-10-15", { kind: "code", id: f.codeId })] });
  await assert.rejects(publishBoard({ ...actor(f), boardId: f.staged, from: "2026-10-11", through: "2026-10-17" }), (error: unknown) => {
    assert.ok(error instanceof ScheduleError);
    assert.equal(error.code, "schedule_publish_blocked");
    assert.match(error.message, /Ana Field/);
    return true;
  });
  assert.equal(await statusOf(f.org.orgId, b.id), "draft");

  await applyBoardChanges({ ...actor(f), boardId: f.staged, changes: [{ op: "cancel", id: a.id, expectedRevision: 1 }] });
  assert.deepEqual(await publishBoard({ ...actor(f), boardId: f.staged, from: "2026-10-11", through: "2026-10-17" }), {
    published: 1, notices: [], boardName: "Board PLANT",
  });
  assert.equal(await statusOf(f.org.orgId, b.id), "published");
}));

test("a booking key replays its booking and refuses different content", enabled, async () => fixture(async (f) => {
  const booked = day(f, f.ben, "2026-10-16", { kind: "code", id: f.codeId });
  const first = await applyBoardChanges({ ...actor(f), boardId: f.live, changes: [booked] });
  const replay = await applyBoardChanges({ ...actor(f), boardId: f.live, changes: [booked] });
  assert.ok(first.results[0]?.ok && replay.results[0]?.ok);
  assert.equal(replay.results[0].entry?.id, booked.id);
  const reused = await applyBoardChanges({ ...actor(f), boardId: f.live, changes: [{ ...booked, onDate: "2026-10-17" }] });
  assert.equal(reused.results[0]?.ok, false);
  assert.equal(reused.results[0] && !reused.results[0].ok ? reused.results[0].code : null, "schedule_key_reused");
}));

test("a task must belong to the booked project", enabled, async () => fixture(async (f) => {
  const wrong = { ...day(f, f.ana, "2026-10-19", { kind: "project", id: f.projectId }), projectTaskId: f.otherTaskId };
  const right = { ...day(f, f.ben, "2026-10-19", { kind: "project", id: f.projectId }), projectTaskId: f.taskId };
  const { results } = await applyBoardChanges({ ...actor(f), boardId: f.live, changes: [wrong, right] });
  assert.equal(results[0]?.ok, false);
  assert.ok(results[1]?.ok && results[1].entry?.projectTaskId === f.taskId);
}));

test("the window shows other boards' bookings read-only, and pre-fill offers only boards that ask for it", enabled, async () => fixture(async (f) => {
  await applyBoardChanges({ ...actor(f), boardId: f.live, changes: [day(f, f.ana, "2026-10-20", { kind: "project", id: f.projectId })] });
  await applyBoardChanges({ ...actor(f), boardId: f.second, changes: [day(f, f.ana, "2026-10-21", { kind: "code", id: f.codeId })] });
  const window = await loadBoardWindow({ ...actor(f), boardId: f.live, from: "2026-10-18", through: "2026-10-24" });
  assert.equal(window.rows.length, 2);
  assert.deepEqual(window.entries.map((entry) => entry.boardId).sort(), [f.live, f.second].sort());
  assert.equal(window.entries.find((entry) => entry.boardId === f.live)?.workedMinutes, 480);

  const offered = await scheduledWork({ orgId: f.org.orgId, use: "timesheets", workerPartyId: f.ana, from: "2026-10-18", through: "2026-10-24" });
  assert.deepEqual(offered.map((work) => [work.onDate, work.hours, work.projectId]), [["2026-10-20", "8.0000", f.projectId]]);
}));

test('inactive employees retain source-date history without reactivation, hours, or new operational bookings', enabled, async()=>fixture(async f=>{
  await withBypassContext(async()=> {
    affected(await db.execute(sql`update parties set is_active=false where org_id=${f.org.orgId} and id=${f.ana}`),'inactive person');
    affected(await db.execute(sql`update employee_roles set is_active=false where org_id=${f.org.orgId} and party_id=${f.ana}`),'inactive role');
  });
  const payload={id:17,onDate:'2020-01-02',label:'Literal/N',notes:'Retained original instructions'};
  const batch:SourceScheduleBatch={sourceSystem:'Prior scheduling',sourceDataset:'schedule',captureHash:'a'.repeat(64),rows:[{
    sourceKey:'17',sourceHash:sourceHistoryHash(payload),payload,disposition:'recorded',boardId:f.live,workerPartyId:f.ana,
    onDate:'2020-01-02',label:'Literal/N',result:'Exact source description',notes:'Retained original instructions',visibleInSource:false,
    linkedEntryId:null,reason:'Preserve source-date history without altering current employment.',expectedPriorId:null}]};
  const preview=await previewSourceHistory(actor(f),batch);const first=await importSourceHistory(actor(f),batch,preview.approvalHash);
  assert.equal(first[0]?.state,'created');
  const repeated=await previewSourceHistory(actor(f),batch);const replay=await importSourceHistory(actor(f),batch,repeated.approvalHash);
  assert.equal(replay[0]?.state,'unchanged');assert.equal(replay[0]?.id,first[0]?.id);
  const window=await loadBoardWindow({...actor(f),boardId:f.live,from:'2020-01-01',through:'2020-01-03'});
  assert.equal(window.rows.some(r=>r.subjectId===f.ana),true);assert.equal(window.entries.length,0);
  assert.equal(window.sourceRecords?.[0]?.label,'Literal/N');assert.equal(window.sourceRecords?.[0]?.visibleInSource,false);
  const state=await withBypassContext(()=>db.execute<{is_active:boolean}>(sql`select is_active from parties where org_id=${f.org.orgId} and id=${f.ana}`));
  assert.equal(state.rows[0]?.is_active,false);
  await assert.rejects(withBypassContext(()=>db.execute(sql`update schedule_source_records set label='Changed' where org_id=${f.org.orgId} and id=${first[0]!.id}`)),/immutable/);
  const work=await scheduledWork({orgId:f.org.orgId,use:'timesheets',workerPartyId:f.ana,from:'2020-01-01',through:'2020-01-03'});
  assert.deepEqual(work,[]);
  await withBypassContext(()=>db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,hrmShiftPlanning}','false'::jsonb) where id=${f.org.orgId}`));
  await assert.rejects(previewSourceHistory(actor(f),batch),(error:unknown)=>error instanceof ScheduleError && error.code==='schedule_disabled');
  const preserved=await withBypassContext(()=>db.execute(sql`select id from schedule_source_records where org_id=${f.org.orgId}`));
  assert.equal(preserved.rows.length,1);
}));

test('published booking history remains visible after employee deactivation and unknown day policy refuses new whole-day bookings',enabled,async()=>fixture(async f=>{
  const booked=day(f,f.ana,'2026-10-20',{kind:'code',id:f.codeId});
  assert.equal((await applyBoardChanges({...actor(f),boardId:f.live,changes:[booked]})).results[0]?.ok,true);
  await withBypassContext(async()=> {
    affected(await db.execute(sql`update parties set is_active=false where org_id=${f.org.orgId} and id=${f.ana}`),'deactivate person');
    affected(await db.execute(sql`update employee_roles set is_active=false where org_id=${f.org.orgId} and party_id=${f.ana}`),'deactivate role');
    affected(await db.execute(sql`update schedule_boards set day_policy_known=false where org_id=${f.org.orgId} and id=${f.live}`),'unknown day policy');
  });
  const window=await loadBoardWindow({...actor(f),boardId:f.live,from:'2026-10-20',through:'2026-10-20'});
  assert.equal(window.entries[0]?.id,booked.id);assert.equal(window.entries[0]?.workedMinutes,480);
  const refused=await applyBoardChanges({...actor(f),boardId:f.live,changes:[day(f,f.ben,'2026-10-21',null)]});
  assert.equal(refused.results[0]?.ok,false);
  assert.equal(refused.results[0] && !refused.results[0].ok ? refused.results[0].code:null,'schedule_day_policy_missing');
}));

const historyBatch = (f: Fixture, sourceKey: string): SourceScheduleBatch => {
  const payload = { id: sourceKey, date: '2018-03-01', label: 'Original dispatch' };
  return { sourceSystem: 'Previous scheduling', sourceDataset: 'manpower', captureHash: 'b'.repeat(64), rows: [{
    sourceKey, sourceHash: sourceHistoryHash(payload), payload, disposition: 'recorded', boardId: f.live,
    workerPartyId: f.ana, onDate: '2018-03-01', label: 'Original dispatch', result: null, notes: null,
    visibleInSource: true, linkedEntryId: null, reason: 'Retain exact source dates without asserting working hours.', expectedPriorId: null,
  }] };
};

test('source successors require the current assessment and preserve both original evidence and audit', enabled, async()=>fixture(async f=>{
  await withBypassContext(()=>db.execute(sql`update schedule_boards set cell_color_rules='[{"field":"bookingLabel","match":"startsWith","value":"Original","color":"#123456"}]'::jsonb where org_id=${f.org.orgId} and id=${f.live}`));
  const original = historyBatch(f, 'successor');
  const first = await importSourceHistory(actor(f), original, (await previewSourceHistory(actor(f), original)).approvalHash);
  const payload = { ...original.rows[0]!.payload, label: 'Corrected source dispatch' };
  const changed: SourceScheduleBatch = { ...original, rows: [{ ...original.rows[0]!, payload, sourceHash: sourceHistoryHash(payload), label: 'Corrected source dispatch' }] };
  await assert.rejects(previewSourceHistory(actor(f), changed), (error:unknown)=>error instanceof ScheduleError && error.code === 'schedule_source_stale');
  const successor = { ...changed, rows: [{ ...changed.rows[0]!, expectedPriorId: first[0]!.id }] };
  const before = await loadBoardWindow({...actor(f),boardId:f.live,from:'2018-03-01',through:'2018-03-01'});
  assert.equal(before.sourceRecords?.[0]?.color,'#123456');
  const next = await importSourceHistory(actor(f), successor, (await previewSourceHistory(actor(f), successor)).approvalHash);
  assert.notEqual(next[0]!.id, first[0]!.id);
  const window = await loadBoardWindow({ ...actor(f), boardId:f.live, from:'2018-03-01', through:'2018-03-01' });
  assert.deepEqual(window.sourceRecords?.map(record=>record.label), ['Corrected source dispatch']);
  const retained = await withBypassContext(()=>db.execute<{label:string;supersedes_id:string|null}>(sql`
    select label,supersedes_id from schedule_source_records where org_id=${f.org.orgId} order by created_at,id`));
  assert.equal(retained.rows.length,2);
  assert.ok(retained.rows.some(row=>row.label==='Original dispatch' && row.supersedes_id===null));
  assert.ok(retained.rows.some(row=>row.supersedes_id===first[0]!.id));
  const audit = await withBypassContext(()=>db.execute(sql`select id from audit_log where org_id=${f.org.orgId}
    and table_name='schedule_source_records' and actor_id=${f.actorId}`));
  assert.equal(audit.rows.length,2);
}));

test('source evidence and its audit roll back together and concurrent previews cannot create duplicate heads', enabled, async()=>fixture(async f=>{
  const first = historyBatch(f, 'atomic');
  const second = historyBatch(f, 'atomic-second');
  const batch = { ...first, rows:[...first.rows,...second.rows] };
  const preview = await previewSourceHistory(actor(f), batch);
  await assert.rejects(withOrgTransaction(f.org.orgId,async()=> {
    await importSourceHistory(actor(f),batch,preview.approvalHash);
    throw new Error('Reject the enclosing business operation');
  }),/enclosing business operation/);
  const empty = await withBypassContext(()=>db.execute<{records:string;audits:string}>(sql`select
    (select count(*)::text from schedule_source_records where org_id=${f.org.orgId}) records,
    (select count(*)::text from audit_log where org_id=${f.org.orgId} and table_name='schedule_source_records') audits`));
  assert.deepEqual(empty.rows[0],{records:'0',audits:'0'});
  const attempts = await Promise.allSettled([
    importSourceHistory(actor(f),batch,preview.approvalHash), importSourceHistory(actor(f),batch,preview.approvalHash),
  ]);
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
  const refused = attempts.find(result=>result.status==='rejected');
  assert.ok(refused?.status==='rejected' && refused.reason instanceof ScheduleError && refused.reason.code==='schedule_source_stale');
  const repeated = await importSourceHistory(actor(f),batch,(await previewSourceHistory(actor(f),batch)).approvalHash);
  assert.deepEqual(repeated.map(row=>row.state),['unchanged','unchanged']);
}));

test("boards and bookings stay inside their organization", enabled, async () => fixture(async (f) => {
  const outsider = await withBypassContext(() => createScratchOrg());
  try {
    const outsiderActor = await withBypassContext(async () => {
      const id = await createScratchUser(outsider.orgId, "Other dispatcher", "dispatcher");
      await grantScheduling(outsider.orgId, "dispatcher");
      return id;
    });
    await withBypassContext(() => db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"hrm":true,"hrmShiftPlanning":true}'::jsonb) where id = ${outsider.orgId}`));
    await assert.rejects(loadBoardWindow({ orgId: outsider.orgId, actorId: outsiderActor, boardId: f.live, from: "2026-10-18" }), ScopeNotFoundError);
    await assert.rejects(previewSourceHistory({orgId:outsider.orgId,actorId:outsiderActor},historyBatch(f,'isolated')),ScopeNotFoundError);
    await assert.rejects(
      applyBoardChanges({ orgId: outsider.orgId, actorId: outsiderActor, boardId: f.live, changes: [day(f, f.ana, "2026-10-22", null)] }),
      ScopeNotFoundError,
    );
  } finally {
    await dropScratchOrgReporting(outsider.orgId);
  }
}));

async function resourceFixture(f: Fixture, kind: 'equipment' | 'location') {
  const subjectId = randomUUID(), first = randomUUID(), second = randomUUID();
  await withBypassContext(async () => {
    if (kind === 'equipment') affected(await db.execute(sql`insert into equipment_units(id,org_id,subsidiary_id,unit_number,name,status)
      values (${subjectId},${f.org.orgId},${f.org.subsidiaryId},${`UNIT-${subjectId.slice(0,8)}`},'Shared lift','active')`), 'equipment setup');
    else affected(await db.execute(sql`insert into locations(id,org_id,subsidiary_id,code,name,is_active)
      values (${subjectId},${f.org.orgId},${f.org.subsidiaryId},${`ROOM-${subjectId.slice(0,8)}`},'Meeting room',true)`), 'location setup');
    for (const [id, policy] of [[first,'live'],[second,'staged']] as const) affected(await db.execute(sql`
      insert into schedule_boards(id,org_id,code,name,row_kind,resource_kind,views,default_view,time_zone,publish_policy)
      values (${id},${f.org.orgId},${`RESOURCE-${id.slice(0,8)}`},'Shared resources','resources',${kind},'{grid,timeline}','grid','America/Toronto',${policy})`), 'resource board setup');
  });
  const create = (onDate: string): Extract<BoardChange,{ op: 'create' }> => ({ op:'create',id:randomUUID(),subject:{ kind,id:subjectId },onDate,target:{ kind:'project',id:f.projectId },span:{ mode:'day' } });
  return { subjectId, first, second, create };
}

for (const kind of ['equipment','location'] as const) test(`${kind} reservations share cross-board overlap guards and immutable replacement history`, enabled, async () => fixture(async (f) => {
  const resources = await resourceFixture(f, kind);
  const booked = resources.create('2026-10-23');
  const first = await applyBoardChanges({ ...actor(f),boardId:resources.first,changes:[booked] });
  assert.ok(first.results[0]?.ok && first.results[0].entry?.subjectId === resources.subjectId);
  assert.equal(first.results[0].entry.workerPartyId,null);
  const replay = await applyBoardChanges({ ...actor(f),boardId:resources.first,changes:[booked] });
  assert.ok(replay.results[0]?.ok && replay.results[0].entry?.id === booked.id);
  const clash = resources.create('2026-10-23');
  const next = resources.create('2026-10-24');
  await applyBoardChanges({ ...actor(f),boardId:resources.second,changes:[clash,next] });
  await assert.rejects(publishBoard({ ...actor(f),boardId:resources.second,from:'2026-10-23',through:'2026-10-24' }), (error:unknown) => error instanceof ScheduleError && error.code === 'schedule_publish_blocked');
  assert.equal(await statusOf(f.org.orgId,next.id),'draft');
  const updated = await applyBoardChanges({ ...actor(f),boardId:resources.first,changes:[{ op:'update',id:booked.id,expectedRevision:1,fields:{ detail:'East area' } }] });
  assert.ok(updated.results[0]?.ok && updated.results[0].entry?.supersedesId === booked.id);
  assert.equal(await statusOf(f.org.orgId,booked.id),'cancelled');
  const window = await loadBoardWindow({ ...actor(f),boardId:resources.second,from:'2026-10-23',through:'2026-10-24' });
  assert.ok(window.rows.some(row => row.subjectId === resources.subjectId && row.subjectKind === kind));
  assert.deepEqual(window.absences,[]);
  assert.equal(window.board.showTotals,false);
  await withBypassContext(()=>db.execute(kind==='equipment'
    ? sql`update equipment_units set status='inactive' where org_id=${f.org.orgId} and id=${resources.subjectId}`
    : sql`update locations set is_active=false where org_id=${f.org.orgId} and id=${resources.subjectId}`));
  const historical=await loadBoardWindow({...actor(f),boardId:resources.first,from:'2026-10-23',through:'2026-10-23'});
  assert.ok(historical.rows.some(row=>row.subjectId===resources.subjectId));
  assert.ok(historical.entries.some(entry=>entry.subjectId===resources.subjectId));
  const wrong = await applyBoardChanges({ ...actor(f),boardId:resources.first,changes:[day(f,f.ana,'2026-10-25',null)] });
  assert.equal(wrong.results[0]?.ok,false);
  assert.equal(wrong.results[0] && !wrong.results[0].ok ? wrong.results[0].code : null,'schedule_wrong_subject');
}));
