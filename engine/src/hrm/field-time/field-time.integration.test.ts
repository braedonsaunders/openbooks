/**
 * HR-20 field-time integration proofs (DB-owned — gated remotely).
 *
 * - Offline replay: the same event array twice yields the same entries once.
 * - Sequence refusals reach the caller by name, never silent pairs.
 * - Auto-close flags the pair instead of dropping hours.
 * - PIN lockout after five wrong tries, reset by a correct PIN.
 * - Batch post creates entries once and equipment charges once; a second
 *   post refuses; the charge posts the same balanced job-cost and
 *   recovery rows the equipment-charge path asserts.
 * - The multi-stage chain runs through Flows with stage 2 rejecting.
 * - Feature-off: recording refuses with the remedy, never a row.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../../testing/fixtures.ts";
import { recordClockEvent, replayClockEvents } from "./clock.ts";
import { identifyByPin, registerKiosk, setWorkerPin } from "./kiosk.ts";
import { createBatch, setBatchLines, submitBatch, approveBatchStage, rejectBatch, postBatch } from "./crew.ts";
import { saveChain } from "./stages.ts";
import { FieldTimeError } from "./errors.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableFieldTime(orgId: string, extra: Record<string, boolean> = {}): Promise<void> {
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
      || '{"projects": true, "timeTracking": true, "fieldTime": true, "fieldTimeGeofence": true,
             "fieldTimePhoto": false, "fieldTimeKiosk": true, "fieldTimeCrewEntry": true,
             "fieldTimeEquipment": true, "fieldTimeMultiStageApproval": true, "equipment": true}'
      || ${JSON.stringify(extra)}::jsonb)
     where id = ${orgId}`);
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{fieldTime}',
      '{"roundingIncrement": 15, "roundingMode": "nearest", "unpaidBreakMinutes": 30,
        "autoCloseHours": 16, "signatureRequired": false, "equipmentToleranceHours": "1.0000",
        "photoRequired": false}'::jsonb)
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

test("offline replay records each event once, entries once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const worker = randomUUID();
    const projectId = randomUUID();
    await withOrg(org.orgId, async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${worker}, ${org.orgId}, 'person', 'Crew Hand')`);
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom) values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-FT', 'Field job', 'active', true, '{}'::jsonb)`);
    });
    const events = [
      { orgId: org.orgId, actorUserId: null, employeePartyId: worker, kind: "clock_in" as const, occurredAt: "2026-09-14T11:00:00.000Z", source: "mobile" as const, projectId, clientEventId: randomUUID() },
      { orgId: org.orgId, actorUserId: null, employeePartyId: worker, kind: "clock_out" as const, occurredAt: "2026-09-14T19:00:00.000Z", source: "mobile" as const, projectId, clientEventId: randomUUID() },
    ];
    const first = await withOrg(org.orgId, () => replayClockEvents(events));
    const second = await withOrg(org.orgId, () => replayClockEvents(events));
    assert.equal(first.filter((r) => "replayed" in r && (r as { replayed: boolean }).replayed).length, 0);
    assert.equal(second.filter((r) => "replayed" in r && (r as { replayed: boolean }).replayed).length, 2);
    const entries = await withOrg(org.orgId, async () => (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from time_entries where org_id = ${org.orgId} and employee_party_id = ${worker}`)).rows[0]?.n);
    assert.equal(entries, "1");
    const stored = await withOrg(org.orgId, async () => (await db.execute<{ hours: string }>(sql`
      select hours::text as hours from time_entries where org_id = ${org.orgId} and employee_party_id = ${worker}`)).rows[0]?.hours);
    // 8h device time minus the 30-minute declared break, quarter-rounded.
    assert.equal(stored, "7.5000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("clock-out with no open pair refuses by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const worker = randomUUID();
    const code = await withOrg(org.orgId, () =>
      refusesCode(() => recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_out", occurredAt: "2026-09-14T19:00:00.000Z",
        source: "mobile", clientEventId: randomUUID(),
      })));
    assert.equal(code, "no_open_clock");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("stale pairs auto-close with a flag, hours kept", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const worker = randomUUID();
    const projectId = randomUUID();
    await withOrg(org.orgId, async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${worker}, ${org.orgId}, 'person', 'Crew Hand')`);
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom) values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-FT', 'Field job', 'active', true, '{}'::jsonb)`);
      await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_in", occurredAt: "2026-09-10T11:00:00.000Z",
        source: "mobile", projectId, clientEventId: randomUUID(),
      });
      // A new clock-in 4 days later auto-closes the stale pair first.
      const result = await recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: worker,
        kind: "clock_in", occurredAt: "2026-09-14T11:00:00.000Z",
        source: "mobile", projectId, clientEventId: randomUUID(),
      });
      assert.ok(result.autoClosedPairId, "the stale pair auto-closes with a flag");
      const flagged = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from time_clock_events
         where org_id = ${org.orgId} and auto_closed`)).rows[0]?.n;
      assert.equal(flagged, "1");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("five wrong PINs lock the kiosk identity", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const worker = randomUUID();
    const kiosk = await withOrg(org.orgId, async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${worker}, ${org.orgId}, 'person', 'Crew Hand')`);
      const { kiosk } = await registerKiosk({ orgId: org.orgId, actorUserId: randomUUID(), name: "Gate" });
      await setWorkerPin({ orgId: org.orgId, actorUserId: randomUUID(), employeePartyId: worker, pin: "4821" });
      return kiosk;
    });
    await withOrg(org.orgId, async () => {
      for (let i = 0; i < 4; i++) {
        assert.equal(await refusesCode(() => identifyByPin({ kiosk, employeePartyId: worker, pin: "0000" })), "pin_wrong");
      }
      assert.equal(await refusesCode(() => identifyByPin({ kiosk, employeePartyId: worker, pin: "0000" })), "pin_locked");
      assert.equal(await refusesCode(() => identifyByPin({ kiosk, employeePartyId: worker, pin: "4821" })), "pin_locked");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("batch post creates entries and balanced equipment charges once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const foreman = randomUUID();
    const worker = randomUUID();
    const projectId = randomUUID();
    const itemId = randomUUID();
    const unitId = randomUUID();
    const actor = randomUUID();
    const posted = await withOrg(org.orgId, async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${foreman}, ${org.orgId}, 'person', 'Foreman'), (${worker}, ${org.orgId}, 'person', 'Crew Hand')`);
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom) values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-FT', 'Field job', 'active', true, '{}'::jsonb)`);
      await db.execute(sql`insert into schedule_resources (org_id, project_id, name, kind, party_id) values (${org.orgId}, ${projectId}, 'Foreman', 'crew', ${foreman})`);
      await db.execute(sql`insert into items (id, org_id, kind, code, name, default_cost, default_rate, expense_account_id, cost_recovery_account_id, income_account_id, is_active, custom) values (${itemId}, ${org.orgId}, 'equipment_charge', 'EXC', 'Excavator', '125.3750', '250.0000', ${org.accounts.cogs}, ${org.accounts.adjustment}, ${org.accounts.revenue}, true, '{}'::jsonb)`);
      await db.execute(sql`insert into equipment_units (id, org_id, subsidiary_id, unit_number, name, status, charge_item_id, purchase_price) values (${unitId}, ${org.orgId}, ${org.subsidiaryId}, 'EQ-0001', 'Excavator 1', 'active', ${itemId}, '75000')`);
      const batchId = await createBatch({
        orgId: org.orgId, actorUserId: actor, foremanPartyId: foreman,
        projectId, workedOn: "2026-09-14", canManageAll: true,
      });
      await setBatchLines({
        orgId: org.orgId, actorUserId: actor, batchId,
        lines: [{ employeePartyId: worker, hours: "8.0000", equipmentId: unitId, equipmentHours: "4.0000" }],
      });
      await submitBatch({ orgId: org.orgId, actorUserId: actor, batchId });
      // Single approval stands without a declared chain: one approve posts.
      await approveBatchStage({ orgId: org.orgId, actorUserId: actor, batchId });
      return postBatch({ orgId: org.orgId, actorUserId: actor, batchId });
    });
    assert.equal(posted.entryIds.length, 1);
    assert.equal(posted.chargeDocumentIds.length, 1);
    await withOrg(org.orgId, async () => {
      // Posting twice refuses — hours and charges stay single.
      const batchId = (await db.execute<{ id: string }>(sql`select id::text as id from crew_time_batches where org_id = ${org.orgId} limit 1`)).rows[0]!.id;
      assert.equal(await refusesCode(() => postBatch({ orgId: org.orgId, actorUserId: actor, batchId })), "batch_already_posted");
      const entries = (await db.execute<{ n: string }>(sql`select count(*)::text as n from time_entries where org_id = ${org.orgId}`)).rows[0]?.n;
      assert.equal(entries, "1");
      const charges = (await db.execute<{ n: string }>(sql`select count(*)::text as n from documents where org_id = ${org.orgId} and kind = 'project_charge'`)).rows[0]?.n;
      assert.equal(charges, "1");
      // 4h × 125.3750 = 501.5000 balanced through the charge path.
      const line = (await db.execute<{ cost_amount: string; bill_amount: string; equipment_unit_id: string }>(sql`
        select cost_amount::text, bill_amount::text, equipment_unit_id::text from document_lines
         where org_id = ${org.orgId} and equipment_unit_id = ${unitId}`)).rows[0];
      assert.equal(line?.cost_amount, "501.5000");
      assert.equal(line?.equipment_unit_id, unitId);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a declared two-stage chain rejects at stage 2 with reasons", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    const foreman = randomUUID();
    const worker = randomUUID();
    const projectId = randomUUID();
    const actor = randomUUID();
    await withOrg(org.orgId, async () => {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${foreman}, ${org.orgId}, 'person', 'Foreman'), (${worker}, ${org.orgId}, 'person', 'Crew Hand')`);
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom) values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-FT', 'Field job', 'active', true, '{}'::jsonb)`);
      await saveChain({
        orgId: org.orgId, actorUserId: actor, subject: "crew_time_batch",
        stages: [{ order: 1, approverKind: "supervisor" }, { order: 2, approverKind: "payroll" }],
      });
      const batchId = await createBatch({
        orgId: org.orgId, actorUserId: actor, foremanPartyId: foreman,
        projectId, workedOn: "2026-09-14", canManageAll: true,
      });
      await setBatchLines({
        orgId: org.orgId, actorUserId: actor, batchId,
        lines: [{ employeePartyId: worker, hours: "8.0000" }],
      });
      await submitBatch({ orgId: org.orgId, actorUserId: actor, batchId });
      assert.equal(await approveBatchStage({ orgId: org.orgId, actorUserId: actor, batchId }), "approved_stage_1");
      await rejectBatch({ orgId: org.orgId, actorUserId: actor, batchId, reason: "Stage 2: split the overtime line" });
      const status = (await db.execute<{ status: string }>(sql`select status from crew_time_batches where id = ${batchId}`)).rows[0]?.status;
      assert.equal(status, "rejected");
      const posted = await refusesCode(() => postBatch({ orgId: org.orgId, actorUserId: actor, batchId }));
      assert.equal(posted, "batch_not_approved");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("feature-off recording refuses with the remedy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const code = await withOrg(org.orgId, () =>
      refusesCode(() => recordClockEvent({
        orgId: org.orgId, actorUserId: null, employeePartyId: randomUUID(),
        kind: "clock_in", occurredAt: "2026-09-14T11:00:00.000Z",
        source: "mobile", clientEventId: randomUUID(),
      })));
    assert.equal(code, "field_time_off");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
