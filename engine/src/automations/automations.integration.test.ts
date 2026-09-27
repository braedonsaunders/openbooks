import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchUser,
  seedApprovalFlow,
  seedDraftDocument,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  addLiveVersion,
  grant,
  seedEmployment,
  setFeatures,
  setupHarness,
  withHarness,
} from "../testing/hrm-harness.ts";
import { submitForApproval } from "../flows/submit.ts";
import { saveApprovalSettings } from "./services.ts";
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

const AUTOMATIONS_SPEC = {
  features: ["hrm", "automations"],
  users: [
    {
      key: "adminId",
      name: "HRM Automation Admin",
      handle: "hrm_auto_admin",
      permissions: [
        "automations.read",
        "automations.manage",
        "automations.run",
        "hrm.employment.read",
        "hrm.employment.manage",
        "hrm.employment.approve",
      ],
    },
  ],
} as const;

async function setupAutomationsHarness(): Promise<Harness> {
  return setupHarness(AUTOMATIONS_SPEC);
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
  await withHarness(setupAutomationsHarness, async (h) => {
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
      allowedSubsidiaryIds: null,
      triggerPayload: { kind: "manual", probe: "a" },
      fingerprint: "manual:probe-a",
    });
    assert.equal(first.status, "succeeded");
    const second = await executeAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: recipe.id,
      allowedSubsidiaryIds: null,
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
  }, { bypass: true });
});

test("a failed step rolls the run's writes back and surfaces the error as a run row", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
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
      allowedSubsidiaryIds: null,
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
  }, { bypass: true });
});

test("simulate writes nothing: row counts identical before and after", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Automation Worker", withVersion: false });
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "simulate probe",
      trigger: { kind: "manual" },
      rules: {},
      conditions: { root: { field: "status", op: "eq", value: "submitted" } },
      actions: [
        { kind: "send_notification", to: "initiator", body: "would send" },
        { kind: "send_email", templateKey: "automation_notice", to: "initiator" },
      ],
    });
    const before = await countRows(h.org.orgId);
    const simulations = await simulateAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: recipe.id,
      allowedSubsidiaryIds: null,
      subjectEntity: "employment",
      subjectId: employmentId,
    });
    assert.equal(simulations.length, 1);
    assert.equal(simulations[0]!.status, "simulated");
    assert.equal(simulations[0]!.steps.length, 2, "every action dry-runs");
    assert.ok(simulations[0]!.steps.every((s) => s.status === "simulated"));
    const after = await countRows(h.org.orgId);
    assert.deepEqual(after, before, "simulation performs zero writes");
  }, { bypass: true });
});

test("webhook actions refuse at publish with the missing transport named", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
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
  }, { bypass: true });
});

test("a legacy stored webhook action fails the run by name and sends nothing", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
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
      allowedSubsidiaryIds: null,
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
  }, { bypass: true });
});

test("deferred actions refuse at publish; a legacy delay fails the run and runs nothing after it", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
    const refused: { actions: unknown; pattern: RegExp }[] = [
      { actions: [{ kind: "delay", days: 2 }], pattern: /no resumable continuation/ },
      { actions: [{ kind: "approve_step" }], pattern: /cannot mint approval gates/ },
      { actions: [{ kind: "start_flow", subject: "onboarding" }], pattern: /no named dispatch/ },
    ];
    for (const { actions, pattern } of refused) {
      await assert.rejects(
        createAutomation({
          orgId: h.org.orgId,
          actorId: h.adminId,
          name: "deferred probe",
          trigger: { kind: "manual" },
          rules: {},
          conditions: {},
          actions,
        }),
        (e: unknown) => e instanceof AutomationContractError && pattern.test((e as Error).message),
      );
    }
    // A row predating the refusal: the delay is followed by a
    // notification, proving the delay neither pauses nor passes.
    const legacyId = (await db.execute<{ id: string }>(sql`
      insert into automations (org_id, name, status, trigger, rules, conditions, actions, created_by, updated_by)
      values (${h.org.orgId}, 'legacy delay', 'enabled',
              '{"kind":"manual"}'::jsonb, '{}'::jsonb, '{}'::jsonb,
              '[{"kind":"delay","days":2},{"kind":"send_notification","to":"initiator","body":"after delay"}]'::jsonb,
              ${h.adminId}, ${h.adminId})
      returning id
    `)).rows[0]!.id;
    const result = await executeAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: legacyId,
      allowedSubsidiaryIds: null,
      triggerPayload: { kind: "manual" },
    });
    assert.equal(result.status, "failed");
    assert.match(result.steps[result.steps.length - 1]!.error ?? "", /no resumable continuation/);
    const afterDelay = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from notifications
       where org_id = ${h.org.orgId} and kind = 'automation' and body = 'after delay'
    `)).rows[0]!.n;
    assert.equal(afterDelay, 0, "the action after a refused delay never runs");
    const simulations = await simulateAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: legacyId,
      allowedSubsidiaryIds: null,
    });
    assert.equal(simulations[0]!.steps[0]!.status, "failed");
    assert.match(simulations[0]!.steps[0]!.error ?? "", /no resumable continuation/);
  }, { bypass: true });
});

test("send_email renders the registered template into the outbox payload", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
    const recipe = await createAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      name: "Rendered mail probe",
      trigger: { kind: "manual" },
      rules: {},
      conditions: {},
      actions: [{ kind: "send_email", templateKey: "automation_notice", to: "initiator" }],
    });
    await db.execute(sql`update automations set status = 'enabled' where id = ${recipe.id}`);
    const result = await executeAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: recipe.id,
      allowedSubsidiaryIds: null,
      triggerPayload: { kind: "manual" },
    });
    assert.equal(result.status, "succeeded");
    const row = (await db.execute<{ payload: Record<string, unknown> }>(sql`
      select payload from scheduler_outbox
       where org_id = ${h.org.orgId} and kind = 'flow_email' and subject_id = ${result.runId}
       limit 1
    `)).rows[0];
    assert.ok(row, "the rendered email is deferred through the outbox");
    const payload = row.payload as { to: string[]; subject: string; html: string; text: string; meta: { category: string } };
    assert.equal(payload.to.length, 1);
    assert.match(payload.subject, /Rendered mail probe/);
    assert.match(payload.text, /Rendered mail probe/);
    assert.match(payload.html, /Rendered mail probe/);
    assert.equal(payload.meta.category, "automation");
    assert.doesNotMatch(payload.text, /Template .* for automation run/);
  }, { bypass: true });
});

test("send_email with an unknown template refuses at publish and in legacy runs", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
    await assert.rejects(
      createAutomation({
        orgId: h.org.orgId,
        actorId: h.adminId,
        name: "bad template probe",
        trigger: { kind: "manual" },
        rules: {},
        conditions: {},
        actions: [{ kind: "send_email", templateKey: "nope", to: "initiator" }],
      }),
      (e: unknown) =>
        e instanceof AutomationContractError &&
        /unknown email template 'nope'/.test((e as Error).message) &&
        /automation_notice/.test((e as Error).message),
    );
    const legacyId = (await db.execute<{ id: string }>(sql`
      insert into automations (org_id, name, status, trigger, rules, conditions, actions, created_by, updated_by)
      values (${h.org.orgId}, 'legacy bad template', 'enabled',
              '{"kind":"manual"}'::jsonb, '{}'::jsonb, '{}'::jsonb,
              '[{"kind":"send_email","templateKey":"nope","to":"initiator"}]'::jsonb,
              ${h.adminId}, ${h.adminId})
      returning id
    `)).rows[0]!.id;
    const result = await executeAutomation({
      orgId: h.org.orgId,
      actorId: h.adminId,
      automationId: legacyId,
      allowedSubsidiaryIds: null,
      triggerPayload: { kind: "manual" },
    });
    assert.equal(result.status, "failed");
    assert.match(result.steps[result.steps.length - 1]!.error ?? "", /unknown email template 'nope'/);
  }, { bypass: true });
});

test("feature-off: triggers must not fire", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
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
      executeAutomation({ orgId: h.org.orgId, actorId: h.adminId, automationId: recipe.id, triggerPayload: {}, allowedSubsidiaryIds: null }),
      (e: unknown) => e instanceof AutomationExecuteError && /switched off/.test((e as Error).message),
    );
    const runs = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from automation_runs where automation_id = ${recipe.id}
    `)).rows[0]!.n;
    assert.equal(runs, 0, "no run row exists for a refused firing");
  }, { bypass: true });
});

test("action reasons: required once an active code is declared, comment enforced", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
    // No code declared: classification is optional, never a refusal.
    await validateSubmitActionReason({ orgId: h.org.orgId });
    const code = {
      orgId: h.org.orgId,
      actorId: h.adminId,
      action: "transfer",
      reasonCode: "VOL-DEPT",
      label: "Voluntary department move",
      requiresComment: true,
    };
    await upsertActionReason(code);
    // Missing both once a code is active: refusal naming the remedy.
    await assert.rejects(
      validateSubmitActionReason({ orgId: h.org.orgId }),
      (e: unknown) => e instanceof ActionReasonError && /requires an action/.test((e as Error).message),
    );
    // Unknown code: refusal.
    await assert.rejects(
      validateSubmitActionReason({ orgId: h.org.orgId, action: "transfer", reasonCode: "NOPE", reason: "x" }),
      (e: unknown) => e instanceof ActionReasonError && /not active/.test((e as Error).message),
    );
    // Requires-comment code without a reason: refusal.
    await assert.rejects(
      validateSubmitActionReason({ orgId: h.org.orgId, action: "transfer", reasonCode: "VOL-DEPT", reason: "  " }),
      (e: unknown) => e instanceof ActionReasonError && /requires a written explanation/.test((e as Error).message),
    );
    // Valid: passes.
    await validateSubmitActionReason({ orgId: h.org.orgId, action: "transfer", reasonCode: "VOL-DEPT", reason: "team move" });
    // The only code deactivated: optional again.
    await upsertActionReason({ ...code, isActive: false });
    await validateSubmitActionReason({ orgId: h.org.orgId });
  }, { bypass: true });
});

test("rescind reverses versions exactly: as-of reads equal the pre-change state", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Automation Worker", withVersion: false });
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-01-01", changeKind: "status_changed", reason: "automation seed", sourceRef: "hr16-seed" });
    const target = await addLiveVersion(h.org.orgId, employmentId, { status: "on_leave", from: "2026-02-01", changeKind: "status_changed", reason: "automation seed", sourceRef: "hr16-seed" });
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
  }, { bypass: true });
});

test("rescind refuses when a later change depends on the target, naming it", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Automation Worker", withVersion: false });
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-01-01", changeKind: "status_changed", reason: "automation seed", sourceRef: "hr16-seed" });
    const target = await addLiveVersion(h.org.orgId, employmentId, { status: "on_leave", from: "2026-02-01", changeKind: "status_changed", reason: "automation seed", sourceRef: "hr16-seed" });
    const later = await addLiveVersion(h.org.orgId, employmentId, { status: "suspended", from: "2026-03-01", changeKind: "status_changed", reason: "automation seed", sourceRef: "hr16-seed" });
    await assert.rejects(
      rescindEmploymentChange({ orgId: h.org.orgId, actorId: h.adminId, changeId: target.changeId, reason: "too late" }),
      (e: unknown) =>
        e instanceof EventVerbError &&
        new RegExp(`revision ${later.revision}`).test((e as Error).message),
    );
  }, { bypass: true });
});

test("a rescind refuses instead of filing null evidence when the pre-rescind snapshot cannot be read", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Automation Worker", withVersion: false });
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-01-01", changeKind: "status_changed", reason: "automation seed", sourceRef: "hr16-seed" });
    const target = await addLiveVersion(h.org.orgId, employmentId, { status: "on_leave", from: "2026-02-01", changeKind: "status_changed", reason: "automation seed", sourceRef: "hr16-seed" });
    // Revoking the actor's employment-read grant makes the pre-rescind
    // snapshot read throw inside the rescind (the approve grant and the
    // verb gate stay on, so the rescind proceeds to the read). The rescind
    // must refuse naming the missing evidence, never file the event with
    // a null prior state.
    await db.execute(sql`
      delete from user_permission_overrides
       where org_id = ${h.org.orgId} and user_id = ${h.adminId}
         and permission = 'hrm.employment.read'
    `);
    await assert.rejects(
      rescindEmploymentChange({ orgId: h.org.orgId, actorId: h.adminId, changeId: target.changeId, reason: "unreadable snapshot" }),
      (e: unknown) =>
        e instanceof EventVerbError &&
        /pre-rescind employment snapshot could not be read/.test((e as Error).message),
    );
    const filed = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from employment_changes
       where org_id = ${h.org.orgId} and reverses_change_id = ${target.changeId}
    `)).rows[0]!.n;
    assert.equal(filed, 0, "a refused rescind files no event");
  }, { bypass: true });
});

test("correct defaults to a pre-filled reapproval request; direct when allowed", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
    const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Automation Worker", withVersion: false });
    await addLiveVersion(h.org.orgId, employmentId, { status: "active", from: "2026-01-01", changeKind: "status_changed", reason: "automation seed", sourceRef: "hr16-seed" });
    const target = await addLiveVersion(h.org.orgId, employmentId, { status: "on_leave", from: "2026-02-01", changeKind: "status_changed", reason: "automation seed", sourceRef: "hr16-seed" });
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
    const scopedId = await createScratchUser(h.org.orgId, "Scoped corrector", "scoped_corrector");
    await grant(h.org.orgId, scopedId, ["hrm.employment.manage"]);
    await db.execute(sql`update app_roles set subsidiary_restriction = '{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id = ${h.org.orgId} and key = 'scoped_corrector'`); // No subsidiary visible, so the scope gate refuses before the dependency gate
    await assert.rejects(
      correctEmploymentChange({
        orgId: h.org.orgId,
        actorId: scopedId,
        changeId: target.changeId,
        reason: "cross-scope correction",
        correctedFields: { status: "active" },
      }),
      /not visible/,
    );
  }, { bypass: true });
});

test("exclude-initiator: a gate assigned to the initiator refuses instead of auto-deciding", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async (h) => {
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
  }, { bypass: true });
});

test("exception scoring refusal and naming live beside the pure matrix", { skip: !DB }, async () => {
  await withHarness(setupAutomationsHarness, async () => {
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
  }, { bypass: true });
});
