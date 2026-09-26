import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import {
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  setupHarness,
  withHarness,
} from "../testing/hrm-harness.ts";
import { createAutomation, setAutomationStatus, updateAutomation } from "./services.ts";
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

const TICK_SPEC = {
  features: ["hrm", "automations"],
  users: [
    {
      key: "adminId",
      name: "Tick Failure Admin",
      handle: "tick_fail_admin",
      permissions: ["automations.read", "automations.manage", "automations.run"],
    },
  ],
} as const;

async function setupTickHarness(): Promise<Harness> {
  return setupHarness(TICK_SPEC);
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
  return withBypassContext(() =>
    setupHarness({
      features: ["hrm", "automations"],
      users: [
        // Creation order matters: the elder is the oldest user in the org.
        { key: "elderId", name: "Unpermitted Elder", handle: "tick_elder" },
        {
          key: "adminId",
          name: "Tick Publisher",
          handle: "tick_publisher",
          permissions: ["automations.read", "automations.manage", "automations.run"],
        },
      ],
    } as const),
  );
}

test("a date_relative scan visits every match past row 200", { skip: !DB }, async () => {
  await withHarness(setupTickHarness, async (h) => {
    const today = new Date().toISOString().slice(0, 10);
    const COUNT = 210;
    // One statement seeds the whole population: parties, employments,
    // changes, and live versions, so the test proves the scan rather
    // than the seed loop.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set constraints worker_employment_versions_change_tenant_fkey deferred`);
      await tx.execute(sql`
        with seeded_parties as (
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          select uuid_generate_v7(), ${h.org.orgId}, 'person',
                 'Bulk Worker ' || g, true, '{}'::jsonb
            from generate_series(1, ${COUNT}) g
          returning id
        ),
        seeded_employments as (
          insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, service_start, service_start_provenance, revision)
          select uuid_generate_v7(), ${h.org.orgId}, id, ${h.org.subsidiaryId}, ${today}::date, 'bulk seed', 1
            from seeded_parties
          returning id
        ),
        seeded_changes as (
          insert into employment_changes
            (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
             recorded_source, recorded_source_ref, closed_versions)
          select ${h.org.orgId}, id, 1, 'status_changed',
                 '{}'::jsonb, 'bulk seed', 'system', 'bulk-seed', '[]'::jsonb
            from seeded_employments
          returning employment_id
        )
        insert into worker_employment_versions
          (org_id, employment_id, version_no, status, effective_from, recorded_at)
        select ${h.org.orgId}, employment_id, 1, 'active', ${today}::date, now()
          from seeded_changes
      `);
    });
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "bulk date scan",
      trigger: { kind: "date_relative", entity: "employment", dateField: "service_start", offsetDays: 0, direction: "before", atTime: "09:00" },
      rules: {},
      conditions: {},
      actions: [{ kind: "send_notification", to: "initiator", body: "bulk fired" }],
    });
    await db.execute(sql`update automations set status = 'enabled' where id = ${recipe.id}`);
    const summary = await runAutomationTick(new Date());
    assert.equal(summary.dateRelativeFailed, 0);
    assert.equal(summary.dateRelativeFired, COUNT);
    const runs = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from automation_runs where automation_id = ${recipe.id}
    `)).rows[0]!.n;
    assert.equal(runs, COUNT, "every match past row 200 fires exactly once");
  }, { bypass: true });
});

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
  await withHarness(setupTickHarness, async (h) => {
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
  }, { bypass: true });
});

test("an invalid schedule cron refuses at create, update, and enable", { skip: !DB }, async () => {
  await withHarness(setupTickHarness, async (h) => {
    const action = { kind: "send_notification", to: "manager", body: "hi" };
    await assert.rejects(
      createAutomation({
        orgId: h.org.orgId,
        actorId: h.adminId,
        name: "bad cron",
        trigger: { kind: "schedule", cron: "not-a-cron", timezone: "UTC" },
        rules: {},
        conditions: {},
        actions: [action],
      }),
      /cron 'not-a-cron' is not a valid cron expression/,
    );
    const ok = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "good cron",
      trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      rules: {},
      conditions: {},
      actions: [action],
    });
    await assert.rejects(
      updateAutomation({
        orgId: h.org.orgId,
        actorId: h.adminId,
        automationId: ok.id,
        trigger: { kind: "schedule", cron: "also-bad", timezone: "UTC" },
      }),
      /cron 'also-bad' is not a valid cron expression/,
    );
    // A row stored before save-time validation refuses at enable.
    const legacyId = randomUUID();
    await db.execute(sql`
      insert into automations (id, org_id, name, status, trigger, rules, conditions, actions, priority, created_by, updated_by)
      values (${legacyId}, ${h.org.orgId}, 'legacy bad cron', 'draft',
              ${JSON.stringify({ kind: "schedule", cron: "never-fires", timezone: "UTC" })}::jsonb,
              '{}'::jsonb, '{}'::jsonb, ${JSON.stringify([action])}::jsonb,
              100, ${h.adminId}, ${h.adminId})
    `);
    await assert.rejects(
      setAutomationStatus({ orgId: h.org.orgId, actorId: h.adminId, automationId: legacyId, status: "enabled" }),
      /cron 'never-fires' is not a valid cron expression/,
    );
  }, { bypass: true });
});

test("a stored invalid schedule cron records a failed run and parks the recipe", { skip: !DB }, async () => {
  await withHarness(setupTickHarness, async (h) => {
    const legacyId = randomUUID();
    await db.execute(sql`
      insert into automations (id, org_id, name, status, trigger, rules, conditions, actions, priority, created_by, updated_by, created_at)
      values (${legacyId}, ${h.org.orgId}, 'legacy bad cron', 'enabled',
              ${JSON.stringify({ kind: "schedule", cron: "not-a-cron", timezone: "UTC" })}::jsonb,
              '{}'::jsonb, '{}'::jsonb,
              ${JSON.stringify([{ kind: "send_notification", to: "manager", body: "hi" }])}::jsonb,
              100, ${h.adminId}, ${h.adminId}, now() - interval '5 minutes')
    `);
    const summary = await runAutomationTick(new Date());
    assert.equal(summary.schedulesFired, 0);
    assert.equal(summary.schedulesFailed, 1);
    // A failed run row carries the named refusal — never silence.
    const run = (await db.execute<{ status: string; error: { message: string } | null }>(sql`
      select status, error from automation_runs where automation_id = ${legacyId}
    `)).rows[0];
    assert.equal(run?.status, "failed");
    assert.match(run?.error?.message ?? "", /cron 'not-a-cron' is not a valid cron expression/);
    // The recipe parks in error with the cursor held, and the publisher is notified.
    const recipe = (await db.execute<{ status: string; errorMessage: string | null; lastRunAt: string | null }>(sql`
      select status, error_message as "errorMessage", last_run_at as "lastRunAt" from automations where id = ${legacyId}
    `)).rows[0]!;
    assert.equal(recipe.status, "error");
    assert.match(recipe.errorMessage ?? "", /not-a-cron/);
    assert.equal(recipe.lastRunAt, null);
    const notes = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from notifications
       where org_id = ${h.org.orgId} and user_id = ${h.adminId} and kind = 'automation_error'
    `)).rows[0]!.n;
    assert.equal(notes, 1);
    // A second tick records nothing more: the error status parks the recipe.
    const again = await runAutomationTick(new Date());
    assert.equal(again.schedulesFailed, 0);
    const runs = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from automation_runs where automation_id = ${legacyId}
    `)).rows[0]!.n;
    assert.equal(runs, 1);
  }, { bypass: true });
});

test("event-sourced recipes refuse enabling by name; firable recipes still enable", { skip: !DB }, async () => {
  await withHarness(setupTickHarness, async (h) => {
    const action = { kind: "send_notification", to: "manager", body: "hi" };
    // Drafts save fine — the refusal arms only at enable time.
    const draft = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "watched field",
      trigger: { kind: "field_change", entity: "employment", field: "status", to: "active" },
      rules: {},
      conditions: {},
      actions: [action],
    });
    await assert.rejects(
      setAutomationStatus({ orgId: h.org.orgId, actorId: h.adminId, automationId: draft.id, status: "enabled" }),
      /trigger kind 'field_change' is not available yet/,
    );
    // A schedule recipe still enables through the same path.
    const sched = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "morning",
      trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      rules: {},
      conditions: {},
      actions: [action],
    });
    const enabled = await setAutomationStatus({ orgId: h.org.orgId, actorId: h.adminId, automationId: sched.id, status: "enabled" });
    assert.equal(enabled.status, "enabled");
    // Swapping an enabled recipe onto an event trigger refuses too.
    await assert.rejects(
      updateAutomation({
        orgId: h.org.orgId,
        actorId: h.adminId,
        automationId: sched.id,
        trigger: { kind: "event", subjectKind: "hrm_employment_change_request", eventKind: "approved" },
      }),
      /trigger kind 'event' is not available yet/,
    );
  }, { bypass: true });
});

test("a failed date_relative subject is not counted fired", { skip: !DB }, async () => {
  await withHarness(setupTickHarness, async (h) => {
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
  }, { bypass: true });
});

test("a failed event backs off, is not reclaimed early, and parks dead at the ceiling", { skip: !DB }, async () => {
  await withHarness(setupTickHarness, async (h) => {
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
  }, { bypass: true });
});
