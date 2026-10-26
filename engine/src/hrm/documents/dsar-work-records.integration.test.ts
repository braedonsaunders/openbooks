import { installEngineSeams } from "../../composition/install.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { DB, setupHarness, seedEmployment, withHarness } from "../../testing/hrm-harness.ts";
import { exportedSubjectEvidence } from "../../testing/dsar-fixture.ts";
import {
  addAttendancePolicy,
  admitAttendanceBatch,
  processBoardAttendance,
  saveAttendanceDevice,
  saveAttendanceIdentity,
} from "../../schedule-boards/attendance.ts";
import { applyBoardChanges } from "../../schedule-boards/entries.ts";

const spec = {
  country: "CA",
  features: ["hrm", "hrmShiftPlanning", "hrmAttendance"],
  users: [
    {
      key: "authorId",
      name: "Roster author",
      handle: "export_roster_author",
      link: true,
      permissions: [
        "hrm.shifts.read",
        "hrm.shifts.manage",
        "hrm.attendance.read",
        "hrm.attendance.manage",
      ],
    },
  ],
} as const;

async function setup() {
  installEngineSeams();
  return setupHarness(spec, async (f) => {
    const actor = { orgId: f.org.orgId, actorId: f.authorId };
    const board = randomUUID();
    await db.execute(sql`insert into schedule_boards (id, org_id, code, name, row_kind, board_type, views, default_view, grain, time_zone, publish_policy)
      values (${board}, ${f.org.orgId}, 'ROSTER', 'Roster', 'people', 'shift_roster', '{timeline}', 'timeline', 'timed', 'Etc/UTC', 'live')`);
    await addAttendancePolicy(actor, {
      boardId: board,
      effectiveFrom: "2026-01-01",
      captureBeforeMinutes: 0,
      captureAfterMinutes: 0,
      lateGraceMinutes: 0,
      earlyGraceMinutes: 0,
      breakGraceMinutes: 0,
      reason: "Workplace attendance",
    });
    const device = await saveAttendanceDevice(actor, {
      subsidiaryId: f.org.subsidiaryId,
      code: "CLOCK",
      name: "Workplace device",
      timeZone: "Etc/UTC",
      isActive: true,
      reason: "Declared source device",
    });
    const subjects: {
      workerPartyId: string;
      employmentId: string;
      entryId: string;
      identityId: string;
    }[] = [];
    for (const displayName of ["Subject", "Neighbor"]) {
      const worker = await seedEmployment(f.org.orgId, f.org.subsidiaryId, {
        displayName,
        from: "2026-01-01",
      });
      await db.execute(
        sql`update parties set subsidiary_id = ${f.org.subsidiaryId} where org_id = ${f.org.orgId} and id = ${worker.workerPartyId}`,
      );
      await db.execute(
        sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${f.org.orgId}, ${worker.workerPartyId}, 'Operator', '2026-01-01', true)`,
      );
      const entryId = randomUUID();
      const booked = await applyBoardChanges({
        ...actor,
        boardId: board,
        changes: [
          {
            op: "create",
            id: entryId,
            workerPartyId: worker.workerPartyId,
            onDate: "2026-01-09",
            target: null,
            span: { mode: "timed", starts: "09:00", ends: "17:00", breakMinutes: 0 },
          },
        ],
      });
      assert.equal(booked.results[0]?.ok, true);
      const identity = await saveAttendanceIdentity(actor, {
        deviceId: device.id,
        sourceWorkerId: worker.workerPartyId,
        workerPartyId: worker.workerPartyId,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        reason: "Dated native worker binding",
      });
      subjects.push({ ...worker, entryId, identityId: identity.id });
    }
    await admitAttendanceBatch({
      ...actor,
      id: randomUUID(),
      deviceId: device.id,
      completeThrough: "2026-01-09T18:00:00.000Z",
      sourceEvidence: { source: "Original device export" },
      reason: "Reviewed event admission",
      events: subjects.flatMap((subject) =>
        (["clock_in", "clock_out"] as const).map((kind, index) => ({
          id: randomUUID(),
          sourceEventId: `${subject.workerPartyId}-${index}`,
          sourceWorkerId: subject.workerPartyId,
          sourceVersion: 1,
          kind,
          occurredAt: `2026-01-09T${index ? "17" : "09"}:00:00.000Z`,
          supersedesId: null,
          sourcePayload: { worker: subject.workerPartyId, recordedByDevice: true },
        })),
      ),
    });
    const outcomes = await processBoardAttendance({
      ...actor,
      boardId: board,
      from: "2026-01-09",
      through: "2026-01-09",
    });
    assert.deepEqual(
      outcomes.map((outcome) => outcome.ok && outcome.status),
      ["present", "present"],
    );
    return { subjects };
  });
}

test(
  "native subject ZIP retains roster and device evidence while excluding neighboring workers, tenants and audit operators",
  { skip: !DB },
  async () => {
    await withHarness(setup, async (f) => {
      await withHarness(setup, async (foreign) => {
        const subject = f.subjects[0]!;
        const neighbor = f.subjects[1]!;
        const exported = await exportedSubjectEvidence(
          { orgId: f.org.orgId, actorId: f.authorId, partyId: subject.workerPartyId },
          ["time"],
        );
        for (const [key, count] of [
          ["attendanceDeviceIdentities", 1],
          ["attendanceCheckIns", 2],
          ["attendanceShiftObservations", 1],
          ["attendanceCheckInClaims", 2],
          ["attendanceObservationCheckIns", 2],
        ] as const) {
          const rows = exported[key] as Record<string, unknown>[];
          assert.equal(rows.length, count, `${key} carries all subject evidence`);
          for (const row of rows) {
            for (const column of [
              "org_id",
              "worker_party_id",
              "employment_id",
              "created_by",
              "updated_by",
              "decided_by",
              "released_by",
            ]) {
              assert.ok(!(column in row), `${key} withholds ${column}`);
            }
          }
          const json = JSON.stringify(rows);
          assert.ok(
            !json.includes(neighbor.workerPartyId),
            `${key} excludes a worker sharing the same device`,
          );
          assert.equal(foreign.subjects.length, 2, "the foreign tenant has its own workers");
          for (const other of foreign.subjects)
            assert.ok(!json.includes(other.workerPartyId), `${key} excludes another tenant`);
        }
        assert.equal(
          (exported.attendanceDeviceIdentities as Record<string, unknown>[])[0]!.id,
          subject.identityId,
        );
        const observation = (exported.attendanceShiftObservations as Record<string, unknown>[])[0]!;
        assert.equal(observation.entry_id, subject.entryId);
        assert.equal(observation.presence_milliseconds, "28800000");
        assert.equal(observation.status, "present");
        assert.equal(
          (exported.attendanceCheckIns as Record<string, unknown>[])[0]!.source_version,
          1,
        );
      });
    });
  },
);
