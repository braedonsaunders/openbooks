import { checklistDocument as document, requiredTextForm } from "../testing/checklist-documents.ts";
import { checklistActor, openChecklist, checklistRow, setupChecklistHarness } from "../testing/checklist-fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  emptyStepDesign,
  CHECKLIST_STEP_SUBJECT_KIND,
} from "@openbooks/forms-core";
import { db, withOrgTransaction } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import {
  withHarness,
  grant,
} from "../testing/hrm-harness.ts";
import { seedApprovalFlow, createScratchUser } from "../testing/fixtures.ts";
import { decideGate } from "../flows/gates.ts";
import { installEngineSeams } from "../composition/install.ts";
import {
  saveChecklistDraft,
  retireChecklistTemplate,
  updateProcessTemplate,
  deleteProcessTemplate,
  upsertProcessTemplateStep,
  publishChecklistDraft,
  getChecklistDesigner,
  previewChecklistCoverage,
  completeProcessStep,
  submitChecklistStepApproval,
  runChecklistReminders,
  skipProcessStep,
  cancelProcess,
} from "./processes.ts";
import { getProcess } from "./processes-read.ts";
installEngineSeams();
const harness = () => setupChecklistHarness(true);
async function published(h: Awaited<ReturnType<typeof harness>>, d = document()) {
  const ctx = { orgId: h.org.orgId, actorId: h.managerId, templateId: randomUUID() };
  const saved = await saveChecklistDraft({ ...ctx, revision: 0, document: d });
  await publishChecklistDraft({
    ...ctx,
    revision: saved.revision,
    reason: "Approved HR onboarding procedure",
  });
  return { ...ctx, document: d };
}
test("whole draft saves atomically, handles identical retries and refuses a stale editor without replacing their work", async () =>
  withHarness(harness, async (h) => {
    const ctx = { orgId: h.org.orgId, actorId: h.managerId, templateId: randomUUID() },
      d = document();
    const saved = await saveChecklistDraft({ ...ctx, revision: 0, document: d });
    assert.equal(saved.revision, 1);
    assert.equal((await getChecklistDesigner(ctx)).document.steps.length, 1);
    assert.equal((await saveChecklistDraft({ ...ctx, revision: 0, document: d })).revision, 1);
    await assert.rejects(
      saveChecklistDraft({ ...ctx, revision: 0, document: { ...d, name: "Stale edit" } }),
      /Another editor saved this draft.*not been overwritten/,
    );
    assert.equal((await getChecklistDesigner(ctx)).document.name, d.name);
    const row = (await checklistRow<{ is_active: boolean }>(sql`select is_active from hrm_process_templates where id=${ctx.templateId}`));
    assert.equal(row?.is_active, false);
  }));
test("publication is versioned and does not detach removed step identities or reinterpret an open checklist", async () =>
  withHarness(harness, async (h) => {
    const ctx = await published(h);
    const opened = await openChecklist(h, { effectiveDate: "2026-10-01", templateId: ctx.templateId });
    const next = document();
    const saved = await saveChecklistDraft({ ...ctx, revision: 1, document: next });
    const value = await publishChecklistDraft({
      ...ctx,
      revision: saved.revision,
      reason: "Replace the introductory task",
    });
    assert.equal(value.publishedVersion, 2);
    const detail = await getProcess({
      ...checklistActor(h),
      processId: opened.id,
    });
    assert.equal(detail.steps[0]?.title, "Review handbook");
    assert.equal(detail.steps[0]?.sourceStepId, ctx.document.steps[0]!.id);
    const retired = (await checklistRow<{ is_current: boolean }>(sql`select is_current from hrm_process_template_steps where id=${ctx.document.steps[0]!.id}`));
    assert.equal(retired?.is_current, false);
    await assert.rejects(
      withOrgTransaction(h.org.orgId, () =>
        db.execute(
          sql`update hrm_process_template_versions set reason='Overwrite' where template_id=${ctx.templateId}`,
        ),
      ),
      (error: unknown) =>
        error instanceof Error &&
        /immutable/.test(String((error as Error & { cause?: Error }).cause?.message)),
    );
    assert.equal(
      (await publishChecklistDraft({ ...ctx, revision: saved.revision, reason: "Retry" }))
        .publishedVersion,
      2,
    );
  }));
test("publishing refuses invalid steps and equally specific overlapping templates by name", async () =>
  withHarness(harness, async (h) => {
    await published(h);
    const ctx = { orgId: h.org.orgId, actorId: h.managerId, templateId: randomUUID() },
      d = document();
    d.name = "Remote welcome";
    d.steps[0]!.title = "";
    await saveChecklistDraft({ ...ctx, revision: 0, document: d });
    await assert.rejects(
      publishChecklistDraft({ ...ctx, revision: 1, reason: "Publish" }),
      /Give this step a title/,
    );
    d.steps[0]!.title = "Welcome";
    await saveChecklistDraft({ ...ctx, revision: 1, document: d });
    await assert.rejects(
      publishChecklistDraft({ ...ctx, revision: 2, reason: "Publish" }),
      /overlaps "New colleague".*equal priority/,
    );
  }));
test("completion enforces acknowledgement, prerequisites and native form required fields", async () =>
  withHarness(harness, async (h) => {
    const d = document();
    const first = d.steps[0]!;
    d.steps.push({
      ...first,
      id: randomUUID(),
      title: "Confirm equipment",
      evidenceKind: "none",
      design: {
        ...emptyStepDesign(),
        dependencies: [first.id],
        form: requiredTextForm("Equipment", "assets", "asset", "Asset number"),
      },
    });
    const ctx = await published(h, d);
    await previewChecklistCoverage({
      ...ctx,
      employmentId: h.employmentId,
      effectiveDate: "2026-10-01",
    });
    const opened = await openChecklist(h, { effectiveDate: "2026-10-01", templateId: ctx.templateId });
    const detail = await getProcess({
      ...checklistActor(h),
      processId: opened.id,
    });
    const one = detail.steps[0]!,
      two = detail.steps[1]!,
      actor = { orgId: h.org.orgId, actorId: h.managerId };
    await assert.rejects(
      completeProcessStep({ ...actor, stepId: one.id }),
      /Confirm that you reviewed/,
    );
    await assert.rejects(
      completeProcessStep({ ...actor, stepId: two.id, response: { asset: "LAP-42" } }),
      /prerequisite.*Review handbook/,
    );
    await completeProcessStep({ ...actor, stepId: one.id, acknowledged: true });
    await assert.rejects(
      completeProcessStep({ ...actor, stepId: two.id, response: {} }),
      /Asset number: Required/,
    );
    await completeProcessStep({ ...actor, stepId: two.id, response: { asset: "LAP-42" } });
    const stored = (await checklistRow<{ response: { asset: string } }>(sql`select response from hrm_process_steps where id=${two.id}`));
    assert.equal(stored?.response.asset, "LAP-42");
  }));
test("approval uses native gates, prevents self approval, retries rejection and binds completion to reviewed evidence", async () =>
  withHarness(harness, async (h) => {
    await seedApprovalFlow(h.org.orgId, {
      subjectKind: CHECKLIST_STEP_SUBJECT_KIND,
      assignees: [{ type: "user", userId: h.approverId }],
      mode: "any",
      preventSelfApproval: true,
    });
    const d = document();
    d.steps[0]!.design.approval = true;
    d.steps[0]!.design.form = requiredTextForm("Evidence", "proof", "reference", "Reference");
    const ctx = await published(h, d);
    const opened = await openChecklist(h, { effectiveDate: "2026-10-01", templateId: ctx.templateId });
    const step = (
      await getProcess({ orgId: h.org.orgId, actorId: h.managerId, processId: opened.id })
    ).steps[0]!;
    const actor = {
      ...checklistActor(h),
      stepId: step.id,
      acknowledged: true,
      response: { reference: "DOC-10" },
    };
    await assert.rejects(completeProcessStep(actor), /requires approval/);
    await submitChecklistStepApproval(actor);
    let gate = (await checklistRow<{ id: string }>(sql`select id from flow_gates where org_id=${h.org.orgId} and subject_id=${step.id} and status='pending'`))!;
    await assert.rejects(
      decideGate({ gateId: gate.id, decision: "approved", userId: h.managerId }),
      /self|assigned|approv/i,
    );
    await decideGate({ gateId: gate.id, decision: "rejected", userId: h.approverId });
    await submitChecklistStepApproval({ ...actor, response: { reference: "DOC-11" } });
    gate = (await checklistRow<{ id: string }>(sql`select id from flow_gates where org_id=${h.org.orgId} and subject_id=${step.id} and status='pending'`))!;
    assert.ok(gate);
    await decideGate({ gateId: gate.id, decision: "approved", userId: h.approverId });
    await assert.rejects(completeProcessStep(actor), /differs from the approved submission/);
    await completeProcessStep({ ...actor, response: { reference: "DOC-11" } });
  }));
test("reminders are daily and stop after a controlled skip or cancellation", async () =>
  withHarness(harness, async (h) => {
    const employeeId = await createScratchUser(
      h.org.orgId,
      "Checklist employee",
      "checklist_employee",
    );
    await grant(h.org.orgId, employeeId, ["hrm.self.read"]);
    await db.execute(
      sql`update users set party_id=${h.worker} where org_id=${h.org.orgId} and id=${employeeId}`,
    );
    const d = document();
    d.steps[0]!.ownerKind = "employee";
    d.steps[0]!.design.reminderDays = 0;
    const ctx = await published(h, d);
    const date = await businessToday(h.org.orgId);
    const opened = await openChecklist(h, { effectiveDate: date, templateId: ctx.templateId });
    assert.equal(await runChecklistReminders(h.org.orgId), 3);
    const ownerReminder = (await checklistRow<{ href: string }>(sql`select href from notifications where org_id=${h.org.orgId} and user_id=${employeeId} and kind='hrm_checklist'`));
    assert.ok(ownerReminder?.href.startsWith("/me/checklists?step="));
    assert.equal(await runChecklistReminders(h.org.orgId), 0);
    const step = (
      await getProcess({ orgId: h.org.orgId, actorId: h.managerId, processId: opened.id })
    ).steps[0]!;
    await skipProcessStep({
      ...checklistActor(h),
      stepId: step.id,
      reason: "Handbook covered in induction",
    });
    assert.equal(await runChecklistReminders(h.org.orgId), 0);
    await cancelProcess({
      ...checklistActor(h),
      processId: opened.id,
      reason: "Duplicate assignment",
    });
  }));

test("retirement preserves history, blocks legacy mutations and requires a new publication for reuse", async () =>
  withHarness(harness, async (h) => {
    const ctx = await published(h);
    await assert.rejects(
      updateProcessTemplate({ ...ctx, isActive: false }),
      /Retire template there/,
    );
    await assert.rejects(
      upsertProcessTemplateStep({
        ...ctx,
        position: 1,
        title: "Legacy edit",
        ownerKind: "manager",
      }),
      /publish its whole draft/,
    );
    await assert.rejects(deleteProcessTemplate(ctx), /published versions.*Retire template/);
    await assert.rejects(
      retireChecklistTemplate({ ...ctx, revision: 0, reason: "Outdated process" }),
      /draft changed before retirement/,
    );
    const retired = await retireChecklistTemplate({
      ...ctx,
      revision: 1,
      reason: "Replaced onboarding procedure",
    });
    assert.equal(retired.isActive, false);
    assert.equal(retired.publishedVersion, 1);
    await assert.rejects(
      openChecklist(h, { effectiveDate: "2026-10-01", templateId: ctx.templateId }),
      /retired|inactive|active/i,
    );
    const live = await publishChecklistDraft({
      ...ctx,
      revision: 1,
      reason: "Procedure reinstated after review",
    });
    assert.equal(live.isActive, true);
    assert.equal(live.publishedVersion, 2);
    const audits = (
      await db.execute<{ changes: { event?: string; reason?: string } }>(
        sql`select changes from audit_log where org_id=${h.org.orgId} and row_id=${ctx.templateId}`,
      )
    ).rows;
    assert.ok(
      audits.some(
        (a) =>
          a.changes.event === "retired" && a.changes.reason === "Replaced onboarding procedure",
      ),
    );
  }));
