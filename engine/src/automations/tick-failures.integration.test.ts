import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { createAutomation } from "./services.ts";
import { runAutomationTick, MAX_AUTOMATION_EVENT_ATTEMPTS } from "./tick.ts";
import { stageAutomationEvent } from "./tick.ts";

/**
 * D4: failures propagate through the tick instead of counting as success.
 *
 * - schedule: a failed firing keeps its run row, does NOT advance
 *   last_run_at, and counts failed;
 * - date_relative: a failed subject is not counted fired;
 * - events: a failed firing parks the queue row pending with backoff
 *   (not done), an immediate re-tick does not reclaim it, and exhaustion
 *   parks it dead with the error kept — never silently consumed.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = { org: ScratchOrg; adminId: string };

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function setFeatures(orgId: string, features: Record<string, boolean>): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         coalesce(settings, '{}'::jsonb), '{features}',
         coalesce(settings -> 'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb
       )
     where id = ${orgId}
  `);
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  const adminId = await createScratchUser(org.orgId, "Tick Failure Admin", "tick_fail_admin");
  await grant(org.orgId, adminId, ["automations.read", "automations.manage", "automations.run"]);
  await setFeatures(org.orgId, { hrm: true, automations: true });
  return { org, adminId };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await withBypassContext(() => setupHarness());
  try {
    await fn(h);
  } finally {
    await withBypassContext(() => dropScratchOrg(h.org.orgId));
  }
}

async function seedEmployment(orgId: string, subsidiaryId: string, serviceStart: string): Promise<string> {
  const workerPartyId = randomUUID();
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${workerPartyId}, ${orgId}, 'person', 'Tick Worker', true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, service_start, service_start_provenance, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, ${serviceStart}::date, 'tick seed', 1)
  `);
  await db.transaction(async (tx) => {
    await tx.execute(sql`set constraints worker_employment_versions_change_tenant_fkey deferred`);
    const now = (await tx.execute<{ now: Date }>(sql`select now() as now`)).rows[0]!.now;
    const changeId = (await tx.execute<{ id: string }>(sql`
      insert into employment_changes
        (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
         recorded_source, recorded_source_ref, closed_versions)
      values (${orgId}, ${employmentId}, 1, 'status_changed',
              '{}'::jsonb, 'tick seed', 'system', 'tick-seed', '[]'::jsonb)
      returning id
    `)).rows[0]!.id;
    await tx.execute(sql`
      insert into worker_employment_versions
        (org_id, employment_id, version_no, status, effective_from, recorded_at)
      values (${orgId}, ${employmentId}, 1, 'active', ${serviceStart}::date, ${now})
    `);
    void changeId;
  });
  return employmentId;
}

/** An action that always fails at the write allowlist (employment versions change only via change requests). */
const FAILING_ACTION = { kind: "update_field", entity: "employment", field: "department_id", value: "x" };

/** An org whose OLDEST active user holds no automation permission at all. */
async function setupUnpermittedElderHarness(): Promise<Harness & { elderId: string }> {
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    const elderId = await createScratchUser(org.orgId, "Unpermitted Elder", "tick_elder");
    const adminId = await createScratchUser(org.orgId, "Tick Publisher", "tick_publisher");
    await grant(org.orgId, adminId, ["automations.read", "automations.manage", "automations.run"]);
    await setFeatures(org.orgId, { hrm: true, automations: true });
    return { org, adminId, elderId };
  });
}

test("the tick fires as the publisher when the oldest user holds no permission", { skip: !DB }, async () => {
  const h = await setupUnpermittedElderHarness();
  try {
    const today = new Date().toISOString().slice(0, 10);
    await seedEmployment(h.org.orgId, h.org.subsidiaryId, today);
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "publisher-attributed scan",
      trigger: { kind: "date_relative", entity: "employment", dateField: "service_start", offsetDays: 0, direction: "before", atTime: "09:00" },
      rules: {},
      conditions: {},
      actions: [{ kind: "send_notification", to: "initiator", body: "publisher fired" }],
    });
    await db.execute(sql`update automations set status = 'enabled' where id = ${recipe.id}`);
    const summary = await runAutomationTick(new Date());
    assert.equal(summary.dateRelativeFailed, 0);
    assert.equal(summary.dateRelativeFired, 1);
    const run = (await db.execute<{ status: string; createdBy: string | null }>(sql`
      select status, created_by as "createdBy" from automation_runs where automation_id = ${recipe.id} limit 1
    `)).rows[0]!;
    assert.equal(run.status, "succeeded");
    assert.equal(run.createdBy, h.adminId, "the run attributes to the publisher, not the oldest user");
  } finally {
    await withBypassContext(() => dropScratchOrg(h.org.orgId));
  }
});

test("a publisher who lost automations.run fails loudly with the remedy", { skip: !DB }, async () => {
  const h = await setupUnpermittedElderHarness();
  try {
    const today = new Date().toISOString().slice(0, 10);
    await seedEmployment(h.org.orgId, h.org.subsidiaryId, today);
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "revoked publisher scan",
      trigger: { kind: "date_relative", entity: "employment", dateField: "service_start", offsetDays: 0, direction: "before", atTime: "09:00" },
      rules: {},
      conditions: {},
      actions: [{ kind: "send_notification", to: "initiator", body: "must not fire" }],
    });
    await db.execute(sql`update automations set status = 'enabled' where id = ${recipe.id}`);
    await db.execute(sql`
      delete from user_permission_overrides where org_id = ${h.org.orgId} and user_id = ${h.adminId} and permission = 'automations.run'
    `);
    const summary = await runAutomationTick(new Date());
    assert.equal(summary.dateRelativeFired, 0);
    assert.equal(summary.dateRelativeFailed, 1);
    assert.ok(
      summary.errors.some((message) => /no longer holds the automations\.run permission/.test(message)),
      `expected a named permission refusal, got: ${JSON.stringify(summary.errors)}`,
    );
    const runs = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from automation_runs where automation_id = ${recipe.id}
    `)).rows[0]!.n;
    assert.equal(runs, 0, "nothing fires under another identity");
  } finally {
    await withBypassContext(() => dropScratchOrg(h.org.orgId));
  }
});

test("a failed schedule firing keeps its run, holds the cursor, and counts failed", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "failing schedule",
      trigger: { kind: "schedule", cron: "* * * * *", timezone: "UTC" },
      rules: {},
      conditions: {},
      actions: [FAILING_ACTION],
    });
    await db.execute(sql`update automations set status = 'enabled', created_at = now() - interval '5 minutes' where id = ${recipe.id}`);
    const summary = await runAutomationTick(new Date());
    assert.equal(summary.schedulesFired, 0);
    assert.equal(summary.schedulesFailed, 1);
    const row = (await db.execute<{ status: string; lastRunAt: string | null }>(sql`
      select (select status from automation_runs where automation_id = ${recipe.id} limit 1) as status,
             last_run_at as "lastRunAt" from automations where id = ${recipe.id}
    `)).rows[0]!;
    assert.equal(row.status, "failed", "the durable run row keeps the failure");
    assert.equal(row.lastRunAt, null, "the schedule cursor does not advance on failure");
  });
});

test("a failed date_relative subject is not counted fired", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const today = new Date().toISOString().slice(0, 10);
    await seedEmployment(h.org.orgId, h.org.subsidiaryId, today);
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "failing date scan",
      trigger: { kind: "date_relative", entity: "employment", dateField: "service_start", offsetDays: 0, direction: "before", atTime: "09:00" },
      rules: {},
      conditions: {},
      actions: [FAILING_ACTION],
    });
    await db.execute(sql`update automations set status = 'enabled' where id = ${recipe.id}`);
    const summary = await runAutomationTick(new Date());
    assert.equal(summary.dateRelativeFired, 0);
    assert.equal(summary.dateRelativeFailed, 1);
    const failed = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from automation_runs where automation_id = ${recipe.id} and status = 'failed'
    `)).rows[0]!.n;
    assert.equal(failed, 1, "the failed subject keeps its run row");
  });
});

test("a failed event backs off, is not reclaimed early, and parks dead at the ceiling", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const today = new Date().toISOString().slice(0, 10);
    const employmentId = await seedEmployment(h.org.orgId, h.org.subsidiaryId, today);
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "failing event",
      trigger: { kind: "field_change", entity: "employment", field: "status", to: "active" },
      rules: {},
      conditions: {},
      actions: [FAILING_ACTION],
    });
    await db.execute(sql`update automations set status = 'enabled' where id = ${recipe.id}`);
    await stageAutomationEvent({
      orgId: h.org.orgId,
      eventKind: "field_change",
      subjectKind: "employment",
      subjectId: employmentId,
      triggerFingerprint: "tick-probe-1",
      payload: { entity: "employment", field: "status", to: "active" },
    });
    const first = await runAutomationTick(new Date());
    assert.equal(first.eventsDrained, 0, "a failed event is not consumed");
    assert.equal(first.eventsFailed, 1);
    const parked = (await db.execute<{ status: string; attempts: number; dueAt: string | null; error: string | null }>(sql`
      select status, attempt_count as attempts, next_attempt_at as "dueAt", error
        from automation_event_queue where org_id = ${h.org.orgId} limit 1
    `)).rows[0]!;
    assert.equal(parked.status, "pending");
    assert.equal(parked.attempts, 1);
    assert.ok(parked.dueAt && new Date(parked.dueAt).getTime() > Date.now(), "the retry backs off into the future");
    assert.ok(parked.error, "the queue row keeps the failure evidence");
    // An immediate re-tick must not reclaim the backed-off row.
    const second = await runAutomationTick(new Date());
    assert.equal(second.eventsDrained, 0);
    assert.equal(second.eventsFailed, 0);
    const still = (await db.execute<{ attempts: number }>(sql`
      select attempt_count as attempts from automation_event_queue where org_id = ${h.org.orgId} limit 1
    `)).rows[0]!;
    assert.equal(still.attempts, 1, "backoff rows wait instead of hot-looping");
    // Exhaustion parks the row dead with the error kept.
    await db.execute(sql`
      update automation_event_queue
         set attempt_count = ${MAX_AUTOMATION_EVENT_ATTEMPTS - 1}, next_attempt_at = null, status = 'pending'
       where org_id = ${h.org.orgId}
    `);
    await db.execute(sql`update automations set status = 'enabled', error_message = null where id = ${recipe.id}`);
    const third = await runAutomationTick(new Date());
    assert.equal(third.eventsFailed, 1);
    const dead = (await db.execute<{ status: string; error: string | null }>(sql`
      select status, error from automation_event_queue where org_id = ${h.org.orgId} limit 1
    `)).rows[0]!;
    assert.equal(dead.status, "dead");
    assert.ok(dead.error, "the dead row names the failure for the operator");
    const failedRuns = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from automation_runs where automation_id = ${recipe.id} and status = 'failed'
    `)).rows[0]!.n;
    assert.ok(failedRuns >= 1, "every failed firing keeps its durable run row");
  });
});
