/**
 * HR-20 clock pairing proofs (DB-owned — gated remotely).
 *
 * - D6: a clock-out before its clock-in refuses by name; the pair is
 *   never marked paired around a missing entry.
 * - D7: the declared unpaid break is deducted once per shift, never once
 *   per project segment.
 * - D8: rounding happens once per shift and the exact total is dealt
 *   across UTC day pieces by largest remainder.
 * - D9: concurrent replays of one offline id record once; a reused id
 *   with a different payload conflicts.
 * - Business dates: midnight splits day in the org's business timezone,
 *   never UTC.
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

async function enableFieldTime(orgId: string, fieldTimeExtra: Record<string, unknown> = {}, timeZone: string | null = null): Promise<void> {
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
  if (timeZone) {
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{timeZone}',
        ${JSON.stringify(timeZone)}::jsonb)
       where id = ${orgId}`);
  }
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

test("a 23:52-00:08 shift rounds once, never once per midnight piece", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId, { unpaidBreakMinutes: 0 });
    const worker = randomUUID();
    const projectId = randomUUID();
    await seedWorker(org.orgId, org.subsidiaryId, worker, projectId);
    await withOrg(org.orgId, async () => {
      await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_in", occurredAt: "2026-09-14T23:52:00.000Z",
        source: "mobile", projectId, clientEventId: randomUUID(),
      });
      const result = await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_out", occurredAt: "2026-09-15T00:08:00.000Z",
        source: "mobile", projectId, clientEventId: randomUUID(),
      });
      // 16 minutes round once to a single quarter — per-piece rounding
      // paid 0.25 + 0.25 = 0.50 for the same 16 minutes.
      assert.equal(result.entryIds.length, 1);
      const rows = (await db.execute<{ hours: string; worked_on: string }>(sql`
        select hours::text as hours, worked_on::text as worked_on from time_entries
         where org_id = ${org.orgId} and employee_party_id = ${worker}`)).rows;
      assert.deepEqual(rows.map((r) => r.hours), ["0.2500"]);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an overnight shift deals its rounded total across both UTC days", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId, { unpaidBreakMinutes: 0 });
    const worker = randomUUID();
    const projectId = randomUUID();
    await seedWorker(org.orgId, org.subsidiaryId, worker, projectId);
    await withOrg(org.orgId, async () => {
      await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_in", occurredAt: "2026-09-14T22:00:00.000Z",
        source: "mobile", projectId, clientEventId: randomUUID(),
      });
      await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_out", occurredAt: "2026-09-15T02:00:00.000Z",
        source: "mobile", projectId, clientEventId: randomUUID(),
      });
      const rows = (await db.execute<{ hours: string; worked_on: string }>(sql`
        select hours::text as hours, worked_on::text as worked_on from time_entries
         where org_id = ${org.orgId} and employee_party_id = ${worker}
         order by worked_on`)).rows;
      // 4 paid hours, dealt 2.00 + 2.00 across the UTC midnight.
      assert.deepEqual(rows.map((r) => r.hours), ["2.0000", "2.0000"]);
      assert.deepEqual(rows.map((r) => r.worked_on), ["2026-09-14", "2026-09-15"]);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("concurrent replays of one offline id record once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const worker = randomUUID();
    const projectId = randomUUID();
    await seedWorker(org.orgId, org.subsidiaryId, worker, projectId);
    const key = randomUUID();
    const input = {
      orgId: org.orgId, actorUserId: null, employeePartyId: worker,
      kind: "clock_in" as const, occurredAt: "2026-09-14T11:00:00.000Z",
      source: "mobile" as const, projectId, clientEventId: key,
    };
    const [first, second] = await Promise.all([
      withOrg(org.orgId, () => recordClockEvent({ ...input })),
      withOrg(org.orgId, () => recordClockEvent({ ...input })),
    ]);
    // Exactly one writer and one replay — never a unique violation.
    assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
    assert.equal(first.eventId, second.eventId);
    await withOrg(org.orgId, async () => {
      const rows = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from time_clock_events
         where org_id = ${org.orgId} and client_event_id = ${key}`)).rows[0]?.n;
      assert.equal(rows, "1");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("concurrent distinct clock-ins serialize per employee", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const workers = Array.from({ length: 40 }, () => ({ worker: randomUUID(), projectId: randomUUID() }));
    for (const { worker, projectId } of workers) {
      await seedWorker(org.orgId, org.subsidiaryId, worker, projectId);
    }

    const attempts = workers.flatMap(({ worker, projectId }) => [0, 1].map((device) => ({
      orgId: org.orgId,
      actorUserId: null,
      employeePartyId: worker,
      kind: "clock_in" as const,
      occurredAt: "2026-09-14T11:00:00.000Z",
      source: "mobile" as const,
      projectId,
      deviceId: `device-${device}`,
      clientEventId: randomUUID(),
    })));
    const results = await Promise.all(attempts.map((input) =>
      recordClockEvent(input).then(
        () => ({ accepted: true }),
        (error) => {
          assert.ok(error instanceof FieldTimeError, `expected a named clock refusal, got ${String(error)}`);
          return { accepted: false };
        },
      ),
    ));
    assert.equal(results.filter((result) => result.accepted).length, workers.length,
      "only one of each employee's two distinct clock-ins may be accepted");
    await withOrg(org.orgId, async () => {
      const duplicates = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from (
          select employee_party_id from time_clock_events
           where org_id = ${org.orgId} and kind = 'clock_in' and status = 'recorded'
           group by employee_party_id having count(*) > 1
        ) duplicate_employees`)).rows[0]?.n;
      assert.equal(duplicates, "0", "no employee may have two open clock-ins");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a reused offline id with a different payload conflicts", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const worker = randomUUID();
    const projectId = randomUUID();
    await seedWorker(org.orgId, org.subsidiaryId, worker, projectId);
    const key = randomUUID();
    await withOrg(org.orgId, () => recordClockEvent({
      orgId: org.orgId, actorUserId: null, employeePartyId: worker,
      kind: "clock_in", occurredAt: "2026-09-14T11:00:00.000Z",
      source: "mobile", projectId, clientEventId: key,
    }));
    const code = await withOrg(org.orgId, () =>
      refusesCode(() => recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_in", occurredAt: "2026-09-14T12:00:00.000Z",
        source: "mobile", clientEventId: key,
      })));
    assert.equal(code, "client_event_conflict");
    await withOrg(org.orgId, async () => {
      const rows = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from time_clock_events
         where org_id = ${org.orgId} and client_event_id = ${key}`)).rows[0]?.n;
      assert.equal(rows, "1");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a UTC-5 evening shift posts on its one local date", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId, { unpaidBreakMinutes: 0 }, "America/Toronto");
    const worker = randomUUID();
    const projectId = randomUUID();
    await seedWorker(org.orgId, org.subsidiaryId, worker, projectId);
    await withOrg(org.orgId, async () => {
      // 20:00-24:00 Toronto time (01:00-05:00Z): a UTC split would date
      // the whole shift on Jan 15.
      await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_in", occurredAt: "2026-01-15T01:00:00.000Z",
        source: "mobile", projectId, clientEventId: randomUUID(),
      });
      const result = await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_out", occurredAt: "2026-01-15T05:00:00.000Z",
        source: "mobile", projectId, clientEventId: randomUUID(),
      });
      assert.equal(result.entryIds.length, 1);
      const rows = (await db.execute<{ hours: string; worked_on: string }>(sql`
        select hours::text as hours, worked_on::text as worked_on from time_entries
         where org_id = ${org.orgId} and employee_party_id = ${worker}`)).rows;
      assert.deepEqual(rows.map((r) => r.hours), ["4.0000"]);
      assert.deepEqual(rows.map((r) => r.worked_on), ["2026-01-14"]);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an overnight local shift splits at the business midnight", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId, { unpaidBreakMinutes: 0 }, "America/Toronto");
    const worker = randomUUID();
    const projectId = randomUUID();
    await seedWorker(org.orgId, org.subsidiaryId, worker, projectId);
    await withOrg(org.orgId, async () => {
      // 22:00-02:00 Toronto time (03:00-07:00Z): local midnight is 05:00Z.
      await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_in", occurredAt: "2026-01-15T03:00:00.000Z",
        source: "mobile", projectId, clientEventId: randomUUID(),
      });
      await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_out", occurredAt: "2026-01-15T07:00:00.000Z",
        source: "mobile", projectId, clientEventId: randomUUID(),
      });
      const rows = (await db.execute<{ hours: string; worked_on: string }>(sql`
        select hours::text as hours, worked_on::text as worked_on from time_entries
         where org_id = ${org.orgId} and employee_party_id = ${worker}
         order by worked_on`)).rows;
      assert.deepEqual(rows.map((r) => r.hours), ["2.0000", "2.0000"]);
      assert.deepEqual(rows.map((r) => r.worked_on), ["2026-01-14", "2026-01-15"]);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
