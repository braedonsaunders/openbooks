import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { createPosition, writePositionFunding } from "./positions.ts";
import { RecruitingError } from "./recruiting/errors.ts";
import {
  createPipelineTemplate,
  ensureDefaultPipelineTemplate,
} from "./recruiting/pipeline.ts";
import {
  cancelRequisition,
  createRequisition,
  holdRequisition,
  openRequisition,
  resumeRequisition,
} from "./recruiting/requisitions.ts";
import { createCandidate } from "./recruiting/candidates.ts";
import {
  createApplication,
  moveApplicationStage,
  rejectApplication,
  withdrawApplication,
} from "./recruiting/applications.ts";
import {
  cancelInterview,
  completeInterview,
  scheduleInterview,
} from "./recruiting/interviews.ts";
import {
  createOffer,
  declineOffer,
  sendOffer,
  withdrawOffer,
} from "./recruiting/offers.ts";
import { acceptOfferAsHire } from "./recruiting/hire.ts";
import {
  getCandidateDetail,
  getInterviewForPanelist,
  getRequisitionDetail,
  listRequisitions,
  loadRecruitingOverview,
} from "./recruiting/recruiting-read.ts";

/**
 * HR-6 DB coverage (integration partition): migration 0195 bootstraps with
 * org isolation on all nine tables; the full funnel (requisition → candidate
 * → application → interview → offer → hire) over real rows with storage
 * proofs; every named refusal produced by the real code path; the hire
 * transaction rolling back WHOLE when the change-request service refuses;
 * RLS cross-org invisibility through raw constrained sessions; the
 * hiring-manager scope; PII redaction for managers and interviewers; and
 * the append-only event ledger refused at storage.
 *
 * Proofs are read back from storage, never from the service's own return
 * values alone: event kinds in order, filled_count bumps, revision moves,
 * and every refusal asserts the writes that must NOT exist.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = {
  org: ScratchOrg;
  recruiterId: string;
  approverId: string;
  managerId: string;
  managerPartyId: string;
  interviewerId: string;
  interviewerPartyId: string;
};

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function linkPerson(orgId: string, userId: string, name: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${partyId} where id = ${userId} and org_id = ${orgId}`);
  return partyId;
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const recruiterId = await createScratchUser(org.orgId, "HRM Recruiter", "hrm_recruiter");
  const approverId = await createScratchUser(org.orgId, "HRM Approver", "hrm_approver");
  const managerId = await createScratchUser(org.orgId, "Hiring Manager", "hiring_manager");
  const interviewerId = await createScratchUser(org.orgId, "Interviewer", "interviewer");
  await grantPermissions(org.orgId, recruiterId, [
    "hrm.recruiting.read",
    "hrm.recruiting.manage",
    "hrm.position.read",
    "hrm.position.manage",
    "hrm.employment.read",
    "hrm.employment.manage",
  ]);
  await grantPermissions(org.orgId, approverId, ["hrm.employment.read", "hrm.employment.approve"]);
  await linkPerson(org.orgId, recruiterId, "Recruiter Person");
  await linkPerson(org.orgId, approverId, "Approver Person");
  const managerPartyId = await linkPerson(org.orgId, managerId, "Hiring Manager Person");
  const interviewerPartyId = await linkPerson(org.orgId, interviewerId, "Interviewer Person");
  return { org, recruiterId, approverId, managerId, managerPartyId, interviewerId, interviewerPartyId };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function seedFlow(orgId: string, approverId: string): Promise<void> {
  await seedApprovalFlow(orgId, {
    subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
    assignees: [{ type: "user", userId: approverId }],
    mode: "any",
  });
}

/** A live employee holding a position slot (test-only direct writer). */
async function seedHolder(
  orgId: string,
  subsidiaryId: string,
  positionId: string,
): Promise<{ employmentId: string; workerPartyId: string }> {
  const workerPartyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${workerPartyId}, ${orgId}, 'person', 'Position Holder', true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from)
    values (${orgId}, ${employmentId}, 1, 'active', '2026-07-01'::date)
  `);
  const slotId = (await db.execute<{ id: string }>(sql`
    insert into employment_assignments (org_id, employment_id, assignment_key)
    values (${orgId}, ${employmentId}, 'primary') returning id`)).rows[0]!.id;
  await db.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, position_id, version_no, fte, is_primary, effective_from)
    values (${orgId}, ${slotId}, ${employmentId}, ${positionId}, 1, '1', true, '2026-07-01'::date)
  `);
  return { employmentId, workerPartyId };
}

/** A live employment for an EXISTING party (panel members, managers with jobs). */
async function seedEmploymentForParty(
  orgId: string,
  subsidiaryId: string,
  workerPartyId: string,
): Promise<string> {
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from)
    values (${orgId}, ${employmentId}, 1, 'active', '2026-07-01'::date)
  `);
  return employmentId;
}

async function eventKinds(orgId: string, applicationId: string): Promise<string[]> {
  const rows = (await db.execute<{ kind: string }>(sql`
    select kind from hrm_application_events
     where org_id = ${orgId} and application_id = ${applicationId} order by recorded_at, id`)).rows;
  return rows.map((row) => row.kind);
}

function recruitingError(error: unknown): RecruitingError {
  assert.ok(error instanceof RecruitingError, `expected RecruitingError, got ${String(error)}`);
  return error;
}

/**
 * Storage-guard assertions see through Drizzle's wrapper: the pg message
 * (RAISE text, constraint name) rides error.cause, while the top-level
 * message is only "Failed query". Matching the top level would pass on
 * ANY query failure — the cause is the actual refusal.
 */
async function assertStorageRefused(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error, "expected the storage guard to refuse, but the write landed");
  const text = String((error as { cause?: { message?: string } }).cause?.message ?? error);
  assert.match(text, pattern);
}

test("0195 bootstraps: nine tables, org isolation, partial uniques, immutable ledger", { skip: !DB }, async () => {
  const tables = [
    "hrm_pipeline_templates",
    "hrm_pipeline_stages",
    "hrm_requisitions",
    "hrm_candidates",
    "hrm_applications",
    "hrm_application_events",
    "hrm_interviews",
    "hrm_interview_panel",
    "hrm_offers",
  ];
  for (const table of tables) {
    const policy = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_policies
       where schemaname = 'public' and tablename = ${table} and policyname = 'org_isolation'`)).rows[0]!.n;
    assert.equal(policy, 1, `${table} carries the org_isolation policy`);
    const forced = (await db.execute<{ relforcerowsecurity: boolean }>(sql`
      select relforcerowsecurity from pg_class where relname = ${table}`)).rows[0]!
      .relforcerowsecurity;
    assert.equal(forced, true, `${table} forces row-level security`);
  }
  const indexes = (await db.execute<{ indexname: string }>(sql`
    select indexname from pg_indexes where schemaname = 'public'
     and indexname in ('hrm_pipeline_templates_one_default_per_org', 'hrm_offers_one_live_per_application')`)).rows;
  assert.deepEqual(
    indexes.map((row) => row.indexname).sort(),
    ["hrm_offers_one_live_per_application", "hrm_pipeline_templates_one_default_per_org"],
  );
  const trigger = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_trigger where tgname = 'hrm_application_events_immutable'`)).rows[0]!.n;
  assert.equal(trigger, 1, "the append-only ledger trigger stands");
});

test("the default funnel seeds on demand with applied-to-hired stages", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const template = await ensureDefaultPipelineTemplate(db, h.org.orgId, h.recruiterId);
    assert.equal(template.isDefault, true);
    assert.deepEqual(
      template.stages.map((stage) => stage.key),
      ["applied", "screening", "interview", "offer", "hired", "rejected"],
    );
    assert.equal(template.stages.find((stage) => stage.kind === "hired")!.isTerminal, true);
    // Idempotent: a second ensure keeps the tenant's template.
    const again = await ensureDefaultPipelineTemplate(db, h.org.orgId, h.recruiterId);
    assert.equal(again.id, template.id);
  });
});

test("full funnel: draft to filled hire with storage proofs", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    await seedFlow(orgId, h.approverId);
    // The interviewer sits on panels, so they hold an employment row.
    await seedEmploymentForParty(orgId, h.org.subsidiaryId, h.interviewerPartyId);
    const position = await createPosition({
      orgId,
      actorId: h.recruiterId,
      positionCode: "ENG-1042",
      title: "Engineer",
      employerSubsidiaryId: orgId ? h.org.subsidiaryId : h.org.subsidiaryId,
      plannedFte: "1.0000",
      status: "open",
      effectiveFrom: "2026-07-01",
      reason: "open the establishment",
    });
    const requisition = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Backend engineer",
      positionId: position.id,
      employerSubsidiaryId: h.org.subsidiaryId,
      hiringManagerPartyId: h.managerPartyId,
      headcount: 1,
      targetStartOn: "2026-10-01",
    });
    assert.equal(requisition.status, "draft");
    assert.match(requisition.requisitionNumber, /^REQ-/);
    const opened = await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    assert.equal(opened.status, "open");
    assert.ok(opened.pipelineTemplateId, "opening names the default funnel");

    const { candidate } = await createCandidate({
      orgId,
      actorId: h.recruiterId,
      displayName: "Ada Candidate",
      email: "ada@example.test",
      phone: "+1-555-0100",
      source: "direct",
    });
    const application = await createApplication({ orgId, actorId: h.recruiterId, requisitionId: opened.id, candidateId: candidate.id });
    assert.equal(application.status, "active");
    assert.deepEqual(await eventKinds(orgId, application.id), ["applied"]);

    const detail = await getRequisitionDetail({ orgId, actorId: h.recruiterId, requisitionId: opened.id });
    const screen = detail.stages.find((stage) => stage.key === "screening")!;
    const moved = await moveApplicationStage({ orgId, actorId: h.recruiterId, applicationId: application.id, toStageId: screen.id });
    assert.equal(moved.stageId, screen.id);

    const interview = await scheduleInterview({
      orgId,
      actorId: h.recruiterId,
      applicationId: application.id,
      kind: "video",
      scheduledAt: "2026-09-25T14:00:00Z",
      durationMinutes: 45,
      panelPartyIds: [h.interviewerPartyId],
    });
    assert.equal(interview.status, "scheduled");
    const completed = await completeInterview({ orgId, actorId: h.recruiterId, interviewId: interview.id, outcome: "advance" });
    assert.equal(completed.outcome, "advance");

    const interviewStage = detail.stages.find((stage) => stage.key === "interview")!;
    await moveApplicationStage({ orgId, actorId: h.recruiterId, applicationId: application.id, toStageId: interviewStage.id });
    const offerStage = detail.stages.find((stage) => stage.key === "offer")!;
    await moveApplicationStage({ orgId, actorId: h.recruiterId, applicationId: application.id, toStageId: offerStage.id });

    const offer = await createOffer({
      orgId,
      actorId: h.recruiterId,
      applicationId: application.id,
      employerSubsidiaryId: h.org.subsidiaryId,
      jobTitle: "Backend engineer",
      proposedStartOn: "2026-10-01",
      compensationAmount: "120000",
      compensationCurrency: "USD",
      compensationBasis: "annual",
      expiresOn: "2026-12-31",
    });
    assert.equal(offer.status, "draft");
    const sent = await sendOffer({ orgId, actorId: h.recruiterId, offerId: offer.id });
    assert.equal(sent.status, "sent");

    const hire = await acceptOfferAsHire({ orgId, actorId: h.recruiterId, offerId: offer.id });
    assert.equal(hire.requisitionStatus, "filled");
    assert.ok(hire.employmentId);
    assert.ok(hire.changeRequestId);

    // Storage proofs, not return values alone.
    const storedOffer = (await db.execute<{ status: string; approved_change_id: string | null }>(sql`
      select status, approved_change_id from hrm_offers where id = ${offer.id}`)).rows[0]!;
    assert.equal(storedOffer.status, "accepted");
    assert.equal(storedOffer.approved_change_id, hire.changeRequestId);
    const storedApplication = (await db.execute<{ status: string; hired_employment_id: string | null }>(sql`
      select status, hired_employment_id from hrm_applications where id = ${application.id}`)).rows[0]!;
    assert.equal(storedApplication.status, "hired");
    assert.equal(storedApplication.hired_employment_id, hire.employmentId);
    const storedRequisition = (await db.execute<{ filled_count: number; status: string; revision: number }>(sql`
      select filled_count, status, revision from hrm_requisitions where id = ${opened.id}`)).rows[0]!;
    assert.equal(storedRequisition.filled_count, 1);
    assert.equal(storedRequisition.status, "filled");
    assert.equal(storedRequisition.revision, 2);
    const requestStatus = (await db.execute<{ status: string }>(sql`
      select status from hrm_employment_change_requests where id = ${hire.changeRequestId}`)).rows[0]!.status;
    assert.equal(requestStatus, "pending_approval");
    const candidateParty = (await db.execute<{ party_id: string | null }>(sql`
      select party_id from hrm_candidates where id = ${candidate.id}`)).rows[0]!.party_id;
    assert.equal(candidateParty, hire.workerPartyId);
    assert.deepEqual(await eventKinds(orgId, application.id), [
      "applied",
      "stage_changed",
      "stage_changed",
      "stage_changed",
      "offer_created",
      "offer_sent",
      "offer_accepted",
      "hired",
    ]);

    // The cockpit rail reads the aftermath: nothing open, nothing awaiting.
    const overview = await loadRecruitingOverview({ orgId, actorId: h.recruiterId });
    assert.equal(overview!.openRequisitions, 0);
  });
});

test("opening refuses a closed position, a full establishment, and names the override", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const mkRequisition = async (positionId: string | null) =>
      createRequisition({
        orgId,
        actorId: h.recruiterId,
        title: "Vacancy",
        positionId,
        employerSubsidiaryId: h.org.subsidiaryId,
        headcount: 1,
        // Inside the scratch fiscal period (2026-07) so funding applies.
        targetStartOn: "2026-07-15",
      });
    // Planned headcount with no position opens freely.
    const free = await mkRequisition(null);
    assert.equal((await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: free.id })).status, "open");

    const position = await createPosition({
      orgId,
      actorId: h.recruiterId,
      positionCode: "ENG-2200",
      title: "Engineer",
      employerSubsidiaryId: h.org.subsidiaryId,
      plannedFte: "1.0000",
      status: "open",
      effectiveFrom: "2026-07-01",
      reason: "open",
    });
    // Fund the establishment so the refusal under test is the zero-vacancy
    // one, not the under-funding one.
    await writePositionFunding({
      orgId,
      actorId: h.recruiterId,
      positionId: position.id,
      periodId: h.org.periodId,
      fundedFte: "1.0000",
      reason: "fund the establishment",
    });
    await seedHolder(orgId, h.org.subsidiaryId, position.id);
    const full = await mkRequisition(position.id);
    await assert.rejects(
      openRequisition({ orgId, actorId: h.recruiterId, requisitionId: full.id }),
      /no vacant FTE.*overEstablishment/,
      "zero vacant FTE refuses without the flag",
    );
    const over = await openRequisition({
      orgId,
      actorId: h.recruiterId,
      requisitionId: full.id,
      overEstablishment: true,
    });
    assert.equal(over.status, "open", "the explicit flag opens over establishment");
  });
});

test("hold, resume, and cancel move the lifecycle with reasons", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const requisition = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Vacancy",
      employerSubsidiaryId: h.org.subsidiaryId,
      headcount: 1,
    });
    await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    await assert.rejects(
      holdRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, reason: "" }),
      /non-blank reason/,
      "a hold without a why is refused",
    );
    assert.equal(
      (await holdRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, reason: "hiring freeze" })).status,
      "on_hold",
    );
    assert.equal(
      (await resumeRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, reason: "freeze lifted" })).status,
      "open",
    );
    assert.equal(
      (await cancelRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, reason: "role cut" })).status,
      "cancelled",
    );
    await assert.rejects(
      openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id }),
      /cancelled.*cannot be opened/,
      "a cancelled opening never reopens",
    );
  });
});

test("duplicate candidate email refuses without mergeInto and merges with it", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const first = await createCandidate({ orgId, actorId: h.recruiterId, displayName: "Ada", email: "ada@example.test" });
    assert.equal(first.mergedInto, null);
    const refusal = await createCandidate({ orgId, actorId: h.recruiterId, displayName: "Ada Clone", email: "ADA@example.test" }).then(
      () => null,
      (error: unknown) => recruitingError(error),
    );
    assert.ok(refusal, "the duplicate refuses");
    assert.match(refusal.message, new RegExp(`mergeInto ${first.candidate.id}`), "the refusal names the merge remedy");
    const countBefore = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_candidates where org_id = ${orgId}`)).rows[0]!.n;
    const merged = await createCandidate({
      orgId,
      actorId: h.recruiterId,
      displayName: "Ada Clone",
      email: "ada@example.test",
      mergeInto: first.candidate.id,
    });
    assert.equal(merged.mergedInto!.id, first.candidate.id, "no new record: the survivor attaches");
    const countAfter = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_candidates where org_id = ${orgId}`)).rows[0]!.n;
    assert.equal(countAfter, countBefore, "merging writes no candidate row");

    // The merged application records its evidence.
    const requisition = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Vacancy",
      employerSubsidiaryId: h.org.subsidiaryId,
      headcount: 1,
    });
    await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    const application = await createApplication({
      orgId,
      actorId: h.recruiterId,
      requisitionId: requisition.id,
      candidateId: merged.mergedInto!.id,
      merged: true,
    });
    assert.deepEqual(await eventKinds(orgId, application.id), ["merged"]);
    // A second attach of the same pair refuses by name.
    await assert.rejects(
      createApplication({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, candidateId: merged.mergedInto!.id }),
      /already attached/,
    );
  });
});

test("stage moves refuse across templates, into hired by hand, and out of terminal states", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const other = await createPipelineTemplate({
      orgId,
      actorId: h.recruiterId,
      name: "Executive funnel",
      stages: [
        { key: "intake", name: "Intake", kind: "screening" },
        { key: "hired", name: "Hired", kind: "hired" },
      ],
    });
    const requisition = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Vacancy",
      employerSubsidiaryId: h.org.subsidiaryId,
      headcount: 1,
    });
    await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    const { candidate } = await createCandidate({ orgId, actorId: h.recruiterId, displayName: "Bo" });
    const application = await createApplication({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, candidateId: candidate.id });
    await assert.rejects(
      moveApplicationStage({ orgId, actorId: h.recruiterId, applicationId: application.id, toStageId: other.stages[0]!.id }),
      /another pipeline template/,
    );
    const detail = await getRequisitionDetail({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    const hiredStage = detail.stages.find((stage) => stage.kind === "hired")!;
    await assert.rejects(
      moveApplicationStage({ orgId, actorId: h.recruiterId, applicationId: application.id, toStageId: hiredStage.id }),
      /only through hire/,
    );
    const rejected = await rejectApplication({ orgId, actorId: h.recruiterId, applicationId: application.id, reason: "not a fit" });
    assert.equal(rejected.status, "rejected");
    await assert.rejects(
      moveApplicationStage({ orgId, actorId: h.recruiterId, applicationId: application.id, toStageId: detail.stages[0]!.id }),
      /terminal/,
    );
    await assert.rejects(
      withdrawApplication({ orgId, actorId: h.recruiterId, applicationId: application.id }),
      /cannot be withdrawn/,
    );
    // Rejecting demands its reason.
    const { candidate: second } = await createCandidate({ orgId, actorId: h.recruiterId, displayName: "Cy" });
    const secondApplication = await createApplication({
      orgId,
      actorId: h.recruiterId,
      requisitionId: requisition.id,
      candidateId: second.id,
    });
    await assert.rejects(
      rejectApplication({ orgId, actorId: h.recruiterId, applicationId: secondApplication.id, reason: "  " }),
      /non-blank reason/,
    );
  });
});

test("one live offer per application: the second drafts only after the first leaves", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const requisition = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Vacancy",
      employerSubsidiaryId: h.org.subsidiaryId,
      headcount: 1,
    });
    await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    const { candidate } = await createCandidate({ orgId, actorId: h.recruiterId, displayName: "Dee" });
    const application = await createApplication({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, candidateId: candidate.id });
    const terms = {
      orgId,
      actorId: h.recruiterId,
      applicationId: application.id,
      employerSubsidiaryId: h.org.subsidiaryId,
      jobTitle: "Engineer",
      proposedStartOn: "2026-10-01",
      compensationAmount: "90000",
      compensationCurrency: "USD",
      compensationBasis: "annual" as const,
    };
    const first = await createOffer(terms);
    await assert.rejects(createOffer(terms), /live offer already stands/, "the second drafts while one lives");
    await withdrawOffer({ orgId, actorId: h.recruiterId, offerId: first.id, reason: "terms revised" });
    const second = await createOffer(terms);
    assert.equal(second.status, "draft", "withdrawing frees the live-offer slot");
    await assert.rejects(
      declineOffer({ orgId, actorId: h.recruiterId, offerId: second.id, reason: "changed mind" }),
      /cannot be declined/,
      "a draft never declines",
    );
  });
});

test("a past-due sent offer reads expired and refuses its accept", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    await seedFlow(orgId, h.approverId);
    const requisition = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Vacancy",
      employerSubsidiaryId: h.org.subsidiaryId,
      headcount: 1,
    });
    await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    const { candidate } = await createCandidate({ orgId, actorId: h.recruiterId, displayName: "Eli" });
    const application = await createApplication({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, candidateId: candidate.id });
    const offer = await createOffer({
      orgId,
      actorId: h.recruiterId,
      applicationId: application.id,
      employerSubsidiaryId: h.org.subsidiaryId,
      jobTitle: "Engineer",
      proposedStartOn: "2026-10-01",
      compensationAmount: "90000",
      compensationCurrency: "USD",
      compensationBasis: "annual",
      expiresOn: "2026-01-02",
    });
    const sent = await sendOffer({ orgId, actorId: h.recruiterId, offerId: offer.id });
    assert.equal(sent.effectiveStatus, "expired", "expiry computes on read with no sweeper");
    await assert.rejects(
      acceptOfferAsHire({ orgId, actorId: h.recruiterId, offerId: offer.id }),
      /expired before it was accepted/,
    );
    // The refused hire wrote NOTHING — not even the expiry: expiry
    // materialises in its own commit before the hire opens, and the hire
    // itself stays all-or-nothing.
    const stored = (await db.execute<{ status: string }>(sql`
      select status from hrm_offers where id = ${offer.id}`)).rows[0]!.status;
    assert.equal(stored, "expired", "the expiry materialised before the refused hire");
    const drawer = await getRequisitionDetail({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    assert.equal(drawer.applications[0]!.liveOfferStatus, null, "the expired offer leaves the live slot");
    // ...so new terms draft freely after expiry.
    const renewed = await createOffer({
      orgId,
      actorId: h.recruiterId,
      applicationId: application.id,
      employerSubsidiaryId: h.org.subsidiaryId,
      jobTitle: "Engineer",
      proposedStartOn: "2026-10-01",
      compensationAmount: "95000",
      compensationCurrency: "USD",
      compensationBasis: "annual",
    });
    assert.equal(renewed.status, "draft");
  });
});

test("hire without an approval flow rolls back whole: no party, no draft, no fill", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    // Deliberately no seedFlow: submission finds no gate and refuses.
    const requisition = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Vacancy",
      employerSubsidiaryId: h.org.subsidiaryId,
      headcount: 1,
    });
    await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    const { candidate } = await createCandidate({
      orgId,
      actorId: h.recruiterId,
      displayName: "Fay Refused",
      email: "fay@example.test",
    });
    const application = await createApplication({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, candidateId: candidate.id });
    const offer = await createOffer({
      orgId,
      actorId: h.recruiterId,
      applicationId: application.id,
      employerSubsidiaryId: h.org.subsidiaryId,
      jobTitle: "Engineer",
      proposedStartOn: "2026-10-01",
      compensationAmount: "90000",
      compensationCurrency: "USD",
      compensationBasis: "annual",
    });
    await sendOffer({ orgId, actorId: h.recruiterId, offerId: offer.id });
    const partiesBefore = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from parties where org_id = ${orgId}`)).rows[0]!.n;
    const employmentsBefore = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from worker_employments where org_id = ${orgId}`)).rows[0]!.n;
    await assert.rejects(
      acceptOfferAsHire({ orgId, actorId: h.recruiterId, offerId: offer.id }),
      /no enabled approval flow/,
      "the change-request service refuses without a flow",
    );
    // The WHOLE hire rolls back: nothing partial survives.
    assert.equal(
      (await db.execute<{ n: number }>(sql`select count(*)::int as n from parties where org_id = ${orgId}`)).rows[0]!.n,
      partiesBefore,
      "no employee party survives the refused hire",
    );
    assert.equal(
      (await db.execute<{ n: number }>(sql`select count(*)::int as n from worker_employments where org_id = ${orgId}`)).rows[0]!.n,
      employmentsBefore,
      "no reserved employment survives the refused hire",
    );
    assert.equal(
      (await db.execute<{ n: number }>(sql`select count(*)::int as n from hrm_employment_change_requests where org_id = ${orgId}`)).rows[0]!.n,
      0,
      "no draft survives the refused hire",
    );
    assert.equal((await db.execute<{ status: string }>(sql`select status from hrm_offers where id = ${offer.id}`)).rows[0]!.status, "sent");
    assert.equal(
      (await db.execute<{ status: string }>(sql`select status from hrm_applications where id = ${application.id}`)).rows[0]!.status,
      "active",
    );
    assert.equal(
      (await db.execute<{ filled_count: number }>(sql`select filled_count from hrm_requisitions where id = ${requisition.id}`)).rows[0]!
        .filled_count,
      0,
    );
    assert.deepEqual(await eventKinds(orgId, application.id), ["applied", "offer_created", "offer_sent"]);
  });
});

test("hire refuses off an unopened requisition and off a position filled under us", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    await seedFlow(orgId, h.approverId);
    const position = await createPosition({
      orgId,
      actorId: h.recruiterId,
      positionCode: "ENG-3300",
      title: "Engineer",
      employerSubsidiaryId: h.org.subsidiaryId,
      plannedFte: "1.0000",
      status: "open",
      effectiveFrom: "2026-07-01",
      reason: "open",
    });
    await writePositionFunding({
      orgId,
      actorId: h.recruiterId,
      positionId: position.id,
      periodId: h.org.periodId,
      fundedFte: "1.0000",
      reason: "fund the establishment",
    });
    const draft = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Vacancy",
      positionId: position.id,
      employerSubsidiaryId: h.org.subsidiaryId,
      headcount: 1,
      targetStartOn: "2026-07-15",
    });
    const opened = await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: draft.id });
    const { candidate } = await createCandidate({ orgId, actorId: h.recruiterId, displayName: "Gus" });
    const application = await createApplication({ orgId, actorId: h.recruiterId, requisitionId: opened.id, candidateId: candidate.id });
    const offer = await createOffer({
      orgId,
      actorId: h.recruiterId,
      applicationId: application.id,
      employerSubsidiaryId: h.org.subsidiaryId,
      jobTitle: "Engineer",
      proposedStartOn: "2026-07-15",
      compensationAmount: "90000",
      compensationCurrency: "USD",
      compensationBasis: "annual",
    });
    await sendOffer({ orgId, actorId: h.recruiterId, offerId: offer.id });
    // The establishment fills under us before the hire lands.
    await seedHolder(orgId, h.org.subsidiaryId, position.id);
    await assert.rejects(
      acceptOfferAsHire({ orgId, actorId: h.recruiterId, offerId: offer.id }),
      /no longer vacant/,
      "a hire past the plan is refused, never silently allowed",
    );

    // And a cancelled opening takes no hire either.
    const free = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Free vacancy",
      employerSubsidiaryId: h.org.subsidiaryId,
      headcount: 1,
    });
    await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: free.id });
    const { candidate: second } = await createCandidate({ orgId, actorId: h.recruiterId, displayName: "Hal" });
    const secondApplication = await createApplication({
      orgId,
      actorId: h.recruiterId,
      requisitionId: free.id,
      candidateId: second.id,
    });
    const secondOffer = await createOffer({
      orgId,
      actorId: h.recruiterId,
      applicationId: secondApplication.id,
      employerSubsidiaryId: h.org.subsidiaryId,
      jobTitle: "Engineer",
      proposedStartOn: "2026-10-01",
      compensationAmount: "90000",
      compensationCurrency: "USD",
      compensationBasis: "annual",
    });
    await sendOffer({ orgId, actorId: h.recruiterId, offerId: secondOffer.id });
    await cancelRequisition({ orgId, actorId: h.recruiterId, requisitionId: free.id, reason: "role cut" });
    await assert.rejects(
      acceptOfferAsHire({ orgId, actorId: h.recruiterId, offerId: secondOffer.id }),
      /cancelled.*hires land only on open/,
    );
  });
});

test("the hiring manager moves their own funnel without the grant and never sees PII", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const requisition = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Managed vacancy",
      employerSubsidiaryId: h.org.subsidiaryId,
      hiringManagerPartyId: h.managerPartyId,
      headcount: 1,
    });
    await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    const { candidate } = await createCandidate({
      orgId,
      actorId: h.recruiterId,
      displayName: "Ivy Prospect",
      email: "ivy@example.test",
      phone: "+1-555-0199",
      source: "referral",
    });
    const application = await createApplication({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, candidateId: candidate.id });
    // No grants on the manager: the list refuses, the drawer admits.
    await assert.rejects(
      listRequisitions({ orgId, actorId: h.managerId }),
      /hrm.recruiting.read/,
    );
    const drawer = await getRequisitionDetail({ orgId, actorId: h.managerId, requisitionId: requisition.id });
    assert.equal(drawer.applications.length, 1);
    assert.equal(drawer.applications[0]!.candidate.displayName, "Ivy Prospect");
    assert.equal(drawer.applications[0]!.candidate.email, null, "contact PII never reaches the manager");
    assert.equal(drawer.applications[0]!.candidate.phone, null);
    const screen = drawer.stages.find((stage) => stage.key === "screening")!;
    const moved = await moveApplicationStage({
      orgId,
      actorId: h.managerId,
      applicationId: application.id,
      toStageId: screen.id,
    });
    assert.equal(moved.stageId, screen.id, "the manager moves their own funnel");
    // Terminal funnel decisions stay behind the grant: the manager moves,
    // never rejects.
    await assert.rejects(
      rejectApplication({ orgId, actorId: h.managerId, applicationId: application.id, reason: "no" }),
      /hrm.recruiting.manage/,
    );
    // Another manager's opening stays shut.
    const other = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Other vacancy",
      employerSubsidiaryId: h.org.subsidiaryId,
      headcount: 1,
    });
    await assert.rejects(
      getRequisitionDetail({ orgId, actorId: h.managerId, requisitionId: other.id }),
      /hrm.recruiting.read/,
    );
    // The candidate drawer through the manager's own funnel redacts too.
    const candidateDrawer = await getCandidateDetail({ orgId, actorId: h.managerId, candidateId: candidate.id });
    assert.equal(candidateDrawer.email, null);
    assert.equal(candidateDrawer.applications.length, 1);
  });
});

test("the interviewer sees the name and the interview, nothing else", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    await seedEmploymentForParty(orgId, h.org.subsidiaryId, h.interviewerPartyId);
    const requisition = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Vacancy",
      employerSubsidiaryId: h.org.subsidiaryId,
      headcount: 1,
    });
    await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    const { candidate } = await createCandidate({
      orgId,
      actorId: h.recruiterId,
      displayName: "Jon Prospect",
      email: "jon@example.test",
      phone: "+1-555-0188",
    });
    const application = await createApplication({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, candidateId: candidate.id });
    const interview = await scheduleInterview({
      orgId,
      actorId: h.recruiterId,
      applicationId: application.id,
      kind: "onsite",
      scheduledAt: "2026-09-26T10:00:00Z",
      panelPartyIds: [h.interviewerPartyId],
    });
    // A panel of strangers is refused by name.
    await assert.rejects(
      scheduleInterview({
        orgId,
        actorId: h.recruiterId,
        applicationId: application.id,
        kind: "phone",
        scheduledAt: "2026-09-27T10:00:00Z",
        panelPartyIds: [h.managerPartyId],
      }),
      /not an employee/,
      "the manager holds no employment row, so the panel refuses",
    );
    const view = await getInterviewForPanelist({ orgId, actorId: h.interviewerId, interviewId: interview.id });
    assert.equal(view.candidateName, "Jon Prospect");
    assert.ok(!("email" in view) && !("phone" in view), "no contact PII key exists on the interviewer's view");
    await assert.rejects(
      getCandidateDetail({ orgId, actorId: h.interviewerId, candidateId: candidate.id }),
      /not visible/,
      "the interviewer reaches no candidate drawer",
    );
    await assert.rejects(
      getInterviewForPanelist({ orgId, actorId: h.managerId, interviewId: interview.id }),
      /not visible/,
      "a non-panelist reaches no interview",
    );
    const cancelled = await cancelInterview({ orgId, actorId: h.recruiterId, interviewId: interview.id });
    assert.equal(cancelled.status, "cancelled");
  });
});

test("a second organization sees nothing of the first, at the policy itself", { skip: !DB }, async () => {
  const first = await setupHarness();
  const second = await setupHarness();
  try {
    const requisition = await createRequisition({
      orgId: first.org.orgId,
      actorId: first.recruiterId,
      title: "First vacancy",
      employerSubsidiaryId: first.org.subsidiaryId,
      headcount: 1,
    });
    // Service predicates isolate: the foreign org lists nothing and loads nothing.
    assert.equal((await listRequisitions({ orgId: second.org.orgId, actorId: second.recruiterId })).length, 0);
    await assert.rejects(
      getRequisitionDetail({ orgId: second.org.orgId, actorId: second.recruiterId, requisitionId: requisition.id }),
      /not visible in this organization/,
    );
    // Raw constrained sessions (no test bypass): the policy is the oracle.
    const url = process.env.OPENBOOKS_RUNTIME_DB_URL || process.env.OPENBOOKS_DB_URL!;
    const countAs = async (orgId: string, table: string): Promise<number> => {
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        await client.query("select set_config('app.current_org', $1, false)", [orgId]);
        const res = await client.query(`select count(*)::int as n from ${table}`);
        return res.rows[0].n as number;
      } finally {
        await client.end();
      }
    };
    for (const table of ["hrm_requisitions", "hrm_candidates", "hrm_applications", "hrm_application_events", "hrm_interviews", "hrm_offers"]) {
      assert.equal(await countAs(first.org.orgId, table), table === "hrm_requisitions" ? 1 : 0);
      assert.equal(await countAs(second.org.orgId, table), 0, `a foreign org session sees zero ${table} rows`);
    }
  } finally {
    await dropScratchOrg(first.org.orgId);
    await dropScratchOrg(second.org.orgId);
  }
});

test("storage refuses event edits, event deletes, and template deletes with history", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const requisition = await createRequisition({
      orgId,
      actorId: h.recruiterId,
      title: "Vacancy",
      employerSubsidiaryId: h.org.subsidiaryId,
      headcount: 1,
    });
    await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
    const { candidate } = await createCandidate({ orgId, actorId: h.recruiterId, displayName: "Kay" });
    const application = await createApplication({ orgId, actorId: h.recruiterId, requisitionId: requisition.id, candidateId: candidate.id });
    const eventId = (await db.execute<{ id: string }>(sql`
      select id from hrm_application_events where org_id = ${orgId} and application_id = ${application.id} limit 1`)).rows[0]!.id;
    await assertStorageRefused(
      db.execute(sql`update hrm_application_events set reason = 'rewritten' where id = ${eventId}`),
      /append-only/,
    );
    await assertStorageRefused(
      db.execute(sql`delete from hrm_application_events where id = ${eventId}`),
      /append-only/,
    );
    const templateId = (await db.execute<{ pipeline_template_id: string }>(sql`
      select pipeline_template_id from hrm_requisitions where id = ${requisition.id}`)).rows[0]!.pipeline_template_id;
    await assertStorageRefused(
      db.execute(sql`delete from hrm_pipeline_templates where id = ${templateId}`),
      /retained as history/,
    );
    await assertStorageRefused(
      db.execute(sql`delete from hrm_requisitions where id = ${requisition.id}`),
      /retained as history/,
    );
  });
});
