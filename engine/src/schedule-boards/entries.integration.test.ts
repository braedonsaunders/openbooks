import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { applyBoardChanges, publishBoard, type BoardChange } from "./entries.ts";
import { ScheduleError } from "./errors.ts";
import { scheduledWork } from "./prefill.ts";
import { loadBoardWindow } from "./window.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
type Org = Awaited<ReturnType<typeof createScratchOrg>>;
type Fixture = { org: Org; actorId: string; ana: string; ben: string; projectId: string; otherProjectId: string; taskId: string; otherTaskId: string; codeId: string; live: string; staged: string; second: string };

const affected = (result: { rowCount: number | null }, label: string) => {
  if (result.rowCount !== 1) throw new Error(`${label} did not affect one row`);
};

async function grantScheduling(orgId: string, roleKey: string): Promise<void> {
  affected(await db.execute(sql`update app_roles set permissions = '["hrm.shifts.read","hrm.shifts.manage","hrm.shifts.approve"]'::jsonb
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
        || '{"hrm":true,"hrmShiftPlanning":true,"projects":true}'::jsonb) where id = ${org.orgId}`), "feature setup");
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
  assert.deepEqual(await publishBoard({ ...actor(f), boardId: f.staged, from: "2026-10-11", through: "2026-10-17" }), { published: 1 });
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
  assert.equal(window.people.length, 2);
  assert.deepEqual(window.entries.map((entry) => entry.boardId).sort(), [f.live, f.second].sort());
  assert.equal(window.entries.find((entry) => entry.boardId === f.live)?.workedMinutes, 480);

  const offered = await scheduledWork({ orgId: f.org.orgId, use: "timesheets", workerPartyId: f.ana, from: "2026-10-18", through: "2026-10-24" });
  assert.deepEqual(offered.map((work) => [work.onDate, work.hours, work.projectId]), [["2026-10-20", "8.0000", f.projectId]]);
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
    await assert.rejects(
      applyBoardChanges({ orgId: outsider.orgId, actorId: outsiderActor, boardId: f.live, changes: [day(f, f.ana, "2026-10-22", null)] }),
      ScopeNotFoundError,
    );
  } finally {
    await dropScratchOrgReporting(outsider.orgId);
  }
}));
