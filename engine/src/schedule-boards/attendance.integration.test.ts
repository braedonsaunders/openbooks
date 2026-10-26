import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  addAttendancePolicy,
  admitAttendanceBatch,
  attendanceExceptions,
  closeShift,
  listAttendanceDevices,
  processBoardAttendance,
  saveAttendanceDevice,
  saveAttendanceIdentity,
  type SourceCheckIn,
} from "./attendance.ts";
import { applyBoardChanges } from "./entries.ts";
import { ScheduleError } from "./errors.ts";
import { loadBoardWindow } from "./window.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const affected = (result: { rowCount: number | null }, label: string) => {
  if (result.rowCount !== 1) throw new Error(`${label} did not affect one row`);
};

type Fixture = {
  orgId: string;
  subsidiaryId: string;
  actorId: string;
  ana: string;
  board: string;
  day: string;
};

async function fixture(
  run: (f: Fixture) => Promise<void>,
  features = '{"hrm":true,"hrmShiftPlanning":true,"hrmAttendance":true,"hrmShiftClosing":true}',
): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const ids = await withBypassContext(async () => {
      const actorId = await createScratchUser(org.orgId, "Supervisor", "supervisor");
      affected(
        await db.execute<never>(sql`update app_roles set permissions = '["hrm.shifts.read","hrm.shifts.manage","hrm.shifts.approve","hrm.attendance.read","hrm.attendance.manage"]'::jsonb
        where org_id = ${org.orgId} and key = 'supervisor'`),
        "permissions",
      );
      affected(
        await db.execute<never>(
          sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${features}::jsonb) where id = ${org.orgId}`,
        ),
        "features",
      );
      const ana = randomUUID();
      affected(
        await db.execute<never>(
          sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${ana}, ${org.orgId}, 'person', 'Ana Nurse', ${org.subsidiaryId}, true, '{}'::jsonb)`,
        ),
        "person",
      );
      affected(
        await db.execute<never>(
          sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${org.orgId}, ${ana}, 'Nurse', '2026-01-01', true)`,
        ),
        "role",
      );
      const board = randomUUID();
      affected(
        await db.execute<never>(sql`insert into schedule_boards (id, org_id, code, name, row_kind, board_type, views, default_view, grain, time_zone, publish_policy)
        values (${board}, ${org.orgId}, 'WARD', 'Ward', 'people', 'shift_roster', '{timeline}', 'timeline', 'timed', 'UTC', 'live')`),
        "board",
      );
      const today = (
        await db.execute<{ today: string }>(
          sql`select (now() at time zone 'UTC')::date::text as today`,
          "objects",
        )
      )[0]!.today;
      return { actorId, ana, board, day: addCalendarDays(today, -2) };
    });
    await run({ orgId: org.orgId, subsidiaryId: org.subsidiaryId, ...ids });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

const actor = (f: Fixture) => ({ orgId: f.orgId, actorId: f.actorId });
const at = (f: Fixture, time: string) => `${f.day}T${time}.000Z`;
const event = (
  f: Fixture,
  sourceEventId: string,
  kind: SourceCheckIn["kind"],
  time: string,
  version = 1,
  supersedesId: string | null = null,
): SourceCheckIn => ({
  id: randomUUID(),
  sourceEventId,
  sourceVersion: version,
  sourceWorkerId: "B-17",
  kind,
  occurredAt: at(f, time),
  sourcePayload: { terminal: "Front door" },
  supersedesId,
});

async function setup(f: Fixture) {
  const booking = randomUUID();
  const booked = await applyBoardChanges({
    ...actor(f),
    boardId: f.board,
    changes: [
      {
        op: "create",
        id: booking,
        workerPartyId: f.ana,
        onDate: f.day,
        target: null,
        span: { mode: "timed", starts: "09:00", ends: "17:00", breakMinutes: 30 },
      },
    ],
  });
  assert.equal(booked.results[0]?.ok, true);
  await addAttendancePolicy(actor(f), {
    boardId: f.board,
    effectiveFrom: addCalendarDays(f.day, -30),
    captureBeforeMinutes: 60,
    captureAfterMinutes: 60,
    lateGraceMinutes: 5,
    earlyGraceMinutes: 5,
    breakGraceMinutes: 10,
    reason: "Ward attendance",
  });
  const device = await saveAttendanceDevice(actor(f), {
    subsidiaryId: f.subsidiaryId,
    code: "WARD-CLOCK",
    name: "Ward clock",
    timeZone: "UTC",
    isActive: true,
    reason: "Install",
  });
  await saveAttendanceIdentity(actor(f), {
    deviceId: device.id,
    sourceWorkerId: "B-17",
    workerPartyId: f.ana,
    effectiveFrom: addCalendarDays(f.day, -30),
    effectiveTo: null,
    reason: "Badge issued",
  });
  return { booking, device: device.id };
}

test(
  "check-in batches replay idempotently and refuse contradictory source versions",
  enabled,
  async () =>
    fixture(async (f) => {
      const { device } = await setup(f);
      const batchKey = randomUUID();
      const events = [
        event(f, "E1", "clock_in", "09:10:00"),
        event(f, "E2", "clock_out", "17:00:00"),
      ];
      const input = {
        ...actor(f),
        id: batchKey,
        deviceId: device,
        completeThrough: at(f, "18:30:00"),
        sourceEvidence: { source: "ward-clock export" },
        events,
        reason: "Nightly sync",
      };
      const first = await admitAttendanceBatch(input);
      assert.equal(first.eventCount, 2);
      const replay = await admitAttendanceBatch(input);
      assert.deepEqual(
        [replay.id, replay.eventCount],
        [first.id, 2],
        "the same request key and content return the original batch",
      );
      await assert.rejects(
        admitAttendanceBatch({ ...input, reason: "Different" }),
        (error: unknown) => error instanceof ScheduleError && error.code === "schedule_key_reused",
      );
      const resent = await admitAttendanceBatch({
        ...input,
        id: randomUUID(),
        completeThrough: at(f, "19:00:00"),
        events: events.map((item) => ({ ...item, id: randomUUID() })),
      });
      assert.deepEqual(
        [resent.eventCount, resent.replayedEventIds.length],
        [0, 2],
        "a resent source version is recorded as replayed, never duplicated",
      );
      await assert.rejects(
        admitAttendanceBatch({
          ...input,
          id: randomUUID(),
          events: [{ ...events[0]!, id: randomUUID(), occurredAt: at(f, "09:20:00") }],
        }),
        (error: unknown) =>
          error instanceof ScheduleError && error.code === "schedule_attendance_conflict",
      );
      const count = await withBypassContext(() =>
        db.execute<{ n: number }>(
          sql`select count(*)::int as n from schedule_attendance_events where org_id = ${f.orgId}`,
          "objects",
        ),
      );
      assert.equal(count[0]!.n, 2);
      // A record inside declared completeness needs an explicit correction batch.
      await assert.rejects(
        admitAttendanceBatch({
          ...input,
          id: randomUUID(),
          events: [event(f, "E9", "break_start", "12:00:00")],
        }),
        /correction batch/,
      );
    }),
);

test(
  "attendance observes late arrival against the published booking and corrections supersede it",
  enabled,
  async () =>
    fixture(async (f) => {
      const { booking, device } = await setup(f);
      const clockIn = event(f, "E1", "clock_in", "09:10:00");
      await admitAttendanceBatch({
        ...actor(f),
        id: randomUUID(),
        deviceId: device,
        completeThrough: at(f, "18:30:00"),
        sourceEvidence: { source: "ward-clock export" },
        events: [clockIn, event(f, "E2", "clock_out", "17:00:00")],
        reason: "Nightly sync",
      });
      const [observed] = await processBoardAttendance({
        ...actor(f),
        boardId: f.board,
        from: f.day,
        through: f.day,
      });
      assert.ok(observed?.ok && observed.status === "present" && !observed.unchanged);
      const again = await processBoardAttendance({
        ...actor(f),
        boardId: f.board,
        from: f.day,
        through: f.day,
      });
      assert.ok(
        again[0]?.ok && again[0].unchanged,
        "processing unchanged evidence records nothing new",
      );
      const window = await loadBoardWindow({
        ...actor(f),
        boardId: f.board,
        from: f.day,
        through: f.day,
      });
      assert.deepEqual(window.entries.find((entry) => entry.id === booking)?.attendance, {
        status: "present",
        late: true,
        leftEarly: false,
        overBreak: false,
      });
      const exceptions = await attendanceExceptions({ ...actor(f), from: f.day, through: f.day });
      assert.deepEqual(
        exceptions.map((row) => [row.entryId, row.late]),
        [[booking, true]],
      );

      // The device corrects the clock-in to 09:02: the correction releases the
      // earlier attribution and reprocessing supersedes the observation.
      await admitAttendanceBatch({
        ...actor(f),
        id: randomUUID(),
        deviceId: device,
        completeThrough: at(f, "18:30:00"),
        correction: true,
        sourceEvidence: { source: "ward-clock correction" },
        events: [event(f, "E1", "clock_in", "09:02:00", 2, clockIn.id)],
        reason: "Clock drift corrected",
      });
      const [corrected] = await processBoardAttendance({
        ...actor(f),
        boardId: f.board,
        from: f.day,
        through: f.day,
      });
      assert.ok(corrected?.ok && !corrected.unchanged);
      assert.equal(
        (await attendanceExceptions({ ...actor(f), from: f.day, through: f.day })).length,
        0,
      );
      const chain = await withBypassContext(() =>
        db.execute<{ n: number }>(
          sql`select count(*)::int as n from schedule_attendance_observations where org_id = ${f.orgId} and entry_id = ${booking}`,
          "objects",
        ),
      );
      assert.equal(chain[0]!.n, 2, "the original observation is retained as history");

      // A closed shift is final.
      const [entry] = await withBypassContext(() =>
        db.execute<{ revision: number }>(
          sql`select revision from schedule_entries where org_id = ${f.orgId} and id = ${booking}`,
          "objects",
        ),
      );
      await closeShift({
        ...actor(f),
        boardId: f.board,
        entryId: booking,
        expectedRevision: entry!.revision,
        reason: "Attendance reviewed",
      });
      const change = await applyBoardChanges({
        ...actor(f),
        boardId: f.board,
        changes: [{ op: "cancel", id: booking, expectedRevision: entry!.revision + 1 }],
      });
      assert.equal(change.results[0]?.ok === false && change.results[0].code, "schedule_closed");
    }),
);

test(
  "an unmapped worker or a missing policy is refused with its remedy, and devices stay inside their organization",
  enabled,
  async () =>
    fixture(async (f) => {
      const { device } = await setup(f);
      await assert.rejects(
        admitAttendanceBatch({
          ...actor(f),
          id: randomUUID(),
          deviceId: device,
          completeThrough: null,
          sourceEvidence: { source: "export" },
          events: [{ ...event(f, "X1", "clock_in", "09:00:00"), sourceWorkerId: "UNKNOWN" }],
          reason: "Sync",
        }),
        (error: unknown) =>
          error instanceof ScheduleError && error.code === "schedule_attendance_unmapped",
      );
      const other = await withBypassContext(() => createScratchOrg());
      try {
        const stranger = await withBypassContext(async () => {
          const user = await createScratchUser(other.orgId, "Stranger", "supervisor");
          affected(
            await db.execute<never>(
              sql`update app_roles set permissions = '["hrm.attendance.read","hrm.attendance.manage"]'::jsonb where org_id = ${other.orgId} and key = 'supervisor'`,
            ),
            "permissions",
          );
          affected(
            await db.execute<never>(
              sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"hrm":true,"hrmAttendance":true}'::jsonb) where id = ${other.orgId}`,
            ),
            "features",
          );
          return user;
        });
        await assert.rejects(
          admitAttendanceBatch({
            orgId: other.orgId,
            actorId: stranger,
            id: randomUUID(),
            deviceId: device,
            completeThrough: null,
            sourceEvidence: { source: "export" },
            events: [],
            reason: "Probe",
          }),
          (error: unknown) => error instanceof ScopeNotFoundError,
        );
        assert.deepEqual(
          (await listAttendanceDevices(actor(f))).map((row) => row.id),
          [device],
          "the import picker lists the organization's active device",
        );
        assert.deepEqual(
          await listAttendanceDevices({ orgId: other.orgId, actorId: stranger }),
          [],
          "another organization never sees the device",
        );
      } finally {
        await dropScratchOrgReporting(other.orgId);
      }
    }),
);

test(
  "attendance identity requires a person and explicit employment in the device legal entity",
  enabled,
  async () =>
    fixture(async (f) => {
      const device = await saveAttendanceDevice(actor(f), {
        subsidiaryId: f.subsidiaryId,
        code: "ENTITY-CLOCK",
        name: "Entity clock",
        timeZone: "UTC",
        isActive: true,
        reason: "Install",
      });
      const branchId = randomUUID();
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${branchId}, ${f.orgId}, ${f.subsidiaryId}, 'Attendance Branch', 'CAD', 'CA')`);
      const branchEmploymentId = randomUUID();
      await db.execute(sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${branchEmploymentId}, ${f.orgId}, ${f.ana}, ${branchId}, 1)`);
      await assert.rejects(
        saveAttendanceIdentity(actor(f), {
          deviceId: device.id,
          sourceWorkerId: "BRANCH-EMPLOYMENT",
          workerPartyId: f.ana,
          employmentId: branchEmploymentId,
          effectiveFrom: f.day,
          effectiveTo: null,
          reason: "Check entity assignment",
        }),
        (error: unknown) =>
          error instanceof ScheduleError && error.code === "schedule_employment_unavailable",
      );

      const branchPersonId = randomUUID();
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${branchPersonId}, ${f.orgId}, 'person', 'Branch Nurse', ${branchId}, true, '{}'::jsonb)`);
      await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active)
    values (${f.orgId}, ${branchPersonId}, 'Nurse', '2026-01-01', true)`);
      await assert.rejects(
        saveAttendanceIdentity(actor(f), {
          deviceId: device.id,
          sourceWorkerId: "BRANCH-PERSON",
          workerPartyId: branchPersonId,
          employmentId: null,
          effectiveFrom: f.day,
          effectiveTo: null,
          reason: "Check employee entity",
        }),
        (error: unknown) =>
          error instanceof ScheduleError && error.code === "schedule_person_unavailable",
      );
      const saved = await withBypassContext(() =>
        db.execute<{ n: number }>(
          sql`select count(*)::int as n from schedule_attendance_identities where org_id = ${f.orgId}`,
          "objects",
        ),
      );
      assert.equal(saved[0]!.n, 0, "incompatible identity references are never stored");
    }),
);

test(
  "a subsidiary-restricted caller cannot change an organization-wide attendance policy",
  enabled,
  async () =>
    fixture(async (f) => {
      await withBypassContext(() =>
        db.execute(
          sql`update app_roles set subsidiary_restriction = ${JSON.stringify({
            mode: "list",
            subsidiaryIds: [f.subsidiaryId],
          })}::jsonb where org_id = ${f.orgId} and key = 'supervisor'`,
        ),
      );
      await assert.rejects(
        addAttendancePolicy(actor(f), {
          boardId: f.board,
          effectiveFrom: f.day,
          captureBeforeMinutes: 60,
          captureAfterMinutes: 60,
          lateGraceMinutes: 5,
          earlyGraceMinutes: 5,
          breakGraceMinutes: 10,
          reason: "Entity-scoped policy test",
        }),
        (error: unknown) =>
          error instanceof ScheduleError && error.status === 403 && error.code === "schedule_scope",
      );
      const policies = await withBypassContext(() =>
        db.execute<{ n: number }>(
          sql`select count(*)::int as n from schedule_attendance_policies where org_id = ${f.orgId}`,
          "objects",
        ),
      );
      assert.equal(policies[0]!.n, 0);
    }),
);
