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
  type ScratchOrg,
} from "../testing/fixtures.ts";
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
  HrmProcessError,
  openProcess,
  skipProcessStep,
  upsertProcessTemplateStep,
} from "./processes.ts";
import { getOnboardingOverview, getOwnStep, getProcess, listProcesses } from "./processes-read.ts";

/**
 * HR-4 onboarding / offboarding / transfer processes over the real 0193
 * tables — DB-owned (the integrator runs these at gate; they skip without
 * OPENBOOKS_DB_URL).
 *
 * Proofs are read back from storage, never from the service's own return
 * values alone, and every refusal asserts its code AND its message: the
 * message is the entire product of a failing check. A second organization
 * proves RLS invisibility on the read service.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

// Same shape as the change-request suite: the approval release refuses an
// approver with no linked person by design, so every decider gets one.
async function linkPerson(orgId: string, userId: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${`Person ${partyId.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${partyId} where id = ${userId} and org_id = ${orgId}`);
  return partyId;
}

async function mkParty(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name) values (${orgId}, 'person', ${name}) returning id`)).rows[0]!.id;
}

async function mkEmployment(orgId: string, partyId: string, subsidiaryId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
}

async function mkVersion(orgId: string, employmentId: string, from: string, status = "active"): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from)
    values (${orgId}, ${employmentId}, 1, ${status}, ${from}::date) returning id`)).rows[0]!.id;
}

async function mkFolder(orgId: string, name: string, ownerId: string | null, isPrivate: boolean): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into folders (org_id, name, owner_id, is_private)
    values (${orgId}, ${name}, ${ownerId}, ${isPrivate}) returning id`)).rows[0]!.id;
}

async function mkFile(orgId: string, folderId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into files (org_id, folder_id, name, file_type, content_type, size_bytes)
    values (${orgId}, ${folderId}, ${name}, 'other', 'application/octet-stream', 10) returning id`)).rows[0]!.id;
}

type Harness = {
  org: ScratchOrg;
  managerId: string;
  workerPartyId: string;
  employmentId: string;
};

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const managerId = await createScratchUser(org.orgId, "HRM Process Manager", "hrm_process_manager");
  await grant(org.orgId, managerId, ["hrm.process.read", "hrm.process.manage", "hrm.employment.manage"]);
  await linkPerson(org.orgId, managerId);
  const workerPartyId = await mkParty(org.orgId, "Process Worker");
  const employmentId = await mkEmployment(org.orgId, workerPartyId, org.subsidiaryId);
  await mkVersion(org.orgId, employmentId, "2020-01-01");
  return { org, managerId, workerPartyId, employmentId };
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

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function stepRows(processId: string): Promise<Array<{ id: string; title: string; due_on: string; status: string }>> {
  return (await db.execute<{ id: string; title: string; due_on: string; status: string }>(sql`
    select id, title, due_on::text as due_on, status from hrm_process_steps
     where process_id = ${processId} order by position`)).rows;
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
    // A partial uniqueness rule is an INDEX in Postgres (a UNIQUE constraint
    // cannot carry a WHERE clause), so it is probed in pg_indexes and its
    // predicate is pinned: only OPEN processes are unique per kind.
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

test("open snapshots the template and refuses duplicates and versionless employments", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedTemplate(h.org.orgId, h.managerId, "onboarding");
    const opened = await openProcess({
      orgId: h.org.orgId,
      actorId: h.managerId,
      employmentId: h.employmentId,
      kind: "onboarding",
      effectiveDate: "2026-09-01",
    });
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
      orgId: h.org.orgId,
      actorId: h.managerId,
      templateId,
      position: 2,
      title: "Late addition",
      ownerKind: "hr",
    });
    assert.ok(extra.id);
    assert.equal((await stepRows(opened.id)).length, 2);

    await assert.rejects(
      openProcess({
        orgId: h.org.orgId,
        actorId: h.managerId,
        employmentId: h.employmentId,
        kind: "onboarding",
        effectiveDate: "2026-09-01",
      }),
      (error: unknown) =>
        error instanceof HrmProcessError &&
        error.code === "DUPLICATE_OPEN" &&
        /complete or cancel it before opening another/.test(error.message),
    );

    const bare = await mkEmployment(h.org.orgId, await mkParty(h.org.orgId, "Versionless"), h.org.subsidiaryId);
    await assert.rejects(
      openProcess({
        orgId: h.org.orgId,
        actorId: h.managerId,
        employmentId: bare,
        kind: "onboarding",
        effectiveDate: "2026-09-01",
      }),
      (error: unknown) =>
        error instanceof HrmProcessError &&
        error.code === "NO_LIVE_VERSION" &&
        /has no live version on 2026-09-01/.test(error.message),
    );
  });
});

test("step evidence, required skips, and process completion refuse by name", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedTemplate(h.org.orgId, h.managerId, "onboarding", {
      steps: [
        { position: 0, title: "Upload contract", ownerKind: "hr", evidenceKind: "attachment" },
        { position: 1, title: "Sign handbook", ownerKind: "employee", evidenceKind: "acknowledgement" },
      ],
    });
    const opened = await openProcess({
      orgId: h.org.orgId,
      actorId: h.managerId,
      employmentId: h.employmentId,
      kind: "onboarding",
      effectiveDate: "2026-09-01",
    });
    const steps = await stepRows(opened.id);
    const upload = steps[0]!.id;
    const sign = steps[1]!.id;

    await assert.rejects(
      completeProcessStep({ orgId: h.org.orgId, actorId: h.managerId, stepId: upload }),
      (error: unknown) =>
        error instanceof HrmProcessError &&
        error.code === "EVIDENCE_REQUIRED" &&
        /requires attachment evidence/.test(error.message),
    );
    await assert.rejects(
      completeProcessStep({ orgId: h.org.orgId, actorId: h.managerId, stepId: upload, attachmentId: randomUUID() }),
      (error: unknown) =>
        error instanceof HrmProcessError &&
        error.code === "UNREADABLE_ATTACHMENT" &&
        /not readable by this actor|no file|not a file id/.test(error.message),
    );
    const folder = await mkFolder(h.org.orgId, "Shared", null, false);
    const file = await mkFile(h.org.orgId, folder, "contract.pdf");
    await completeProcessStep({ orgId: h.org.orgId, actorId: h.managerId, stepId: upload, attachmentId: file });
    const stored = (await db.execute<{ status: string; attachment_id: string | null }>(sql`
      select status, attachment_id::text as attachment_id from hrm_process_steps where id = ${upload}`)).rows[0]!;
    assert.equal(stored.status, "done");
    assert.equal(stored.attachment_id, file);

    // The manager holds employment.manage in this harness, so a required
    // skip with a reason succeeds; the refusal leg is proven below with a
    // manager who lacks it. Completion while required steps pend refuses.
    await assert.rejects(
      completeProcess({ orgId: h.org.orgId, actorId: h.managerId, processId: opened.id }),
      (error: unknown) =>
        error instanceof HrmProcessError &&
        error.code === "REFUSED" &&
        /1 required step\(s\) still pending \("Sign handbook"\)/.test(error.message),
    );
    await completeProcessStep({ orgId: h.org.orgId, actorId: h.managerId, stepId: sign });
    const done = (await db.execute<{ done_by: string | null; done_at: string | null }>(sql`
      select done_by::text as done_by, done_at::text as done_at from hrm_process_steps where id = ${sign}`)).rows[0]!;
    assert.equal(done.done_by, h.managerId, "acknowledgement records who");
    assert.ok(done.done_at, "acknowledgement records when");
    await completeProcess({ orgId: h.org.orgId, actorId: h.managerId, processId: opened.id });
    const status = (await db.execute<{ status: string }>(sql`
      select status from hrm_processes where id = ${opened.id}`)).rows[0]!.status;
    assert.equal(status, "completed");
  });
});

test("skipping a required step without employment.manage is refused", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedTemplate(h.org.orgId, h.managerId, "onboarding");
    const limited = await createScratchUser(h.org.orgId, "HRM Limited", "hrm_limited");
    await grant(h.org.orgId, limited, ["hrm.process.read", "hrm.process.manage"]);
    const opened = await openProcess({
      orgId: h.org.orgId,
      actorId: h.managerId,
      employmentId: h.employmentId,
      kind: "onboarding",
      effectiveDate: "2026-09-01",
    });
    const steps = await stepRows(opened.id);
    await assert.rejects(
      skipProcessStep({ orgId: h.org.orgId, actorId: limited, stepId: steps[0]!.id, reason: "not needed" }),
      (error: unknown) =>
        error instanceof HrmAuthorizationError &&
        /hrm\.employment\.manage/.test(error.message),
    );
    // ...while the employment.manage holder skips with a reason.
    await skipProcessStep({ orgId: h.org.orgId, actorId: h.managerId, stepId: steps[0]!.id, reason: "desk ready" });
    const status = (await db.execute<{ status: string; skip_reason: string | null }>(sql`
      select status, skip_reason from hrm_process_steps where id = ${steps[0]!.id}`)).rows[0]!;
    assert.equal(status.status, "skipped");
    assert.equal(status.skip_reason, "desk ready");
  });
});

test("self-service completes only one's own steps and reads only the step", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedTemplate(h.org.orgId, h.managerId, "onboarding", {
      steps: [
        { position: 0, title: "Sign handbook", ownerKind: "employee", evidenceKind: "acknowledgement" },
        { position: 1, title: "Manager one-to-one", ownerKind: "manager" },
      ],
    });
    const employeeId = await createScratchUser(h.org.orgId, "HRM Employee", "hrm_employee");
    await db.execute(sql`update users set party_id = ${h.workerPartyId} where id = ${employeeId}`);
    const opened = await openProcess({
      orgId: h.org.orgId,
      actorId: h.managerId,
      employmentId: h.employmentId,
      kind: "onboarding",
      effectiveDate: "2026-09-01",
    });
    const steps = await stepRows(opened.id);
    const own = steps[0]!.id;
    const foreign = steps[1]!.id;
    await completeProcessStep({ orgId: h.org.orgId, actorId: employeeId, stepId: own });
    await assert.rejects(
      completeProcessStep({ orgId: h.org.orgId, actorId: employeeId, stepId: foreign }),
      (error: unknown) =>
        error instanceof HrmProcessError &&
        error.code === "FORBIDDEN" &&
        /owned by someone else/.test(error.message),
    );
    const seen = await getOwnStep({ orgId: h.org.orgId, actorId: employeeId, stepId: own });
    assert.deepEqual(Object.keys(seen).sort(), [
      "description",
      "dueOn",
      "evidenceKind",
      "id",
      "overdue",
      "processId",
      "required",
      "status",
      "title",
    ]);
    await assert.rejects(
      getOwnStep({ orgId: h.org.orgId, actorId: employeeId, stepId: foreign }),
      (error: unknown) => error instanceof HrmProcessError && error.code === "NOT_FOUND",
    );
  });
});

test("reads segment overdue work and the overview under RLS with a second org", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedTemplate(h.org.orgId, h.managerId, "onboarding");
    const opened = await openProcess({
      orgId: h.org.orgId,
      actorId: h.managerId,
      employmentId: h.employmentId,
      kind: "onboarding",
      effectiveDate: "2020-06-01",
    });
    const overdue = await listProcesses({ orgId: h.org.orgId, actorId: h.managerId, segment: "overdue" });
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0]!.id, opened.id);
    assert.ok(overdue[0]!.overdueSteps > 0);
    const detail = await getProcess({ orgId: h.org.orgId, actorId: h.managerId, processId: opened.id });
    assert.ok(detail.steps.every((step) => step.overdue));
    const overview = await getOnboardingOverview({ orgId: h.org.orgId, actorId: h.managerId });
    assert.equal(overview.openProcesses.length, 1);
    assert.ok(overview.overdueSteps.length > 0);

    // The foreign org needs the hrm switch on too: with it off the reads
    // refuse FEATURE_OFF before RLS is ever exercised, so invisibility
    // would prove nothing.
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
        (error: unknown) => error instanceof HrmProcessError && error.code === "NOT_FOUND",
      );
    } finally {
      await dropScratchOrg(foreign.orgId);
    }
  });
});

test("approved hire auto-opens onboarding in the apply transaction", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedApprovalFlow(h.org.orgId, {
      subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
      assignees: [{ type: "user", userId: h.managerId }],
      mode: "any",
    });
    await grant(h.org.orgId, h.managerId, ["hrm.employment.read", "hrm.employment.approve"]);
    await seedTemplate(h.org.orgId, h.managerId, "onboarding");
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
    const gate = (await db.execute<{ id: string }>(sql`
      select id from flow_gates where subject_id = ${draft.id} order by created_at`)).rows[0]!;
    await decideGate({ gateId: gate.id, decision: "approved", userId: h.managerId });
    const processes = (await db.execute<{ kind: string; opened_by_change_id: string | null; steps: number }>(sql`
      select p.kind, p.opened_by_change_id::text as opened_by_change_id,
             (select count(*)::int from hrm_process_steps s where s.process_id = p.id) as steps
        from hrm_processes p where p.employment_id = ${employmentId}`)).rows;
    assert.equal(processes.length, 1);
    assert.equal(processes[0]!.kind, "onboarding");
    assert.ok(processes[0]!.opened_by_change_id, "the process evidences the change that opened it");
    assert.equal(processes[0]!.steps, 2);
  });
});

test("hire without a template rolls the apply back with nothing applied", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedApprovalFlow(h.org.orgId, {
      subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
      assignees: [{ type: "user", userId: h.managerId }],
      mode: "any",
    });
    await grant(h.org.orgId, h.managerId, ["hrm.employment.read", "hrm.employment.approve"]);
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
    const gate = (await db.execute<{ id: string; status: string }>(sql`
      select id, status from flow_gates where subject_id = ${draft.id} order by created_at`)).rows[0]!;
    // No onboarding template exists: the apply must refuse by name, and the
    // refusal rolls the versions back with it — no partial effect.
    // The full sentence is asserted, not only its head: the kind and the
    // remedy must survive the release wrap to reach the operator.
    await assert.rejects(
      decideGate({ gateId: gate.id, decision: "approved", userId: h.managerId }),
      /no active onboarding template covers this employment — create or activate one in Setup that covers this employer subsidiary and department/,
    );
    const status = (await db.execute<{ status: string }>(sql`
      select status from hrm_employment_change_requests where id = ${draft.id}`)).rows[0]!.status;
    assert.equal(status, "pending_approval");
    const versions = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from worker_employment_versions where employment_id = ${employmentId}`)).rows[0]!.n;
    assert.equal(versions, 0, "the refused apply wrote no versions");
    const processes = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_processes where employment_id = ${employmentId}`)).rows[0]!.n;
    assert.equal(processes, 0, "the refused apply opened no process");
    const steps = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_process_steps
       where process_id in (select id from hrm_processes where employment_id = ${employmentId})`)).rows[0]!.n;
    assert.equal(steps, 0, "the refused apply snapshotted no steps");
    const changes = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from employment_changes where employment_id = ${employmentId}`)).rows[0]!.n;
    assert.equal(changes, 0, "the refused apply recorded no employment change event");
  });
});

test("deleting a template that opened processes is refused with the remedy", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const templateId = await seedTemplate(h.org.orgId, h.managerId, "onboarding");
    await openProcess({
      orgId: h.org.orgId,
      actorId: h.managerId,
      employmentId: h.employmentId,
      kind: "onboarding",
      effectiveDate: "2026-09-01",
    });
    await assert.rejects(
      deleteProcessTemplate({ orgId: h.org.orgId, actorId: h.managerId, templateId }),
      (error: unknown) =>
        error instanceof HrmProcessError &&
        error.code === "REFUSED" &&
        /set is_active = false to retire it/.test(error.message),
    );
    // Cancellation keeps history: terminal processes stay recorded.
    const processes = (await db.execute<{ id: string }>(sql`
      select id from hrm_processes where template_id = ${templateId}`)).rows;
    await cancelProcess({
      orgId: h.org.orgId,
      actorId: h.managerId,
      processId: processes[0]!.id,
      reason: "hire withdrawn",
    });
    const cancelled = (await db.execute<{ status: string; cancel_reason: string }>(sql`
      select status, cancel_reason from hrm_processes where id = ${processes[0]!.id}`)).rows[0]!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancel_reason, "hire withdrawn");
  });
});
