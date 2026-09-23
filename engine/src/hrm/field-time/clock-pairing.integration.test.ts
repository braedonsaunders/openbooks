/**
 * HR-20 clock pairing proofs (DB-owned — gated remotely).
 *
 * - D6: a clock-out before its clock-in refuses by name; the pair is
 *   never marked paired around a missing entry.
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
