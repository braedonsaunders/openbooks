/**
 * HR-20 clock pairing proofs (DB-owned — gated remotely).
 *
 * - D6: a clock-out before its clock-in refuses by name; the pair is
 *   never marked paired around a missing entry.
 * - D7: the declared unpaid break is deducted once per shift, never once
 *   per project segment.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../../testing/fixtures.ts";
import { recordClockEvent } from "./clock.ts";
import { FieldTimeError } from "./errors.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableFieldTime(orgId: string, fieldTimeExtra: Record<string, unknown> = {}): Promise<void> {
  const fieldTime = {
    roundingIncrement: 15,
    roundingMode: "nearest",
    unpaidBreakMinutes: 30,
    autoCloseHours: 16,
    signatureRequired: false,
    equipmentToleranceHours: "1.0000",
    photoRequired: false,
    ...fieldTimeExtra,
  };
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
      || '{"projects": true, "timeTracking": true, "fieldTime": true, "fieldTimeGeofence": true,
             "fieldTimePhoto": false, "fieldTimeKiosk": true, "fieldTimeCrewEntry": true,
             "fieldTimeEquipment": true, "fieldTimeMultiStageApproval": true, "equipment": true}')
     where id = ${orgId}`);
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{fieldTime}',
      ${JSON.stringify(fieldTime)}::jsonb)
     where id = ${orgId}`);
}

function refusesCode(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => { throw new Error("expected a refusal"); },
    (error) => {
      assert.ok(error instanceof FieldTimeError, `refusal is a FieldTimeError, got ${String(error)}`);
      return (error as FieldTimeError).code;
    },
  );
}

async function seedWorker(orgId: string, subsidiaryId: string, worker: string, projectId: string | null): Promise<void> {
  await withOrg(orgId, async () => {
    await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${worker}, ${orgId}, 'person', 'Crew Hand')`);
    if (projectId) {
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom) values (${projectId}, ${orgId}, ${subsidiaryId}, 'JOB-FT', 'Field job', 'active', true, '{}'::jsonb)`);
    }
  });
}

test("a clock-out before its clock-in refuses and leaves the pair open", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const worker = randomUUID();
    const projectId = randomUUID();
    await seedWorker(org.orgId, org.subsidiaryId, worker, projectId);
    await withOrg(org.orgId, () => recordClockEvent({
      orgId: org.orgId, actorUserId: null, employeePartyId: worker,
      kind: "clock_in", occurredAt: "2026-09-14T11:00:00.000Z",
      source: "mobile", projectId, clientEventId: randomUUID(),
    }));
    const code = await withOrg(org.orgId, () =>
      refusesCode(() => recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_out", occurredAt: "2026-09-14T10:30:00.000Z",
        source: "mobile", projectId, clientEventId: randomUUID(),
      })));
    assert.equal(code, "event_before_open");
    await withOrg(org.orgId, async () => {
      // No entry was posted for the refused close …
      const entries = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from time_entries where org_id = ${org.orgId}`)).rows[0]?.n;
      assert.equal(entries, "0");
      // … and the clock-in is still open, never silently paired.
      const open = (await db.execute<{ status: string }>(sql`
        select status from time_clock_events
         where org_id = ${org.orgId} and kind = 'clock_in'`)).rows;
      assert.equal(open.length, 1);
      assert.equal(open[0]?.status, "recorded");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a mid-shift project switch deducts the unpaid break once per shift", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const worker = randomUUID();
    const projectA = randomUUID();
    const projectB = randomUUID();
    await seedWorker(org.orgId, org.subsidiaryId, worker, null);
    await withOrg(org.orgId, async () => {
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom) values
        (${projectA}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-A', 'Field job A', 'active', true, '{}'::jsonb),
        (${projectB}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-B', 'Field job B', 'active', true, '{}'::jsonb)`);
      // 08:00-16:00 with a noon switch and a 30-minute declared break.
      await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_in", occurredAt: "2026-09-14T08:00:00.000Z",
        source: "mobile", projectId: projectA, clientEventId: randomUUID(),
      });
      const switched = await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "switch", occurredAt: "2026-09-14T12:00:00.000Z",
        source: "mobile", projectId: projectB, clientEventId: randomUUID(),
      });
      // The switch re-targets the open pair without closing or posting.
      assert.deepEqual(switched.entryIds, []);
      assert.ok(switched.pairId, "the switch stays on the open pair");
      const result = await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_out", occurredAt: "2026-09-14T16:00:00.000Z",
        source: "mobile", projectId: projectB, clientEventId: randomUUID(),
      });
      assert.equal(result.entryIds.length, 2);
      const rows = (await db.execute<{ hours: string; project_id: string }>(sql`
        select hours::text as hours, project_id::text as project_id from time_entries
         where org_id = ${org.orgId} and employee_party_id = ${worker}
         order by project_id`)).rows;
      // 7.5 paid hours, dealt 3.75 + 3.75 — never 7h from a per-segment deduction.
      assert.deepEqual(rows.map((r) => r.hours), ["3.7500", "3.7500"]);
      assert.deepEqual(rows.map((r) => r.project_id).sort(), [projectA, projectB].sort());
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
