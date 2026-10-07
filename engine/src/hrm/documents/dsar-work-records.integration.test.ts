import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DB, setupHarness, seedEmployment, withHarness } from "../../testing/hrm-harness.ts";
import { exportedSubjectEvidence } from "../../testing/dsar-fixture.ts";
import { createIndividualShift, transitionRosterShift } from "../shifts/roster.ts";
import { createAttendanceDevice, createAttendanceIdentity, admitAttendanceBatch } from "../shifts/devices.ts";
import { processShiftAttendance } from "../shifts/attendance.ts";

const spec = {
  country: "CA", features: ["hrm", "hrmShiftPlanning", "hrmAttendance"], users: [
    { key: "authorId", name: "Roster author", handle: "export_roster_author", link: true,
      permissions: ["hrm.shifts.read", "hrm.shifts.manage", "hrm.attendance.manage"] },
    { key: "reviewerId", name: "Roster reviewer", handle: "export_roster_reviewer", link: true,
      permissions: ["hrm.shifts.read", "hrm.shifts.approve"] },
  ],
} as const;

async function setup() {
  return setupHarness(spec, async f => {
    const actor = { orgId: f.org.orgId, actorId: f.authorId };
    const device = await createAttendanceDevice({ ...actor, id: randomUUID(), subsidiaryId: f.org.subsidiaryId,
      code: "CLOCK", name: "Workplace device", timeZone: "Etc/UTC", reason: "Declared source device" });
    const workers = await Promise.all(["Subject", "Neighbor"].map(displayName => seedEmployment(f.org.orgId, f.org.subsidiaryId,
      { displayName, from: "2026-01-01" })));
    const subjects: (Awaited<ReturnType<typeof seedEmployment>> & {
      shift: Awaited<ReturnType<typeof transitionRosterShift>>;
      identity: Awaited<ReturnType<typeof createAttendanceIdentity>>;
    })[] = [];
    for (const [index, worker] of workers.entries()) {
      const created = await createIndividualShift({ ...actor, id: randomUUID(), employmentId: worker.employmentId,
        name: `Workday ${index}`, onDate: "2026-01-09", timeZone: "Etc/UTC", supersedesId: null,
        slot: { position: 0, starts: "09:00", ends: "17:00", endDayOffset: 0, plannedBreakSeconds: 0, qualificationTypeIds: [] },
        attendancePolicy: { captureBeforeSeconds: 0, captureAfterSeconds: 0, lateGraceSeconds: 0, earlyGraceSeconds: 0 },
        reason: "Individual work assignment" });
      const shift = await transitionRosterShift({ ...actor, actorId: f.reviewerId, shiftId: created.id,
        expectedRevision: created.revision, action: "publish", reason: "Reviewed work assignment" });
      const identity = await createAttendanceIdentity({ ...actor, id: randomUUID(), deviceId: device.id,
        sourceWorkerId: worker.workerPartyId, employmentId: worker.employmentId, effectiveFrom: "2026-01-01", effectiveTo: null,
        reason: "Dated native worker binding" });
      subjects.push({ ...worker, shift, identity });
    }
    await admitAttendanceBatch({ ...actor, id: randomUUID(), deviceId: device.id,
      completeThrough: "2026-01-09T18:00:00Z", sourceEvidence: { source: "Original device export" },
      reason: "Reviewed event admission", events: subjects.flatMap(subject => ["clock_in", "clock_out"].map((kind, index) => ({
        id: randomUUID(), sourceEventId: `${subject.workerPartyId}-${index}`, sourceWorkerId: subject.workerPartyId,
        sourceVersion: 1, kind: kind as "clock_in" | "clock_out", occurredAt: `2026-01-09T${index ? "17" : "09"}:00:00Z`,
        supersedesId: null, sourcePayload: { worker: subject.workerPartyId, recordedByDevice: true },
      }))) });
    for (const subject of subjects) {
      const observation = await processShiftAttendance({ ...actor, id: randomUUID(), shiftId: subject.shift.id,
        expectedShiftRevision: subject.shift.revision, supersedesId: null, reason: "Measured source attendance" });
      assert.equal(observation.status, "present");
      assert.equal(observation.presenceMilliseconds, "28800000");
    }
    return { subjects };
  });
}

test("native subject ZIP retains work and device evidence while excluding neighboring workers, tenants and audit operators", { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    await withHarness(setup, async foreign => {
      const subject = f.subjects[0]!;
      const neighbor = f.subjects[1]!;
      const exported = await exportedSubjectEvidence({ orgId: f.org.orgId, actorId: f.authorId, partyId: subject.workerPartyId }, ["time"]);
      for (const [key, count] of [["shifts", 1], ["attendanceIdentities", 1], ["attendanceEvents", 2],
        ["attendanceObservations", 1], ["attendanceEventClaims", 2], ["attendanceObservationEvents", 2]] as const) {
        const rows = exported[key] as Record<string, unknown>[];
        assert.equal(rows.length, count, `${key} carries all subject evidence`);
        for (const row of rows) {
          for (const column of ["org_id", "worker_party_id", "employment_id", "created_by", "updated_by", "author_party_id", "decided_by", "released_by"]) {
            assert.ok(!(column in row), `${key} withholds ${column}`);
          }
        }
        const json = JSON.stringify(rows);
        assert.ok(!json.includes(neighbor.workerPartyId), `${key} excludes a worker sharing the same device`);
        for (const other of foreign.subjects) assert.ok(!json.includes(other.workerPartyId), `${key} excludes another tenant`);
      }
      assert.equal((exported.shifts as Record<string, unknown>[])[0]!.id, subject.shift.id);
      assert.equal((exported.attendanceIdentities as Record<string, unknown>[])[0]!.id, subject.identity.id);
      const observation = (exported.attendanceObservations as Record<string, unknown>[])[0]!;
      assert.equal(observation.presence_milliseconds, "28800000");
      assert.equal(observation.status, "present");
      assert.equal((exported.attendanceEvents as Record<string, unknown>[])[0]!.source_version, 1);
    });
  });
});
