import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { submitForApproval } from "../flows/submit.ts";
import { saveApprovalSettings } from "./services.ts";
import { withBypassContext } from "../platform/db.ts";
import {
  createAutomation,
  automationsFeatureOn,
} from "./services.ts";
import { executeAutomation, AutomationExecuteError } from "./execute.ts";
import { AutomationContractError } from "./triggers.ts";
import { simulateAutomation } from "./simulator.ts";
import { applyExceptionOnly, ApprovalPolicyError, scoreException } from "./approvals.ts";
import { upsertActionReason, validateSubmitActionReason, ActionReasonError } from "./action-reasons.ts";
import {
  correctEmploymentChange,
  rescindEmploymentChange,
  EventVerbError,
} from "./event-verbs.ts";
import { getEmploymentAsOf } from "../hrm/employment-read.ts";

/**
 * HR-16 DB coverage (integration partition): the automation run log and
 * its two fences (idempotency key, feature-off refusal), transaction
 * rollback on a failed step with the error surfaced as a run row,
 * simulator writes nothing, action/reason submit validation on and off,
 * rescind reversing versions exactly (as-of reads equal the pre-change
 * state) with dependent-change and reapproval-path proofs.
 *
 * Proofs are read back from storage, never from service returns alone:
 * run rows, notification counts, version rows, and event verbs.
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
  const adminId = await createScratchUser(org.orgId, "HRM Automation Admin", "hrm_auto_admin");
  await grant(org.orgId, adminId, [
    "automations.read",
    "automations.manage",
    "automations.run",
    "hrm.employment.read",
    "hrm.employment.manage",
    "hrm.employment.approve",
  ]);
  await setFeatures(org.orgId, { hrm: true, automations: true, hrmActionReasons: true, hrmEventVerbs: true });
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

async function seedReservedEmployment(orgId: string, subsidiaryId: string): Promise<string> {
  const workerPartyId = randomUUID();
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${workerPartyId}, ${orgId}, 'person', 'Automation Worker', true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  return employmentId;
}

/** Append one live status version with its evidence event (test canonical writer). */
async function addLiveVersion(
  orgId: string,
  employmentId: string,
  status: string,
  from: string,
): Promise<{ changeId: string; revision: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set constraints worker_employment_versions_change_tenant_fkey deferred`);
    const now = (await tx.execute<{ now: Date }>(sql`select now() as now`)).rows[0]!.now;
    const maxNo = (await tx.execute<{ n: number }>(sql`
      select coalesce(max(version_no), 0)::int as n from worker_employment_versions
       where org_id = ${orgId} and employment_id = ${employmentId}
    `)).rows[0]!.n;
    const prior = (await tx.execute<{ id: string; version_no: number; before: unknown }>(sql`
      select id, version_no, to_jsonb(worker_employment_versions) as before
        from worker_employment_versions
       where org_id = ${orgId} and employment_id = ${employmentId} and recorded_until is null
    `)).rows;
    const newRevision = (await tx.execute<{ revision: number }>(sql`
      select revision from worker_employments where org_id = ${orgId} and id = ${employmentId}
    `)).rows[0]!.revision + 1;
    const changeId = (await tx.execute<{ id: string }>(sql`
      insert into employment_changes
        (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
         recorded_source, recorded_source_ref, closed_versions)
      values (${orgId}, ${employmentId}, ${newRevision}, 'status_changed',
              '{}'::jsonb, 'automation seed', 'system', 'hr16-seed',
              ${JSON.stringify(prior.map((row) => ({
                table: "worker_employment_versions",
                identity: employmentId,
                version_no: row.version_no,
                row_id: row.id,
                before: row.before,
              })))}::jsonb)
      returning id
    `)).rows[0]!.id;
    for (const row of prior) {
      await tx.execute(sql`
        update worker_employment_versions
           set recorded_until = ${now}, superseded_by = ${maxNo + 1}, closed_by_change_id = ${changeId}
         where id = ${row.id}
      `);
    }
    await tx.execute(sql`
      insert into worker_employment_versions
        (org_id, employment_id, version_no, status, effective_from, recorded_at)
      values (${orgId}, ${employmentId}, ${maxNo + 1}, ${status}, ${from}::date, ${now})
    `);
    await tx.execute(sql`
      update worker_employments set revision = ${newRevision}, updated_at = now()
       where org_id = ${orgId} and id = ${employmentId}
    `);
    return { changeId, revision: newRevision };
  });
}

async function countRows(orgId: string): Promise<Record<string, number>> {
  const tables = ["automation_runs", "notifications", "scheduler_outbox", "employment_changes"];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const n = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from ${sql.identifier(table)} where org_id = ${orgId}
    `)).rows[0]!.n;
    out[table] = n;
  }
  return out;
}

test("idempotency: the same trigger twice collapses onto one run row", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "idempotency probe",
      trigger: { kind: "manual" },
      rules: {},
      conditions: {},
      actions: [{ kind: "send_notification", to: "initiator", body: "fired" }],
    });
    await db.execute(sql`update automations set status = 'enabled' where id = ${recipe.id}`);
    const first = await executeAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: recipe.id,
      triggerPayload: { kind: "manual", probe: "a" },
      fingerprint: "manual:probe-a",
    });
    assert.equal(first.status, "succeeded");
    const second = await executeAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: recipe.id,
      triggerPayload: { kind: "manual", probe: "a" },
      fingerprint: "manual:probe-a",
    });
    assert.equal(second.runId, first.runId, "a re-fired trigger returns the existing run, never a double-run");
    const runs = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from automation_runs where automation_id = ${recipe.id}
    `)).rows[0]!.n;
    assert.equal(runs, 1);
    const notes = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from notifications
       where org_id = ${h.org.orgId} and kind = 'automation' and user_id = ${h.adminId}
    `)).rows[0]!.n;
    assert.equal(notes, 1, "the notification fired exactly once");
  });
});

test("a failed step rolls the run's writes back and surfaces the error as a run row", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "rollback probe",
      trigger: { kind: "manual" },
      rules: {},
      conditions: {},
      actions: [
        { kind: "send_notification", to: "initiator", body: "rolled back" },
        // Employment versions change only through change requests: refused.
        { kind: "update_field", entity: "employment", field: "department_id", value: "x" },
      ],
    });
    await db.execute(sql`update automations set status = 'enabled' where id = ${recipe.id}`);
    const result = await executeAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: recipe.id,
      triggerPayload: { kind: "manual" },
    });
    assert.equal(result.status, "failed");
    assert.match(result.steps[result.steps.length - 1]!.error ?? "", /change request/);
    const rolledBack = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from notifications
       where org_id = ${h.org.orgId} and kind = 'automation' and body = 'rolled back'
    `)).rows[0]!.n;
    assert.equal(rolledBack, 0, "the run's notification rolled back with the failed step");
    const row = (await db.execute<{ status: string; error: unknown; steps: unknown }>(sql`
      select status, error, steps from automation_runs where id = ${result.runId}
    `)).rows[0]!;
    assert.equal(row.status, "failed");
    assert.ok(row.error, "the error is stored on the run row the inbox shows");
    const recipeRow = (await db.execute<{ status: string }>(sql`
      select status from automations where id = ${recipe.id}
    `)).rows[0]!;
    assert.equal(recipeRow.status, "error", "the recipe surfaces its breakage until fixed");
  });
});

test("simulate writes nothing: row counts identical before and after", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const employmentId = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "simulate probe",
      trigger: { kind: "manual" },
      rules: {},
      conditions: { root: { field: "status", op: "eq", value: "submitted" } },
      actions: [
        { kind: "send_notification", to: "initiator", body: "would send" },
        { kind: "send_email", templateKey: "probe", to: "initiator" },
      ],
    });
    const before = await countRows(h.org.orgId);
    const simulations = await simulateAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: recipe.id,
      subjectEntity: "employment",
      subjectId: employmentId,
    });
    assert.equal(simulations.length, 1);
    assert.equal(simulations[0]!.status, "simulated");
    assert.equal(simulations[0]!.steps.length, 2, "every action dry-runs");
    assert.ok(simulations[0]!.steps.every((s) => s.status === "simulated"));
    const after = await countRows(h.org.orgId);
    assert.deepEqual(after, before, "simulation performs zero writes");
  });
});

test("webhook actions refuse at publish with the missing transport named", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await assert.rejects(
      createAutomation({
        orgId: h.org.orgId,
        actorId: h.adminId,
        name: "webhook probe",
        trigger: { kind: "manual" },
        rules: {},
        conditions: {},
        actions: [{ kind: "webhook", endpointKey: "nope" }],
      }),
      (e: unknown) =>
        e instanceof AutomationContractError &&
        /no outbound webhook transport/.test((e as Error).message) &&
        /send_notification/.test((e as Error).message),
    );
    const rows = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from automations where org_id = ${h.org.orgId} and name = 'webhook probe'
    `)).rows[0]!.n;
    assert.equal(rows, 0, "the refused publish stores nothing");
  });
});

test("a legacy stored webhook action fails the run by name and sends nothing", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    // Rows predating the publish refusal bypass the service: insert
    // directly so execution of a legacy row is what is under test.
    const legacyId = (await db.execute<{ id: string }>(sql`
      insert into automations (org_id, name, status, trigger, rules, conditions, actions, created_by, updated_by)
      values (${h.org.orgId}, 'legacy webhook', 'enabled',
              '{"kind":"manual"}'::jsonb, '{}'::jsonb, '{}'::jsonb,
              '[{"kind":"webhook","endpointKey":"legacy"}]'::jsonb, ${h.adminId}, ${h.adminId})
      returning id
    `)).rows[0]!.id;
    const result = await executeAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: legacyId,
      triggerPayload: { kind: "manual" },
    });
    assert.equal(result.status, "failed");
    assert.match(result.steps[result.steps.length - 1]!.error ?? "", /no outbound webhook transport/);
    assert.match(result.steps[result.steps.length - 1]!.error ?? "", /send_notification/);
    const queued = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from scheduler_outbox
       where org_id = ${h.org.orgId} and subject_id = ${result.runId}
    `)).rows[0]!.n;
    assert.equal(queued, 0, "a refused webhook enqueues no outbox job");
  });
});

test("feature-off: triggers must not fire", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "dark probe",
      trigger: { kind: "manual" },
      rules: {},
      conditions: {},
      actions: [{ kind: "send_notification", to: "initiator", body: "must not fire" }],
    });
    await db.execute(sql`update automations set status = 'enabled' where id = ${recipe.id}`);
    await setFeatures(h.org.orgId, { automations: false });
    assert.equal(await automationsFeatureOn(h.org.orgId), false);
    await assert.rejects(
      executeAutomation({ orgId: h.org.orgId, actorId: h.adminId, automationId: recipe.id, triggerPayload: {} }),
      (e: unknown) => e instanceof AutomationExecuteError && /switched off/.test((e as Error).message),
    );
    const runs = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from automation_runs where automation_id = ${recipe.id}
    `)).rows[0]!.n;
    assert.equal(runs, 0, "no run row exists for a refused firing");
  });
});

test("action reasons: required when on, ignored when off, comment enforced", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await upsertActionReason({
      orgId: h.org.orgId,
      actorId: h.adminId,
      action: "transfer",
      reasonCode: "VOL-DEPT",
      label: "Voluntary department move",
      requiresComment: true,
    });
    // Missing both while on: refusal naming the remedy.
    await assert.rejects(
      validateSubmitActionReason({ orgId: h.org.orgId, featureOn: true }),
      (e: unknown) => e instanceof ActionReasonError && /requires an action/.test((e as Error).message),
    );
    // Unknown code: refusal.
    await assert.rejects(
      validateSubmitActionReason({ orgId: h.org.orgId, featureOn: true, action: "transfer", reasonCode: "NOPE", reason: "x" }),
      (e: unknown) => e instanceof ActionReasonError && /not active/.test((e as Error).message),
    );
    // Requires-comment code without a reason: refusal.
    await assert.rejects(
      validateSubmitActionReason({ orgId: h.org.orgId, featureOn: true, action: "transfer", reasonCode: "VOL-DEPT", reason: "  " }),
      (e: unknown) => e instanceof ActionReasonError && /requires a written explanation/.test((e as Error).message),
    );
    // Valid: passes.
    await validateSubmitActionReason({ orgId: h.org.orgId, featureOn: true, action: "transfer", reasonCode: "VOL-DEPT", reason: "team move" });
    // Feature off: everything ignored, never a refusal.
    await validateSubmitActionReason({ orgId: h.org.orgId, featureOn: false });
  });
});

test("rescind reverses versions exactly: as-of reads equal the pre-change state", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const employmentId = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    await addLiveVersion(h.org.orgId, employmentId, "active", "2026-01-01");
    const target = await addLiveVersion(h.org.orgId, employmentId, "on_leave", "2026-02-01");
    const asOfStatus = async () =>
      (
        await getEmploymentAsOf({
          orgId: h.org.orgId,
          actorId: h.adminId,
          employmentId,
          effectiveDate: "2026-06-01",
          knownAt: new Date().toISOString(),
        })
      ).version.status;
    assert.equal(await asOfStatus(), "on_leave");
    const { changeId } = await rescindEmploymentChange({
      orgId: h.org.orgId,
      actorId: h.adminId,
      changeId: target.changeId,
      reason: "leave entry was a duplicate",
    });
    assert.equal(await asOfStatus(), "active", "as-of after rescind equals the pre-change state");
    const verb = (await db.execute<{ verb: string; reverses: string | null }>(sql`
      select verb, reverses_change_id as reverses from employment_changes where id = ${changeId}
    `)).rows[0]!;
    assert.equal(verb.verb, "rescind");
    assert.equal(verb.reverses, target.changeId);
  });
});

test("rescind refuses when a later change depends on the target, naming it", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const employmentId = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    await addLiveVersion(h.org.orgId, employmentId, "active", "2026-01-01");
    const target = await addLiveVersion(h.org.orgId, employmentId, "on_leave", "2026-02-01");
    const later = await addLiveVersion(h.org.orgId, employmentId, "suspended", "2026-03-01");
    await assert.rejects(
      rescindEmploymentChange({ orgId: h.org.orgId, actorId: h.adminId, changeId: target.changeId, reason: "too late" }),
      (e: unknown) =>
        e instanceof EventVerbError &&
        new RegExp(`revision ${later.revision}`).test((e as Error).message),
    );
  });
});

test("correct defaults to a pre-filled reapproval request; direct when allowed", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const employmentId = await seedReservedEmployment(h.org.orgId, h.org.subsidiaryId);
    await addLiveVersion(h.org.orgId, employmentId, "active", "2026-01-01");
    const target = await addLiveVersion(h.org.orgId, employmentId, "on_leave", "2026-02-01");
    // Default (correct_requires_reapproval true): opens a new request.
    const via = await correctEmploymentChange({
      orgId: h.org.orgId,
      actorId: h.adminId,
      changeId: target.changeId,
      reason: "wrong start month",
      prefillPayload: { kind: "status_change", status: "active", effectiveFrom: "2026-02-01", effectiveTo: null },
    });
    assert.equal(via.mode, "reapproval");
    assert.ok(via.requestId, "the correction travels as a new pre-filled request");
    // Opt-out: direct version superseding at the same effective date.
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{hrmCorrectRequiresReapproval}', 'false')
       where id = ${h.org.orgId}
    `);
    const direct = await correctEmploymentChange({
      orgId: h.org.orgId,
      actorId: h.adminId,
      changeId: target.changeId,
      reason: "status typo",
      correctedFields: { status: "active" },
    });
    assert.equal(direct.mode, "direct");
    const verb = (await db.execute<{ verb: string; corrected: string | null }>(sql`
      select verb, corrected_change_id as corrected from employment_changes where id = ${direct.changeId}
    `)).rows[0]!;
    assert.equal(verb.verb, "correct");
    assert.equal(verb.corrected, target.changeId);
  });
});

test("exclude-initiator: a gate assigned to the initiator refuses instead of auto-deciding", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedApprovalFlow(h.org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: h.adminId }],
      mode: "any",
    });
    const docId = await seedDraftDocument(h.org.orgId, { kind: "vendor_bill", createdBy: h.adminId });
    const res = await submitForApproval("vendor_bill", docId);
    assert.equal(res.gated, true);
    const gateId = (await db.execute<{ id: string }>(sql`
      select id from flow_gates where subject_id = ${docId} order by created_at limit 1
    `)).rows[0]!.id;
    await saveApprovalSettings({
      orgId: h.org.orgId,
      actorId: h.adminId,
      subjectKind: "timesheet_week",
      exceptionOnly: true,
      thresholds: { max_hours_per_day: 10, max_week_hours: 40 },
      excludeInitiator: true,
    });
    await assert.rejects(
      applyExceptionOnly({
        orgId: h.org.orgId,
        actorId: h.adminId,
        subjectKind: "timesheet_week",
        subjectId: randomUUID(),
        gateId,
        initiatorUserId: h.adminId,
      }),
      (e: unknown) => e instanceof ApprovalPolicyError && /exclude_initiator is on/.test((e as Error).message),
    );
    const status = (await db.execute<{ status: string }>(sql`
      select status from flow_gates where id = ${gateId}
    `)).rows[0]!.status;
    assert.equal(status, "pending", "the refused gate stays pending for a human");
  });
});

test("exception scoring refusal and naming live beside the pure matrix", { skip: !DB }, async () => {
  await withHarness(async () => {
    // Unknown thresholds refuse instead of passing, over a real org row set.
    assert.throws(
      () =>
        scoreException(
          "timesheet_week",
          { entity: "timesheet_week", fields: { total_hours: 5 }, scope: {} },
          {},
        ),
      /needs max_hours_per_day/,
    );
  });
});
