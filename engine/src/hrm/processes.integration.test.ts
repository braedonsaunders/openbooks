import { checklistActor, openChecklist, checklistRefusal, checklistRow, setupChecklistHarness } from "../testing/checklist-fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
} from "../testing/fixtures.ts";
import {
  DB,
  enableHrm,
  grant,
  mkEmployment,
  mkParty,
  withHarness,
} from "../testing/hrm-harness.ts";
import { decideGate } from "../flows/gates.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import {
  createChangeRequestDraft,
  submitChangeRequest,
} from "./change-requests.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import {
  cancelProcess,
  completeProcess,
  completeProcessStep,
  createProcessTemplate,
  deleteProcessTemplate,
  listProcessTemplates,
  skipProcessStep,
  upsertProcessTemplateStep,
} from "./processes.ts";
import { getOnboardingOverview, getOwnStep, getProcess, listProcesses } from "./processes-read.ts";
import { installEngineSeams } from "../composition/install.ts";

// Native approval decisions release through the installed engine handlers.
installEngineSeams();



async function mkFolder(orgId: string, name: string, ownerId: string | null, isPrivate: boolean): Promise<string> {
  return (await checklistRow<{ id: string }>(sql`
    insert into folders (org_id, name, owner_id, is_private)
    values (${orgId}, ${name}, ${ownerId}, ${isPrivate}) returning id`))!.id;
}

async function mkFile(orgId: string, folderId: string, name: string): Promise<string> {
  return (await checklistRow<{ id: string }>(sql`
    insert into files (org_id, folder_id, name, file_type, content_type, size_bytes)
    values (${orgId}, ${folderId}, ${name}, 'other', 'application/octet-stream', 10) returning id`))!.id;
}

async function seedTemplate(
  orgId: string,
  actorId: string,
  kind: string,
  overrides: { steps?: Array<Record<string, unknown>>; appliesTo?: { employerSubsidiaryId?: string | null; departmentId?: string | null } } = {},
): Promise<string> {
  const template = await createProcessTemplate({
    orgId,
    actorId,
    kind,
    name: `${kind} checklist`,
    appliesTo: overrides.appliesTo,
  });
  const steps = overrides.steps ?? [
    { position: 0, title: "Prepare desk", ownerKind: "manager", dueOffsetDays: -1 },
    { position: 1, title: "Sign handbook", ownerKind: "employee", evidenceKind: "acknowledgement" },
  ];
  for (const step of steps) {
    await upsertProcessTemplateStep({
      orgId,
      actorId,
      templateId: template.id,
      position: step.position as number,
      title: step.title,
      description: (step.description as string | null) ?? null,
      ownerKind: step.ownerKind,
      ownerPartyId: (step.ownerPartyId as string | null) ?? null,
      dueOffsetDays: (step.dueOffsetDays as number | undefined) ?? 0,
      required: (step.required as boolean | undefined) ?? true,
      evidenceKind: step.evidenceKind ?? "none",
    });
  }
  return template.id;
}

async function stepRows(processId: string): Promise<Array<{ id: string; title: string; due_on: string; status: string }>> {
  return (await db.execute<{ id: string; title: string; due_on: string; status: string }>(sql`
    select id, title, due_on::text as due_on, status from hrm_process_steps
     where process_id = ${processId} order by position`)).rows;
}

const setupProcessesHarness = () => setupChecklistHarness();
function processTest(title: string, check: (h: Awaited<ReturnType<typeof setupProcessesHarness>>) => Promise<void>) {
  return test(title, { skip: !DB }, () => withHarness(setupProcessesHarness, check));
}

test("0193 migration exposes four org-isolated tables with the open-process unique", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const tables = (await db.execute<{ tbl: string; force: boolean; policies: number }>(sql`
      select c.relname as tbl, c.relforcerowsecurity as force, count(p.polname)::int as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        left join pg_policy p on p.polrelid = c.oid
       where n.nspname = 'public' and c.relname in ('hrm_process_templates', 'hrm_process_template_steps',
             'hrm_processes', 'hrm_process_steps')
       group by c.relname, c.relforcerowsecurity`)).rows;
    assert.equal(tables.length, 4);
    for (const table of tables) {
      assert.equal(table.force, true, `${table.tbl} must keep FORCE RLS live`);
      assert.equal(table.policies, 1, `${table.tbl} must keep exactly the org_isolation policy`);
    }
    // The partial unique index restricts only open processes.
    const unique = (await db.execute<{ name: string; def: string }>(sql`
      select indexname as name, indexdef as def from pg_indexes
       where schemaname = 'public' and indexname = 'hrm_processes_open_one_per_kind'`)).rows;
    assert.equal(unique.length, 1, "the one-open-process-per-kind partial unique index must exist");
    assert.match(unique[0]!.def, /CREATE UNIQUE INDEX/, "it is unique");
    assert.match(unique[0]!.def, /WHERE .*status[^']*'open'/, "it covers only open processes");
    const covering = (await db.execute<{ name: string }>(sql`
      select conname as name from pg_constraint where conname = 'files_org_id_id_unique'`)).rows;
    assert.equal(covering.length, 1, "the files covering unique for the evidence FK must exist");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

processTest("open snapshots the template and refuses duplicates and versionless employments", async (h) => {
    await seedTemplate(h.org.orgId, h.managerId, "onboarding");
    const opened = await openChecklist(h);
    assert.equal(opened.status, "open");
    assert.deepEqual(opened.progress, { total: 2, required: 2, doneRequired: 0, allRequiredDone: false });
    const steps = await stepRows(opened.id);
    assert.deepEqual(steps.map((step) => [step.title, step.due_on]), [
      ["Prepare desk", "2026-08-31"],
      ["Sign handbook", "2026-09-01"],
    ]);
    // The snapshot is the record: later template edits never rewrite it.
    const templateId = opened.templateId;
    const extra = await upsertProcessTemplateStep({
      ...checklistActor(h),
      templateId,
      position: 2,
      title: "Late addition",
      ownerKind: "hr",
    });
    assert.ok(extra.id);
    assert.equal((await stepRows(opened.id)).length, 2);

    await assert.rejects(
      openChecklist(h),
      checklistRefusal("DUPLICATE_OPEN", /complete or cancel it before opening another/),
    );

    const bare = await mkEmployment(h.org.orgId, await mkParty(h.org.orgId, "Versionless"), h.org.subsidiaryId);
    await assert.rejects(
      openChecklist(h, { employmentId: bare }),
      checklistRefusal("NO_LIVE_VERSION", /has no live version on 2026-09-01/),
    );
  });

processTest("the template picker and explicit open both enforce the employment scope", async (h) => {
    const otherSubsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${otherSubsidiaryId}, ${h.org.orgId}, ${h.org.subsidiaryId}, 'Other employer', 'USD', 'US')
    `);
    const templateId = await seedTemplate(h.org.orgId, h.managerId, "onboarding", {
      appliesTo: { employerSubsidiaryId: otherSubsidiaryId },
    });
    const offered = await listProcessTemplates({
      ...checklistActor(h),
      activeOnly: true,
      kind: "onboarding",
      employmentId: h.employmentId,
      effectiveDate: "2026-09-01",
    });
    assert.deepEqual(offered, [], "the picker never offers a template outside this employment's scope");
    await assert.rejects(
      openChecklist(h, { templateId }),
      checklistRefusal("REFUSED", /does not cover this employment.*choose a template offered by the checklist picker/),
    );
    const written = (await checklistRow<{ n: number }>(sql`
      select count(*)::int as n from hrm_processes where org_id = ${h.org.orgId} and employment_id = ${h.employmentId}
    `))!.n;
    assert.equal(written, 0, "the refused explicit template wrote no checklist");
  });

processTest("step evidence, required skips, and process completion refuse by name", async (h) => {
    await seedTemplate(h.org.orgId, h.managerId, "onboarding", {
      steps: [
        { position: 0, title: "Upload contract", ownerKind: "hr", evidenceKind: "attachment" },
        { position: 1, title: "Sign handbook", ownerKind: "employee", evidenceKind: "acknowledgement" },
      ],
    });
    const opened = await openChecklist(h);
    const steps = await stepRows(opened.id);
    const upload = steps[0]!.id;
    const sign = steps[1]!.id;

    await assert.rejects(
      completeProcessStep({ orgId: h.org.orgId, actorId: h.managerId, stepId: upload }),
      checklistRefusal("EVIDENCE_REQUIRED", /requires attachment evidence/),
    );
    await assert.rejects(
      completeProcessStep({ orgId: h.org.orgId, actorId: h.managerId, stepId: upload, attachmentId: randomUUID() }),
      checklistRefusal("UNREADABLE_ATTACHMENT", /not readable by this actor|no file|not a file id/),
    );
    const folder = await mkFolder(h.org.orgId, "Shared", null, false);
    const file = await mkFile(h.org.orgId, folder, "contract.pdf");
    await completeProcessStep({ orgId: h.org.orgId, actorId: h.managerId, stepId: upload, attachmentId: file });
    const stored = (await checklistRow<{ status: string; attachment_id: string | null }>(sql`
      select status, attachment_id::text as attachment_id from hrm_process_steps where id = ${upload}`))!;
    assert.equal(stored.status, "done");
    assert.equal(stored.attachment_id, file);

    await assert.rejects(
      completeProcess({ orgId: h.org.orgId, actorId: h.managerId, processId: opened.id }),
      checklistRefusal("REFUSED", /1 required step\(s\) still pending \("Sign handbook"\)/),
    );
    await completeProcessStep({ orgId: h.org.orgId, actorId: h.managerId, stepId: sign });
    const done = (await checklistRow<{ done_by: string | null; done_at: string | null }>(sql`
      select done_by::text as done_by, done_at::text as done_at from hrm_process_steps where id = ${sign}`))!;
    assert.equal(done.done_by, h.managerId, "acknowledgement records who");
    assert.ok(done.done_at, "acknowledgement records when");
    await completeProcess({ orgId: h.org.orgId, actorId: h.managerId, processId: opened.id });
    const status = (await checklistRow<{ status: string }>(sql`
      select status from hrm_processes where id = ${opened.id}`))!.status;
    assert.equal(status, "completed");
  });

processTest("skipping a required step without employment.manage is refused", async (h) => {
    await seedTemplate(h.org.orgId, h.managerId, "onboarding");
    const limited = await createScratchUser(h.org.orgId, "HRM Limited", "hrm_limited");
    await grant(h.org.orgId, limited, ["hrm.process.read", "hrm.process.manage"]);
    const opened = await openChecklist(h);
    const steps = await stepRows(opened.id);
    await assert.rejects(
      skipProcessStep({ orgId: h.org.orgId, actorId: limited, stepId: steps[0]!.id, reason: "not needed" }),
      (error: unknown) =>
        error instanceof HrmAuthorizationError &&
        /hrm\.employment\.manage/.test(error.message),
    );
    // ...while the employment.manage holder skips with a reason.
    await skipProcessStep({ orgId: h.org.orgId, actorId: h.managerId, stepId: steps[0]!.id, reason: "desk ready" });
    const status = (await checklistRow<{ status: string; skip_reason: string | null }>(sql`
      select status, skip_reason from hrm_process_steps where id = ${steps[0]!.id}`))!;
    assert.equal(status.status, "skipped");
    assert.equal(status.skip_reason, "desk ready");
  });

processTest("self-service completes only one's own steps and reads only the step", async (h) => {
    await seedTemplate(h.org.orgId, h.managerId, "onboarding", {
      steps: [
        { position: 0, title: "Sign handbook", ownerKind: "employee", evidenceKind: "acknowledgement" },
        { position: 1, title: "Manager one-to-one", ownerKind: "manager" },
      ],
    });
    const employeeId = await createScratchUser(h.org.orgId, "HRM Employee", "hrm_employee");
    await db.execute(sql`update users set party_id = ${h.workerPartyId} where id = ${employeeId}`);
    const opened = await openChecklist(h);
    const steps = await stepRows(opened.id);
    const own = steps[0]!.id;
    const foreign = steps[1]!.id;
    await completeProcessStep({ orgId: h.org.orgId, actorId: employeeId, stepId: own });
    await assert.rejects(
      completeProcessStep({ orgId: h.org.orgId, actorId: employeeId, stepId: foreign }),
      checklistRefusal("FORBIDDEN", /owned by someone else/),
    );
    const seen = await getOwnStep({ orgId: h.org.orgId, actorId: employeeId, stepId: own });
    assert.deepEqual(Object.keys(seen).sort(), [
      "approvalStatus", "attachmentId", "blocked",
      "description",
      "design",
      "dueOn",
      "evidenceKind",
      "id",
      "overdue",
      "processId",
      "processStatus",
      "required",
      "response",
      "status",
      "title",
    ]);
    await assert.rejects(
      getOwnStep({ orgId: h.org.orgId, actorId: employeeId, stepId: foreign }),
      checklistRefusal("NOT_FOUND"),
    );
  });

processTest("reads segment overdue work and the overview under RLS with a second org", async (h) => {
    await seedTemplate(h.org.orgId, h.managerId, "onboarding");
    const opened = await openChecklist(h, { effectiveDate: "2020-06-01" });
    const overdue = await listProcesses({ orgId: h.org.orgId, actorId: h.managerId, segment: "overdue" });
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0]!.id, opened.id);
    assert.ok(overdue[0]!.overdueSteps > 0);
    const detail = await getProcess({ orgId: h.org.orgId, actorId: h.managerId, processId: opened.id });
    assert.ok(detail.steps.every((step) => step.overdue));
    const overview = await getOnboardingOverview({ orgId: h.org.orgId, actorId: h.managerId });
    assert.equal(overview.openProcesses.length, 1);
    assert.ok(overview.overdueSteps.length > 0);

    const foreign = await createScratchOrg();
    await enableHrm(foreign.orgId);
    try {
      const outsider = await createScratchUser(foreign.orgId, "Outsider", "outsider");
      await grant(foreign.orgId, outsider, ["hrm.process.read", "hrm.process.manage"]);
      assert.deepEqual(
        await listProcesses({ orgId: foreign.orgId, actorId: outsider, segment: "open" }),
        [],
      );
      await assert.rejects(
        getProcess({ orgId: foreign.orgId, actorId: outsider, processId: opened.id }),
        checklistRefusal("NOT_FOUND"),
      );
    } finally {
      await dropScratchOrg(foreign.orgId);
    }
  });

async function approvedHire(h: Awaited<ReturnType<typeof setupProcessesHarness>>, withTemplate: boolean) {
    await seedApprovalFlow(h.org.orgId, {
      subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
      assignees: [{ type: "user", userId: h.managerId }],
      mode: "any",
    });
    await grant(h.org.orgId, h.managerId, ["hrm.employment.read", "hrm.employment.approve"]);
    if (withTemplate) await seedTemplate(h.org.orgId, h.managerId, "onboarding");
    const workerPartyId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${workerPartyId}, ${h.org.orgId}, 'person', 'Hired Worker', true, '{}'::jsonb)`);
    const employmentId = randomUUID();
    await db.execute(sql`
      insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
      values (${employmentId}, ${h.org.orgId}, ${workerPartyId}, ${h.org.subsidiaryId}, 1)`);
    const author = await createScratchUser(h.org.orgId, "HRM Author", "hrm_author");
    await grant(h.org.orgId, author, ["hrm.employment.read", "hrm.employment.manage"]);
    const draft = await createChangeRequestDraft({
      orgId: h.org.orgId,
      actorId: author,
      employmentId,
      payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    });
    await submitChangeRequest({
      orgId: h.org.orgId,
      actorId: author,
      requestId: draft.id,
      reason: "September cohort",
    });
    const gate = (await checklistRow<{ id: string }>(sql`
      select id from flow_gates where subject_id = ${draft.id} order by created_at`))!;
    await decideGate({ gateId: gate.id, decision: "approved", userId: h.managerId });
    return { employmentId, draft };
}

processTest("approved hire auto-opens onboarding in the apply transaction", async (h) => {
    const { employmentId } = await approvedHire(h, true);
    const processes = (await db.execute<{ kind: string; opened_by_change_id: string | null; steps: number }>(sql`
      select p.kind, p.opened_by_change_id::text as opened_by_change_id,
             (select count(*)::int from hrm_process_steps s where s.process_id = p.id) as steps
        from hrm_processes p where p.employment_id = ${employmentId}`)).rows;
    assert.equal(processes.length, 1);
    assert.equal(processes[0]!.kind, "onboarding");
    assert.ok(processes[0]!.opened_by_change_id, "the process evidences the change that opened it");
    assert.equal(processes[0]!.steps, 2);
  });

processTest("hire without a template applies the hire and opens no checklist; the explicit open still refuses", async (h) => {
    const { employmentId, draft } = await approvedHire(h, false);
    const status = (await checklistRow<{ status: string }>(sql`
      select status from hrm_employment_change_requests where id = ${draft.id}`))!.status;
    assert.equal(status, "applied", "the hire applies without a checklist template");
    const versions = (await checklistRow<{ n: number }>(sql`
      select count(*)::int as n from worker_employment_versions where employment_id = ${employmentId}`))!.n;
    assert.ok(versions >= 1, "the applied hire wrote its version");
    const changes = (await checklistRow<{ n: number }>(sql`
      select count(*)::int as n from employment_changes where employment_id = ${employmentId}`))!.n;
    assert.ok(changes >= 1, "the applied hire recorded its change event");
    const processes = (await checklistRow<{ n: number }>(sql`
      select count(*)::int as n from hrm_processes where employment_id = ${employmentId}`))!.n;
    assert.equal(processes, 0, "nothing was owed, so no process opened");
    const steps = (await checklistRow<{ n: number }>(sql`
      select count(*)::int as n from hrm_process_steps
       where process_id in (select id from hrm_processes where employment_id = ${employmentId})`))!.n;
    assert.equal(steps, 0, "no steps were snapshotted");
    await assert.rejects(
      openChecklist(h, { employmentId, effectiveDate: "2026-09-14" }),
      /no active onboarding template covers this employment — create or activate one under HRM → Process checklists → Checklist templates/,
    );
    const stillNone = (await checklistRow<{ n: number }>(sql`
      select count(*)::int as n from hrm_processes where employment_id = ${employmentId}`))!.n;
    assert.equal(stillNone, 0, "the refused explicit open wrote nothing");
  });

processTest("deleting a template that opened processes is refused with the remedy", async (h) => {
    const templateId = await seedTemplate(h.org.orgId, h.managerId, "onboarding");
    await openChecklist(h);
    await assert.rejects(
      deleteProcessTemplate({ orgId: h.org.orgId, actorId: h.managerId, templateId }),
      checklistRefusal("REFUSED", /set is_active = false to retire it/),
    );
    // Cancellation keeps history: terminal processes stay recorded.
    const processes = (await db.execute<{ id: string }>(sql`
      select id from hrm_processes where template_id = ${templateId}`)).rows;
    await cancelProcess({
      ...checklistActor(h),
      processId: processes[0]!.id,
      reason: "hire withdrawn",
    });
    const cancelled = (await checklistRow<{ status: string; cancel_reason: string }>(sql`
      select status, cancel_reason from hrm_processes where id = ${processes[0]!.id}`))!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancel_reason, "hire withdrawn");
  });
