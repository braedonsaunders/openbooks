import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db, withOrg, withOrgTransaction } from "../platform/db.ts";
import { countRows, NOT_VISIBLE, refusal, refusesLikeUnknown, scopeMatrix, scopeRow, type ScopeWorld } from "../testing/hrm-scope-matrix.ts";
import {
  enableConstruction, refusalMatches, refusalOf, refusesCode, seedComponent, seedEmployment, seedNamedWorker,
  seedPerson, seedPlan, seedWindow, setFeatures, type Refusal,
} from "../testing/hrm-harness.ts";
import { UnrestrictedScopeError } from "../organization/subsidiary-scope.ts";
import { listLeaveFilingEmploymentOptions } from "./leave-read.ts";
import { employmentsOnLeave } from "./attendance.ts";
import {
  createProcessTemplate, deleteProcessTemplate, deleteProcessTemplateStep, reorderProcessTemplateSteps,
  updateProcessTemplate, upsertProcessTemplateStep,
} from "./processes.ts";
import { electEnrollment } from "./benefits/enrollments.ts";
import { generateBenefitPayrollInputs, voidBenefitPayrollInput } from "./benefits/benefits-payroll.ts";
import { listEnrollmentWindows, listEnrollmentPlanOptions, listBenefitPlans } from "./benefits/benefits-read.ts";
import { closeEnrollmentWindow, createEnrollmentWindow, getEnrollmentWindow, openEnrollmentWindow } from "./benefits/windows.ts";
import { HrmConstructionError } from "./construction/errors.ts";
import {
  acknowledgeFinding, addScheduleLine, amendRun, approveEntry, assignClassification, checkDay, classify, computeForWeek,
  createClassification, createCompClass, createCompRule, createPolicy, createRatioRule, createSchedule, dailySplit,
  downloadRun, listEntries, listFindings, listRuns, listSchedules, projectComplianceSummary, recordFinding,
  resolveFinding, resolveWage, submitRun, updateScheduleScope, voidEntry,
} from "./construction/index.ts";
import type { AppliesTo } from "./construction/pure.ts";
import { HrmSurveysError } from "./documents/errors.ts";
import { closeSurvey, getSurvey, listSurveys, openSurvey, saveSurvey } from "./surveys/surveys.ts";
import { getSurveyResults, submitResponse } from "./surveys/responses.ts";
import { createBatch, setBatchLines, submitBatch, withdrawBatch } from "./field-time/crew.ts";
import { getBatchDetail, listCrewBatches, type CrewBatchActor } from "./field-time/reads.ts";
import { HrmQualificationError } from "./qualifications/errors.ts";
import {
  listQualificationEvents, listQualifications, loadQualification, recordQualification, revokeQualification,
  verifyQualification,
} from "./qualifications/qualifications.ts";
import { createQualificationType, declareCategory } from "./qualifications/types.ts";
import { listRequirements, removeRequirement, setRequirement } from "./qualifications/requirements.ts";
import { checkAssignment } from "./qualifications/gating.ts";
import { listAlerts } from "./qualifications/alerts.ts";

/**
 * HRM under a legal-entity lens, across leave, attendance, processes,
 * benefits, construction compliance, surveys, crew time and qualifications.
 * An actor restricted to entity A never reads B's rows or aggregates and
 * never changes them: out-of-scope targets refuse with the not-found answer
 * an unknown id gets, org-wide configuration needs unrestricted scope, and
 * where a surface has an in-lens form the same work still succeeds.
 */

const UNRESTRICTED = /requires unrestricted subsidiary access/;
const MISSING = /does not exist in this organization/;
const QUAL_NOT_FOUND = /not found in this organization/;

type Probe = readonly [label: string, run: () => Promise<unknown>];

/** Every probe refuses with the expected class and wording; a red names the probe. */
async function refuseAll<E extends abstract new (...args: never[]) => Error>(
  probes: readonly Probe[], expected: E, message: RegExp,
): Promise<void> {
  for (const [label, run] of probes) {
    await refusal(run(), expected, message).catch((error: Error) => { throw new Error(`${label}: ${error.message}`); });
  }
}

/** Hold a row lock in another transaction, optionally running a statement before it commits. */
function holdLock(orgId: string, lock: SQL, beforeCommit?: SQL) {
  let release!: () => void;
  let signal!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const locked = new Promise<void>((resolve) => { signal = resolve; });
  const done = withOrgTransaction(orgId, async () => {
    await db.execute(lock);
    signal();
    await released;
    if (beforeCommit) await db.execute(beforeCommit);
  });
  return { locked, release: async () => { release(); await done; } };
}

/** True when the call is still waiting after a grace period. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  return !settled;
}

// --- processes and benefits --------------------------------------------------

const STEP = { position: 0, title: "Collect documents", ownerKind: "hr" as const };
const BENEFITS = ["hrm.benefits.read", "hrm.benefits.manage"];
/** The benefits writers hold manage only, as a benefits administrator's role does. */
const BENEFITS_WRITER = { admin: { scope: "all" }, scoped: { scope: "A", permissions: ["hrm.benefits.manage"] } } as const;
const WINDOW = { kind: "open_enrollment", opensOn: "2026-01-01", closesOn: "2026-12-31", planYearStartOn: "2026-01-01" };

function enrollmentWindow(orgId: string, actorId: string, employerSubsidiaryId: string | null, name: string, departmentId?: string) {
  return createEnrollmentWindow({ orgId, actorId, name, ...WINDOW, employerSubsidiaryId, departmentId });
}

// --- construction ------------------------------------------------------------

const CONSTRUCTION = {
  features: ["hrmConstructionCompliance"],
  permissions: ["hrm.construction.read", "hrm.construction.manage"],
};
const FROZEN = JSON.stringify({ rendered: { filename: "cert.txt", contentType: "text/plain", body: "frozen" } });

async function entityProject(orgId: string, subsidiaryId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, name, status, subsidiary_id) values (${id}, ${orgId}, ${name}, 'active', ${subsidiaryId})`);
  return id;
}

/** A and B jobs with one active worker each, on the US-homed construction feature set. */
async function jobsite(w: { orgId: string; subA: string; subB: string }) {
  await enableConstruction(w.orgId);
  return {
    projectA: await entityProject(w.orgId, w.subA, "A Job"),
    projectB: await entityProject(w.orgId, w.subB, "B Job"),
    workerA: await seedNamedWorker(w.orgId, w.subA, "A Worker"),
    workerB: await seedNamedWorker(w.orgId, w.subB, "B Worker"),
  };
}

/**
 * A B id refuses exactly like a fabricated one. The message names the
 * probed id, so both ids are blanked before the refusals are compared.
 */
async function refusesLikeMissing(probe: (id: string) => Promise<unknown>, hiddenId: string, message: RegExp): Promise<void> {
  const missingId = randomUUID();
  const blank = (seen: Refusal): Refusal => ({ ...seen, message: seen.message.replaceAll(hiddenId, "<id>").replaceAll(missingId, "<id>") });
  const seen = await refusalOf(probe(hiddenId), HrmConstructionError);
  assert.match(seen.message, message);
  assert.deepEqual(blank(seen), blank(await refusalOf(probe(missingId))), "out-of-scope refuses exactly like missing");
}

// --- surveys -------------------------------------------------------------------

const SURVEYS = { features: ["hrmSurveys"], permissions: ["hrm.surveys.manage"] };
const QUESTIONS = [
  { kind: "scale", prompt: "I grow here", options: [], driverKey: "growth" },
  { kind: "enps", prompt: "Recommend us", options: [] },
  { kind: "text", prompt: "Say more", options: [] },
];
const SURVEY_KIND = { named: "engagement", anonymous: "pulse", confidential: "custom" } as const;
type Answer = { scale: number; enps: number; text: string };

/** Save and open a survey as the admin, then submit each invitee's answers through their own token. */
async function answeredSurvey(
  w: { orgId: string; admin: string }, anonymity: keyof typeof SURVEY_KIND, invitees: ReadonlyArray<readonly [string, Answer]>,
): Promise<string> {
  const { id: surveyId } = await saveSurvey({
    orgId: w.orgId, actorId: w.admin, name: `Survey ${randomUUID().slice(0, 8)}`, kind: SURVEY_KIND[anonymity],
    anonymity, minGroupSize: 2, questions: QUESTIONS,
  });
  const opened = await openSurvey({ orgId: w.orgId, actorId: w.admin, surveyId, partyIds: invitees.map(([partyId]) => partyId) });
  assert.equal(opened.deliveries.length, invitees.length);
  const { questions } = await getSurvey({ orgId: w.orgId, actorId: w.admin, surveyId });
  const questionId = (kind: string) => questions.find((q) => q.kind === kind)!.id;
  for (const [partyId, answer] of invitees) {
    await submitResponse({
      token: opened.deliveries.find((d) => d.partyId === partyId)!.token,
      today: "2026-09-21",
      answers: [
        { questionId: questionId("scale"), value: answer.scale },
        { questionId: questionId("enps"), value: answer.enps },
        { questionId: questionId("text"), value: answer.text },
      ],
    });
  }
  return surveyId;
}

async function respondents(w: { orgId: string; subA: string; subB: string }) {
  return {
    a1: (await seedPerson(w.orgId, w.subA, "Respondent A1")).partyId,
    a2: (await seedPerson(w.orgId, w.subA, "Respondent A2")).partyId,
    b1: (await seedPerson(w.orgId, w.subB, "Respondent B1")).partyId,
  };
}

// --- crew time -----------------------------------------------------------------

const CREW = {
  features: ["projects", "timeTracking", "fieldTime"],
  subB: { currency: "USD", country: "US" },
  actors: { foremanA: { scope: "A", link: "Foreman A" }, foremanB: { scope: "B", link: "Foreman B" } },
} as const;
const FIELD_TIME = {
  roundingIncrement: 15, roundingMode: "nearest", unpaidBreakMinutes: 30, autoCloseHours: 16,
  signatureRequired: false, equipmentToleranceHours: "1.0000", photoRequired: false,
};

/**
 * Each foreman is assigned to their own entity's job, plus an A crew hand.
 * Worker parties carry their legal entity: line-employee scope fails a
 * shared party closed for restricted callers.
 */
async function crewSite(w: ScopeWorld<"foremanA" | "foremanB">) {
  const orgId = w.orgId;
  const [foremanA, foremanB, worker, projectA, projectB] = [w.party.foremanA, w.party.foremanB, randomUUID(), randomUUID(), randomUUID()];
  await setFeatures(orgId, { equipment: false });
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{fieldTime}', ${JSON.stringify(FIELD_TIME)}::jsonb) where id = ${orgId}`);
  for (const [partyId, subsidiaryId] of [[foremanA, w.subA], [foremanB, w.subB]]) {
    await db.execute(sql`update parties set subsidiary_id = ${subsidiaryId} where org_id = ${orgId} and id = ${partyId}`);
  }
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id) values (${worker}, ${orgId}, 'person', 'Crew Hand', ${w.subA})`);
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom)
    values (${projectA}, ${orgId}, ${w.subA}, 'JOB-A', 'Entity A job', 'active', true, '{}'::jsonb),
           (${projectB}, ${orgId}, ${w.subB}, 'JOB-B', 'Entity B job', 'active', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into schedule_resources (org_id, project_id, name, kind, party_id)
    values (${orgId}, ${projectA}, 'Foreman', 'crew', ${foremanA}), (${orgId}, ${projectB}, 'Foreman', 'crew', ${foremanB})`);
  await seedEmployment(orgId, w.subA, { workerPartyId: worker });
  await seedEmployment(orgId, w.subB, { workerPartyId: foremanB });
  return { foremanA, foremanB, worker, projectA, projectB };
}

// --- qualifications ------------------------------------------------------------

const CERTIFICATIONS = { features: ["hrmCertifications"], permissions: ["hrm.certifications.read", "hrm.certifications.manage"] };

/** One qualification on an A employment and two on a B employment, recorded by the admin. */
async function credentials(w: ScopeWorld<"admin" | "scoped">) {
  const empA = (await seedEmployment(w.orgId, w.subA, { withVersion: false })).employmentId;
  const empB = (await seedEmployment(w.orgId, w.subB, { withVersion: false })).employmentId;
  await declareCategory(db, { orgId: w.orgId, actorId: w.admin, category: "scope-ticket" });
  const { id: typeId } = await createQualificationType(db, {
    orgId: w.orgId, actorId: w.admin, code: `ScopeTicket-${randomUUID().slice(0, 8)}`, name: "Scope ticket", category: "scope-ticket",
  });
  const record = (employmentId: string, issuedOn: string) =>
    recordQualification(db, { orgId: w.orgId, actorId: w.admin, employmentId, typeId, issuedOn });
  return { empA, empB, typeId, qualA: await record(empA, "2026-01-05"), qualB1: await record(empB, "2026-01-06"), qualB2: await record(empB, "2026-01-07") };
}

scopeMatrix([
  scopeRow({
    name: "out-of-scope employments cannot displace the fileable in-scope leave picker option",
    permissions: ["hrm.leave.manage"],
    subB: { currency: "USD", country: "US" },
    seed: async (w) => {
      // They sort first, so a scope filter applied after the page limit would leave an empty page.
      for (let i = 0; i < 25; i++) {
        await seedEmployment(w.orgId, w.subB, { displayName: `Aardvark ${String(i).padStart(2, "0")}`, withVersion: false });
      }
      return (await seedEmployment(w.orgId, w.subA, { displayName: "Zed Zebulon", withVersion: false })).employmentId;
    },
    read: async (w, inScope) => {
      const options = await listLeaveFilingEmploymentOptions({ orgId: w.orgId, actorId: w.scoped });
      assert.ok(options.some((option) => option.employmentId === inScope), "the in-scope employment survives the page");
      for (const option of options) assert.match(option.label, /Zed Zebulon/, "no out-of-scope row leaks into the page");
    },
  }),
  scopeRow({
    name: "on-leave names and counts stay inside the reader's allowed employers",
    read: async (w) => {
      const today = "2026-03-04";
      const typeId = (await db.execute<{ id: string }>(sql`
        insert into hrm_leave_types (org_id, code, name) values (${w.orgId}, 'VAC', 'Vacation') returning id`)).rows[0]!.id;
      for (const [displayName, subsidiaryId] of [["Worker A", w.subA], ["Worker B", w.subB]] as const) {
        const { employmentId } = await seedEmployment(w.orgId, subsidiaryId, { displayName, withVersion: false });
        await db.execute(sql`
          insert into hrm_absences (org_id, employment_id, on_date, hours, leave_type_id, source)
          values (${w.orgId}, ${employmentId}, ${today}::date, 8, ${typeId}, 'recorded')`);
      }
      const names = async (scope: Set<string> | null) =>
        (await employmentsOnLeave(db, w.orgId, today, scope)).map((row) => row.workerName).sort();
      assert.deepEqual(await names(null), ["Worker A", "Worker B"], "an unrestricted reader sees the whole org");
      assert.deepEqual(await names(new Set([w.subA])), ["Worker A"]);
      assert.deepEqual(await names(new Set([w.subB])), ["Worker B"]);
      assert.deepEqual(await names(new Set()), [], "an empty scope reads empty, never all");
    },
  }),
  scopeRow({
    name: "process-template writes need the targeted entity's scope and org-wide templates need unrestricted scope",
    permissions: ["hrm.process.manage"],
    write: async (w) => {
      const orgId = w.orgId;
      const [departmentB, sharedDepartment] = [randomUUID(), randomUUID()];
      await db.execute(sql`
        insert into departments (id, org_id, name, subsidiary_id)
        values (${departmentB}, ${orgId}, 'B department', ${w.subB}), (${sharedDepartment}, ${orgId}, 'Shared department', null)`);
      const create = (actorId: string, employerSubsidiaryId: string | null, name: string, departmentId: string | null = null, kind = "onboarding") =>
        createProcessTemplate({ orgId, actorId, kind, name, appliesTo: { employerSubsidiaryId, departmentId } });

      const foreign = await refusesLikeUnknown(() => create(w.scoped, w.subB, "B onboarding"), () => create(w.scoped, randomUUID(), "Fabricated"));
      assert.equal(foreign.code, "NOT_FOUND");
      // A visible employer cannot pair with a B-owned department. A shared
      // department is valid: the employer target supplies the entity boundary.
      assert.equal((await refusalOf(create(w.scoped, w.subA, "A with B department", departmentB))).code, "NOT_FOUND");
      const inconsistent = await refusalOf(create(w.admin, w.subA, "A employer with B department", departmentB));
      assert.equal(inconsistent.code, "REFUSED");
      assert.match(inconsistent.message, /different subsidiary than the employer target/);
      assert.ok((await create(w.scoped, w.subA, "A with shared department", sharedDepartment)).id);
      // An org-wide template executes for every entity.
      await refusal(create(w.scoped, null, "Org onboarding"), UnrestrictedScopeError, UNRESTRICTED);
      const templateA = await create(w.scoped, w.subA, "A onboarding");
      const templateB = await create(w.admin, w.subB, "B offboarding", null, "offboarding");
      const templateOrg = await create(w.admin, null, "Org transfer", null, "transfer");

      const mutations = (stepId: string): ReadonlyArray<readonly [string, (templateId: string) => Promise<unknown>]> => [
        ["update", (templateId) => updateProcessTemplate({ orgId, actorId: w.scoped, templateId, name: "Changed" })],
        ["step upsert", (templateId) => upsertProcessTemplateStep({ orgId, actorId: w.scoped, templateId, ...STEP })],
        ["step reorder", (templateId) => reorderProcessTemplateSteps({ orgId, actorId: w.scoped, templateId, orderedStepIds: [stepId] })],
        ["step delete", (templateId) => deleteProcessTemplateStep({ orgId, actorId: w.scoped, templateId, stepId })],
        ["delete", (templateId) => deleteProcessTemplate({ orgId, actorId: w.scoped, templateId })],
      ];
      // A stored row pairing A's employer with B's department: every
      // mutation revalidates both parts of the locked target.
      const [legacyId, legacyStepId] = [randomUUID(), randomUUID()];
      await db.execute(sql`
        insert into hrm_process_templates (id, org_id, kind, name, applies_to, created_by, updated_by)
        values (${legacyId}, ${orgId}, 'onboarding', 'Legacy A with B department',
          ${JSON.stringify({ employer_subsidiary_id: w.subA, department_id: departmentB })}::jsonb, ${w.admin}, ${w.admin})`);
      await db.execute(sql`
        insert into hrm_process_template_steps (id, org_id, template_id, position, title, owner_kind, created_by, updated_by)
        values (${legacyStepId}, ${orgId}, ${legacyId}, 0, 'Legacy step', 'hr', ${w.admin}, ${w.admin})`);
      for (const [label, run] of mutations(legacyStepId)) {
        assert.equal((await refusalOf(run(legacyId))).code, "NOT_FOUND", `legacy ${label}`);
      }

      await refusal(updateProcessTemplate({ orgId, actorId: w.scoped, templateId: templateOrg.id, name: "Renamed" }), UnrestrictedScopeError, UNRESTRICTED);
      assert.equal((await updateProcessTemplate({ orgId, actorId: w.scoped, templateId: templateA.id, name: "A renamed" })).name, "A renamed");
      const retarget = await refusalOf(updateProcessTemplate({
        orgId, actorId: w.scoped, templateId: templateA.id, appliesTo: { employerSubsidiaryId: w.subB, departmentId: null },
      }));
      assert.equal(retarget.code, "NOT_FOUND", "retargeting A's template onto B refuses like a foreign subsidiary");
      assert.match(retarget.message, NOT_VISIBLE);
      const step = await upsertProcessTemplateStep({ orgId, actorId: w.scoped, templateId: templateA.id, ...STEP });
      // B's template refuses every mutation exactly like a missing template.
      for (const [label, run] of mutations(step.id)) {
        const seen = await refusesLikeUnknown(() => run(templateB.id), () => run(randomUUID()));
        assert.deepEqual([seen.name, seen.code], ["HrmProcessError", "NOT_FOUND"], label);
      }
      await deleteProcessTemplateStep({ orgId, actorId: w.scoped, templateId: templateA.id, stepId: step.id });
    },
  }),
  scopeRow({
    name: "benefit payroll inputs generate and void only inside the actor's lens",
    permissions: BENEFITS,
    actors: BENEFITS_WRITER,
    seed: async (w) => {
      const empA = (await seedEmployment(w.orgId, w.subA, { displayName: "Benefits Worker" })).employmentId;
      const empB = (await seedEmployment(w.orgId, w.subB, { displayName: "Benefits Worker" })).employmentId;
      const { planId } = await seedPlan(w.orgId);
      const windowId = await seedWindow(w.orgId);
      const elect = (employmentId: string) =>
        electEnrollment({ orgId: w.orgId, actorId: w.admin, employmentId, planId, windowId, effectiveFrom: "2026-01-01" });
      return { empA, empB, electA: await elect(empA), electB: await elect(empB) };
    },
    write: async (w, { empA, empB, electA, electB }) => {
      const generate = (actorId: string, coverageMonth: string) => generateBenefitPayrollInputs({ orgId: w.orgId, actorId, coverageMonth });
      const stored = (enrollmentId: string) => countRows(sql`
        from hrm_benefit_payroll_inputs where org_id = ${w.orgId} and enrollment_id = ${enrollmentId} and coverage_from = '2026-04-01'::date`);
      const full = await generate(w.admin, "2026-03");
      assert.equal(full.length, 4, "the unrestricted admin materializes both employees' rows");
      const scoped = await generate(w.scoped, "2026-04");
      assert.equal(scoped.length, 2);
      assert.ok(scoped.every((row) => row.employmentId === empA), "the scoped month returns only A's rows");
      assert.equal(await stored(electB.id), 0, "no B row is materialized");
      assert.equal(await stored(electA.id), 2);
      const voidAs = (inputId: string, reason = "probe") => voidBenefitPayrollInput({ orgId: w.orgId, actorId: w.scoped, inputId, reason });
      const hidden = await refusesLikeUnknown(() => voidAs(full.find((row) => row.employmentId === empB)!.id), () => voidAs(randomUUID()));
      assert.deepEqual([hidden.name, hidden.code], ["BenefitsError", "NOT_FOUND"]);
      assert.equal((await voidAs(scoped[0]!.id, "duplicate month")).status, "voided");
      // Transfer is terminate plus rehire: the identity guard refuses an in-place rehome.
      await assert.rejects(
        db.execute(sql`update worker_employments set employer_subsidiary_id = ${w.subB} where org_id = ${w.orgId} and id = ${empA}`),
        refusalMatches(/employer_subsidiary_id is immutable/),
      );
    },
  }),
  scopeRow({
    name: "enrollment plan selectors fence legal entities and retain declared coverage levels",
    permissions: BENEFITS,
    seed: async (w) => {
      const a = await seedPlan(w.orgId, { employer_subsidiary_id: w.subA, levels: true });
      const b = await seedPlan(w.orgId, { employer_subsidiary_id: w.subB });
      const shared = await seedPlan(w.orgId);
      const inactive = await seedPlan(w.orgId, { is_active: false });
      return { a: a.planId, b: b.planId, shared: shared.planId, inactive: inactive.planId };
    },
    read: async (w, ids) => {
      const full = await listEnrollmentPlanOptions(db, w.orgId, w.admin);
      assert.ok(full.some((plan) => plan.value === ids.b));
      const scoped = await listEnrollmentPlanOptions(db, w.orgId, w.scoped);
      assert.deepEqual(new Set(scoped.map((plan) => plan.value)), new Set([ids.a, ids.shared]));
      assert.deepEqual(scoped.find((plan) => plan.value === ids.a)?.levels.map((level) => level.value), ['single', 'family']);
      assert.ok(!scoped.some((plan) => plan.value === ids.inactive));
      const catalog = await listBenefitPlans(db, w.orgId, w.scoped);
      assert.deepEqual(new Set(catalog.map((plan) => plan.id)), new Set([ids.a, ids.shared, ids.inactive]));
      assert.equal(catalog.find((plan) => plan.id === ids.inactive)?.isActive, false);
      assert.equal(catalog.find((plan) => plan.id === ids.a)?.employeeCost, '250.0000');
    },
  }),
  scopeRow({
    name: "enrollment-window reads fence B's windows and pending counts to the lens",
    permissions: BENEFITS,
    seed: async (w) => {
      const { planId } = await seedPlan(w.orgId, { requires_approval: true });
      const windowIds: string[] = [];
      for (const [subsidiaryId, name] of [[w.subA, "A window"], [w.subB, "B window"]] as const) {
        const { id: windowId } = await enrollmentWindow(w.orgId, w.admin, subsidiaryId, name);
        await openEnrollmentWindow({ orgId: w.orgId, actorId: w.admin, windowId });
        const { employmentId } = await seedEmployment(w.orgId, subsidiaryId, { displayName: "Benefits Worker" });
        await electEnrollment({ orgId: w.orgId, actorId: w.admin, employmentId, planId, windowId, effectiveFrom: "2026-02-01" });
        windowIds.push(windowId);
      }
      return { windowA: windowIds[0]!, windowB: windowIds[1]! };
    },
    read: async (w, { windowA, windowB }) => {
      const full = await listEnrollmentWindows(db, w.orgId, w.admin);
      assert.deepEqual([windowA, windowB].map((id) => full.find((row) => row.id === id)?.pendingApprovals), [1, 1]);
      const scoped = await listEnrollmentWindows(db, w.orgId, w.scoped);
      const seenA = scoped.find((row) => row.id === windowA);
      assert.deepEqual([seenA?.pendingApprovals, seenA?.elections], [1, 1], "A's window stays visible with A's counts");
      assert.ok(!scoped.some((row) => row.id === windowB || row.name === "B window"), "B's window leaks through no row");
      const get = (windowId: string) => getEnrollmentWindow({ orgId: w.orgId, actorId: w.scoped, windowId });
      assert.equal((await refusesLikeUnknown(() => get(windowB), () => get(randomUUID()))).code, "NOT_FOUND");
    },
  }),
  scopeRow({
    name: "enrollment-window writes need the employer's scope and org-wide windows need unrestricted scope",
    permissions: BENEFITS,
    actors: BENEFITS_WRITER,
    write: async (w) => {
      const departmentB = (await db.execute<{ id: string }>(sql`
        insert into departments (org_id, name, subsidiary_id) values (${w.orgId}, 'Second entity department', ${w.subB}) returning id`)).rows[0]!.id;
      const windowB = await enrollmentWindow(w.orgId, w.admin, w.subB, "B window");
      const windowOrg = await enrollmentWindow(w.orgId, w.admin, null, "Org window");
      const own = await enrollmentWindow(w.orgId, w.scoped, w.subA, "A window");
      const open = (actorId: string, windowId: string) => openEnrollmentWindow({ orgId: w.orgId, actorId, windowId });
      assert.equal((await open(w.scoped, own.id)).status, "open", "in-scope creation stores and opens");
      const foreign = await refusesLikeUnknown(
        () => enrollmentWindow(w.orgId, w.scoped, w.subB, "B clone"), () => enrollmentWindow(w.orgId, w.scoped, randomUUID(), "Fabricated clone"),
      );
      assert.equal(foreign.code, "NOT_FOUND");
      await refusal(enrollmentWindow(w.orgId, w.scoped, null, "Org clone"), UnrestrictedScopeError, UNRESTRICTED);
      assert.equal((await refusalOf(enrollmentWindow(w.orgId, w.admin, w.subA, "Mismatched department", departmentB))).code, "REFUSED");
      assert.equal((await refusesLikeUnknown(() => open(w.scoped, windowB.id), () => open(w.scoped, randomUUID()))).code, "NOT_FOUND");
      await open(w.admin, windowOrg.id);
      const close = (actorId: string, windowId: string, reason: string) => closeEnrollmentWindow({ orgId: w.orgId, actorId, windowId, reason });
      await refusal(close(w.scoped, windowOrg.id, "probe"), UnrestrictedScopeError, UNRESTRICTED);
      const reread = await getEnrollmentWindow({ orgId: w.orgId, actorId: w.admin, windowId: windowOrg.id });
      assert.equal(reread.status, "open", "the refused close changed nothing");
      assert.equal((await close(w.scoped, own.id, "round over")).status, "closed");
    },
  }),
  scopeRow({
    name: "certified runs: B's filings stay hidden from the A lens and B's run lifecycle refuses it",
    ...CONSTRUCTION,
    seed: async (w) => {
      const site = await jobsite(w);
      const run = async (projectId: string, weekEnding: string) => (await db.execute<{ id: string }>(sql`
        insert into hrm_certified_payroll_runs
          (org_id, project_id, week_ending, status, generated_at, format_key, payload, created_by, updated_by)
        values (${w.orgId}, ${projectId}, ${weekEnding}::date, 'generated', now(), 'federal-weekly', ${FROZEN}::jsonb, ${w.admin}, ${w.admin})
        returning id::text as id`)).rows[0]!.id;
      return { ...site, runA: await run(site.projectA, "2026-09-13"), runB: await run(site.projectB, "2026-09-13"), amendB: await run(site.projectB, "2026-09-06") };
    },
    read: async (w, { projectB, runA, runB }) => {
      const ids = async (actorId: string, projectId?: string) => (await listRuns(db, w.orgId, actorId, projectId)).map((run) => run.id);
      const admin = await ids(w.admin);
      assert.ok(admin.includes(runA) && admin.includes(runB), "the admin sees both entities' runs");
      const scoped = await ids(w.scoped);
      assert.ok(scoped.includes(runA), "A's run stays visible to the A lens");
      assert.ok(!scoped.includes(runB), "B's run is hidden from the A lens");
      assert.deepEqual(await ids(w.scoped, projectB), [], "filtering by B's project reads empty, not B's runs");
      assert.deepEqual(await ids(w.scoped, randomUUID()), [], "a fabricated project reads exactly like B's");
    },
    write: async (w, { projectB, runB, amendB }) => {
      const { orgId } = w;
      await refusesLikeMissing((runId) => submitRun(db, { orgId, actorId: w.scoped, runId }), runB, /cannot be submitted/);
      assert.equal((await submitRun(db, { orgId, actorId: w.admin, runId: runB })).status, "submitted", "the refused submit left B's run generated");
      const before = (await listRuns(db, orgId, w.admin)).length;
      await refusal(amendRun(db, { orgId, actorId: w.scoped, runId: amendB }), HrmConstructionError, MISSING);
      const after = await listRuns(db, orgId, w.admin);
      assert.equal(after.length, before, "the refused amend wrote no run");
      assert.equal(after.find((run) => run.id === amendB)?.status, "generated", "the parent run is untouched");
      await refusal(downloadRun(db, orgId, w.scoped, runB), HrmConstructionError, MISSING);
      assert.equal((await downloadRun(db, orgId, w.admin, runB)).filename, "cert.txt", "the file exists; only the lens refused");
      await refusesLikeMissing((projectId) => projectComplianceSummary(db, orgId, w.scoped, projectId), projectB, MISSING);
    },
  }),
  scopeRow({
    name: "per-diem entries hide B's amounts and refuse B's compute, approval and void",
    ...CONSTRUCTION,
    seed: jobsite,
    write: async (w, { projectA, projectB, workerA, workerB }) => {
      const { orgId } = w;
      await createPolicy(db, {
        orgId, actorId: w.admin, name: "Daily rate", basis: "flat_daily", rules: { amount: "75.0000" }, currency: "USD",
        effectiveFrom: "2026-01-01", payComponentId: await seedComponent(orgId, { name: "Per diem" }),
      });
      for (const [worker, projectId] of [[workerA, projectA], [workerB, projectB]] as const) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, project_id, worked_on, hours, status)
          values (${orgId}, ${worker.partyId}, ${projectId}, '2026-09-08'::date, '8.0000', 'approved')`);
      }
      const compute = (actorId: string, employmentId: string) => computeForWeek(db, { orgId, actorId, employmentId, weekStart: "2026-09-07" });
      const stored = async () => (await listEntries(db, orgId, w.admin)).length;
      const before = await stored();
      await refusal(compute(w.scoped, workerB.employmentId), HrmConstructionError, MISSING);
      assert.equal(await stored(), before, "the refused compute wrote no entries");
      const entriesA = await compute(w.admin, workerA.employmentId);
      const entriesB = await compute(w.admin, workerB.employmentId);
      assert.deepEqual([entriesA.length, entriesB.length], [1, 1]);
      const scoped = (await listEntries(db, orgId, w.scoped)).map((entry) => entry.id);
      assert.ok(scoped.includes(entriesA[0]!.id), "A's entry stays visible");
      assert.ok(!scoped.includes(entriesB[0]!.id), "B's 75.00 leaks through no row");
      const entryB = { orgId, entryId: entriesB[0]!.id, kind: "per_diem" as const };
      await refusal(approveEntry(db, { ...entryB, actorId: w.scoped }), HrmConstructionError, MISSING);
      assert.equal((await approveEntry(db, { ...entryB, actorId: w.admin })).status, "approved", "the refused approval left it computed");
      await refusal(voidEntry(db, { ...entryB, actorId: w.scoped, reason: "A void" }), HrmConstructionError, /cannot be voided/);
      assert.equal((await voidEntry(db, { ...entryB, actorId: w.admin, reason: "A void" })).status, "voided", "the refused void unlinked nothing");
    },
  }),
  scopeRow({
    name: "compliance findings hide B's evidence and refuse B's transitions",
    ...CONSTRUCTION,
    seed: async (w) => {
      const site = await jobsite(w);
      const finding = (projectId: string, employmentId: string) => recordFinding(db, {
        orgId: w.orgId, actorId: w.admin, kind: "missing_rate", projectId, workedOn: "2026-09-08", employmentId, detail: { reason: "seed" },
      });
      return { findingA: await finding(site.projectA, site.workerA.employmentId), findingB: await finding(site.projectB, site.workerB.employmentId) };
    },
    read: async (w, { findingA, findingB }) => {
      const scoped = (await listFindings(db, w.orgId, w.scoped, "open")).map((finding) => finding.id);
      assert.ok(scoped.includes(findingA.id), "A's finding stays visible");
      assert.ok(!scoped.includes(findingB.id), "B's finding is hidden");
    },
    write: async (w, { findingB }) => {
      await refusesLikeMissing((id) => acknowledgeFinding(db, w.orgId, w.scoped, id), findingB.id, /cannot be acknowledged/);
      assert.equal((await acknowledgeFinding(db, w.orgId, w.admin, findingB.id)).status, "acknowledged", "the refused ack left it open");
      await refusal(resolveFinding(db, w.orgId, w.scoped, findingB.id, "A reason"), HrmConstructionError, /cannot be resolved/);
      assert.equal((await resolveFinding(db, w.orgId, w.admin, findingB.id, "crew rebalanced")).status, "resolved", "the refused resolve moved nothing");
    },
  }),
  scopeRow({
    name: "the wage resolver fences B's priced day by lens, not grant, and writes no evidence",
    ...CONSTRUCTION,
    actors: { admin: { scope: "all" }, scoped: { scope: "A" }, hookApprover: { scope: "direct", permissions: [] } },
    seed: jobsite,
    write: async (w, { projectA, projectB, workerA, workerB }) => {
      const { orgId } = w;
      const journey = await createClassification(db, { orgId, actorId: w.admin, code: "ELEC-J", name: "Electrician journey", trade: "Electrical" });
      for (const [projectId, worker, name] of [[projectA, workerA, "A local"], [projectB, workerB, "B local"]] as const) {
        const schedule = await createSchedule(db, {
          orgId, actorId: w.admin, kind: "union_agreement", name, appliesTo: { project_ids: [projectId] }, reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
        });
        await addScheduleLine(db, {
          orgId, actorId: w.admin, scheduleId: schedule.id, classificationId: journey.id,
          baseRate: "60.0000", fringeRate: "3.0000", currency: "USD", effectiveFrom: "2026-01-01",
        });
        await assignClassification(db, { orgId, actorId: w.admin, employmentId: worker.employmentId, classificationId: journey.id, effectiveFrom: "2026-01-01" });
      }
      const price = (actorId: string, employmentId: string, projectId: string) =>
        resolveWage(db, { orgId, actorId, employmentId, projectId, workedOn: "2026-09-08" });
      assert.equal((await price(w.scoped, workerA.employmentId, projectA)).base, "60.0000", "A's worker prices on A's project");
      const flagged = async () => (await listFindings(db, orgId, w.admin, "open")).filter((f) => f.employmentId === workerB.employmentId).length;
      const before = await flagged();
      await refusesLikeMissing((employmentId) => price(w.scoped, employmentId, projectB), workerB.employmentId, MISSING);
      assert.equal(await flagged(), before, "the refused pricing flagged nothing");
      // The approval-time hook prices without a grant: the lens fences, never the grant.
      assert.equal((await price(w.hookApprover, workerA.employmentId, projectA)).base, "60.0000");
    },
  }),
  scopeRow({
    name: "a department schedule prices only workers assigned to that department",
    ...CONSTRUCTION,
    actors: { admin: { scope: "all" } },
    write: async (w) => {
      const { orgId } = w;
      await enableConstruction(orgId);
      const [electrical, plumbing] = [randomUUID(), randomUUID()];
      await db.execute(sql`insert into departments (id, org_id, name) values (${electrical}, ${orgId}, 'Electrical'), (${plumbing}, ${orgId}, 'Plumbing')`);
      const projectId = await entityProject(orgId, w.subA, "Department project");
      const classification = await createClassification(db, { orgId, actorId: w.admin, code: "PLMB-ONLY", name: "Plumber", trade: "Plumbing" });
      const schedule = await createSchedule(db, {
        orgId, actorId: w.admin, kind: "prevailing_wage", name: "Plumbing department schedule",
        appliesTo: { department_id: plumbing }, reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
      });
      await addScheduleLine(db, {
        orgId, actorId: w.admin, scheduleId: schedule.id, classificationId: classification.id,
        baseRate: "91.0000", fringeRate: "5.0000", currency: "USD", effectiveFrom: "2026-01-01",
      });
      const employments: string[] = [];
      for (const [name, departmentId] of [["Plumbing worker", plumbing], ["Electrical worker", electrical]] as const) {
        const { employmentId } = await seedNamedWorker(orgId, w.subA, name);
        const assignmentId = randomUUID();
        await db.execute(sql`
          insert into employment_assignments (id, org_id, employment_id, assignment_key) values (${assignmentId}, ${orgId}, ${employmentId}, 'primary')`);
        await db.execute(sql`
          insert into employment_assignment_versions (org_id, assignment_id, employment_id, version_no, department_id, is_primary, effective_from)
          values (${orgId}, ${assignmentId}, ${employmentId}, 1, ${departmentId}, true, '2026-01-01'::date)`);
        await assignClassification(db, { orgId, actorId: w.admin, employmentId, classificationId: classification.id, effectiveFrom: "2026-01-01" });
        employments.push(employmentId);
      }
      const price = (employmentId: string) => resolveWage(db, { orgId, actorId: w.admin, employmentId, projectId, workedOn: "2026-09-08" });
      assert.equal((await price(employments[0]!)).base, "91.0000");
      await assert.rejects(
        price(employments[1]!),
        /No (active prevailing-wage or union schedule covers|rate line covers)/,
        "a schedule anchored to Plumbing must not price an Electrical department worker",
      );
    },
  }),
  scopeRow({
    name: "construction checks and config writes refuse B anchors, and org-wide config names the unrestricted remedy",
    ...CONSTRUCTION,
    seed: jobsite,
    write: async (w, { projectB, workerA, workerB }) => {
      const { orgId } = w;
      const as = (actorId: string) => ({ orgId, actorId });
      const journey = await createClassification(db, { ...as(w.admin), code: "PLMB-J", name: "Plumber journey", trade: "Plumbing" });
      const apprentice = await createClassification(db, {
        ...as(w.admin), code: "PLMB-A", name: "Plumber apprentice", trade: "Plumbing", isApprentice: true, journeyClassificationId: journey.id,
      });
      const schedule = (actorId: string, kind: "prevailing_wage" | "union_agreement" | "org_declared", name: string, appliesTo: AppliesTo) =>
        createSchedule(db, { ...as(actorId), kind, name, appliesTo, reciprocity: "jobsite_local", effectiveFrom: "2026-01-01" });
      const scheduleB = await schedule(w.admin, "prevailing_wage", "B schedule", { project_ids: [projectB] });
      const scheduleOrg = await schedule(w.admin, "org_declared", "Shared schedule", {});
      const compClass = await createCompClass(db, { ...as(w.admin), code: "5183", name: "Plumbing", ratePer100: "4.5000", effectiveFrom: "2026-01-01" });

      const visible = (await listSchedules(db, orgId, w.scoped)).map((row) => row.id);
      assert.ok(!visible.includes(scheduleB.id), "B's schedule lines never reach the A lens");
      assert.ok(visible.includes(scheduleOrg.id), "the shared org-wide schedule stays readable");

      const scoped = as(w.scoped);
      const day = { ...scoped, projectId: projectB, workedOn: "2026-09-08" };
      const assign = (employmentId: string, homeScheduleId?: string) =>
        assignClassification(db, { ...scoped, employmentId, classificationId: journey.id, effectiveFrom: "2026-01-01", homeScheduleId });
      await refuseAll([
        ["ratio check on B's project", () => checkDay(db, day)],
        ["comp split on B's project", () => dailySplit(db, day)],
        ["classifying B's project day", () => classify(db, day)],
        ["schedule anchored to B's project", () => schedule(w.scoped, "union_agreement", "B local", { project_ids: [projectB] })],
        ["line on B's schedule", () => addScheduleLine(db, {
          ...scoped, scheduleId: scheduleB.id, classificationId: journey.id, baseRate: "60.0000", currency: "USD", effectiveFrom: "2026-01-01",
        })],
        ["rescoping B's schedule", () => updateScheduleScope(db, { ...scoped, scheduleId: scheduleB.id, appliesTo: {} })],
        ["classifying B's worker", () => assign(workerB.employmentId)],
        ["comp rule on B's project", () => createCompRule(db, { ...scoped, priority: 1, match: { project_id: projectB }, compClassId: compClass.id })],
        ["ratio rule on B's schedule", () => createRatioRule(db, {
          ...scoped, scheduleId: scheduleB.id, journeyClassificationId: journey.id, apprenticeClassificationId: apprentice.id,
          ratioJourney: 3, ratioApprentice: 1, measured: "daily", effectiveFrom: "2026-01-01",
        })],
        // The home local prices by reciprocity, so naming B's schedule from A's worker is a B anchor.
        ["homing A's worker to B's schedule", () => assign(workerA.employmentId, scheduleB.id)],
      ], HrmConstructionError, MISSING);
      const homed = await assignClassification(db, {
        ...as(w.admin), employmentId: workerA.employmentId, classificationId: journey.id, effectiveFrom: "2026-01-01", homeScheduleId: scheduleOrg.id,
      });
      assert.equal(homed.homeScheduleId, scheduleOrg.id, "a valid shared home schedule still assigns");

      await refuseAll([
        ["org-wide schedule", () => schedule(w.scoped, "org_declared", "Everywhere", {})],
        ["classification", () => createClassification(db, { ...scoped, code: "X-1", name: "X", trade: "X" })],
        ["comp class", () => createCompClass(db, { ...scoped, code: "5184", name: "Other", ratePer100: "1.0000", effectiveFrom: "2026-01-01" })],
        ["state comp rule", () => createCompRule(db, { ...scoped, priority: 1, match: { state_code: "CA" }, compClassId: compClass.id })],
        ["per-diem policy", () => createPolicy(db, {
          ...scoped, name: "A policy", basis: "flat_daily", rules: { amount: "10.0000" }, currency: "USD", effectiveFrom: "2026-01-01",
        })],
      ], UnrestrictedScopeError, UNRESTRICTED);
    },
  }),
  scopeRow({
    name: "survey results aggregate only in-scope respondents' scores and comments",
    ...SURVEYS,
    read: async (w) => {
      const { a1, a2, b1 } = await respondents(w);
      const surveyId = await answeredSurvey(w, "named", [
        [a1, { scale: 5, enps: 10, text: "A1 says great" }],
        [a2, { scale: 5, enps: 10, text: "A2 says great" }],
        [b1, { scale: 1, enps: 0, text: "B1 says terrible" }],
      ]);
      const full = await getSurveyResults({ orgId: w.orgId, actorId: w.admin, surveyId });
      // eNPS over all three: 67% promoters minus 33% detractors.
      assert.deepEqual([full.invitations, full.responded, full.enps?.responses, full.enps?.score], [3, 3, 3, 34]);
      assert.ok(full.comments[0]!.texts.some((text) => text.includes("terrible")), "the admin sees every comment");
      const scoped = await getSurveyResults({ orgId: w.orgId, actorId: w.scoped, surveyId });
      assert.deepEqual(
        [scoped.invitations, scoped.responded, scoped.participationPct, scoped.enps?.responses, scoped.enps?.score], [2, 2, 100, 2, 100],
        "counts and eNPS cover the A slice only",
      );
      assert.ok(scoped.comments[0]!.texts.some((text) => text.includes("great")));
      assert.ok(!scoped.comments.flatMap((c) => c.texts).some((text) => text.includes("terrible")), "B's comment never reaches the A lens");
    },
  }),
  scopeRow({
    name: "the survey anonymity minimum applies after scoping, for anonymous and confidential responses",
    ...SURVEYS,
    read: async (w) => {
      const { a1, b1 } = await respondents(w);
      // Confidential responses attribute through a link sealed with the session secret.
      const priorSecret = process.env.SESSION_SECRET;
      process.env.SESSION_SECRET = "openbooks-test-only-survey-scope";
      try {
        for (const anonymity of ["anonymous", "confidential"] as const) {
          const surveyId = await answeredSurvey(w, anonymity, [
            [a1, { scale: 4, enps: 9, text: "A1 note" }],
            [b1, { scale: 2, enps: 3, text: "B1 note" }],
          ]);
          const full = await getSurveyResults({ orgId: w.orgId, actorId: w.admin, surveyId });
          assert.deepEqual([full.responded, full.comments[0]!.texts.length], [2, 2], `${anonymity}: two responses clear a minimum of two`);
          const scoped = await getSurveyResults({ orgId: w.orgId, actorId: w.scoped, surveyId });
          assert.deepEqual(
            [scoped.suppressed, scoped.invitations, scoped.responded, scoped.enps, scoped.comments.length], [true, 0, 0, null, 0],
            `${anonymity}: a scoped slice of one is suppressed and de-anonymizes nobody`,
          );
        }
      } finally {
        if (priorSecret === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = priorSecret;
      }
    },
  }),
  scopeRow({
    name: "survey list, read, open, edit and close are scoped to every respondent",
    ...SURVEYS,
    write: async (w) => {
      const { a1, b1 } = await respondents(w);
      const scoped = { orgId: w.orgId, actorId: w.scoped };
      const save = (actorId: string, name: string, surveyId?: string) => saveSurvey({
        orgId: w.orgId, actorId, surveyId, name, kind: "custom", anonymity: "named", minGroupSize: 2, questions: QUESTIONS,
      });
      const listed = async () => (await listSurveys(scoped)).map((survey) => survey.id);
      const bOnly = await save(w.admin, "B only");
      await openSurvey({ orgId: w.orgId, actorId: w.admin, surveyId: bOnly.id, partyIds: [b1] });
      assert.ok(!(await listed()).includes(bOnly.id), "a B-only survey never lists to the A lens");
      const missing = randomUUID();
      for (const read of [getSurvey, getSurveyResults]) {
        const hidden = await refusesLikeUnknown(() => read({ ...scoped, surveyId: bOnly.id }), () => read({ ...scoped, surveyId: missing }));
        assert.equal(hidden.name, "HrmSurveysError", read.name);
      }

      const own = await save(w.scoped, "A draft");
      assert.equal((await save(w.scoped, "Renamed A", own.id)).name, "Renamed A", "a respondent-free draft edits in scope");
      const openTo = (partyId: string) => openSurvey({ ...scoped, surveyId: own.id, partyIds: [partyId] });
      assert.match((await refusesLikeUnknown(() => openTo(b1), () => openTo(randomUUID()), HrmSurveysError)).message, /not in this organization/);
      assert.equal((await openTo(a1)).deliveries.length, 1);

      // A mixed survey lists through its in-scope invitee, but mutations need every respondent in scope.
      const mixed = await save(w.admin, "Mixed");
      await openSurvey({ orgId: w.orgId, actorId: w.admin, surveyId: mixed.id, partyIds: [a1, b1] });
      assert.ok((await listed()).includes(mixed.id));
      for (const run of [() => save(w.scoped, "Renamed", mixed.id), () => closeSurvey({ ...scoped, surveyId: mixed.id })]) {
        assert.equal((await refusal(run(), HrmSurveysError)).code, "NOT_FOUND");
      }
      assert.equal((await closeSurvey({ ...scoped, surveyId: own.id })).status, "closed");
    },
  }),
  scopeRow({
    name: "a foreman outside a crew batch's scope cannot list, open, edit, submit or withdraw it",
    ...CREW,
    seed: async (w) => {
      const site = await crewSite(w);
      const batchId = await withOrg(w.orgId, () => createBatch({
        orgId: w.orgId, actorUserId: w.foremanA, foremanPartyId: site.foremanA, projectId: site.projectA, workedOn: "2026-09-14",
        canManageAll: false, allowedSubsidiaryIds: new Set([w.subA]),
      }));
      return { ...site, batchId };
    },
    read: (w, { batchId }) => withOrg(w.orgId, async () => {
      const actorA: CrewBatchActor = { actorUserId: w.foremanA, allowedSubsidiaryIds: new Set([w.subA]) };
      const actorB: CrewBatchActor = { actorUserId: w.foremanB, allowedSubsidiaryIds: new Set([w.subB]) };
      const listed = async (actor: CrewBatchActor) => (await listCrewBatches(w.orgId, {}, actor)).map((batch) => batch.id);
      assert.ok((await listed(actorA)).includes(batchId), "foreman A lists their own batch");
      assert.ok(!(await listed(actorB)).includes(batchId), "foreman B cannot enumerate A's batch");
      assert.equal(await refusesCode(() => getBatchDetail(w.orgId, actorB, batchId)), "batch_unknown");
      assert.equal((await getBatchDetail(w.orgId, actorA, batchId)).id, batchId);
      assert.ok((await listed({ actorUserId: w.foremanA, allowedSubsidiaryIds: null })).includes(batchId), "an unrestricted reader lists it");
    }),
    write: async (w, { batchId, worker, foremanB }) => {
      const scopeA = { orgId: w.orgId, canManageAll: false, allowedSubsidiaryIds: new Set([w.subA]) };
      const lines = (actorUserId: string, id: string, employeePartyId: string) =>
        setBatchLines({ ...scopeA, actorUserId, batchId: id, lines: [{ employeePartyId, hours: "8.0000" }] });
      // A B worker on A's batch refuses like a missing worker, never with an employment-scope code.
      assert.equal(await refusesCode(() => lines(w.foremanA, batchId, foremanB)), "employee_unknown");
      await withOrg(w.orgId, async () => {
        // B holds crew entry on their own job but learns nothing here: every denial matches the missing-id refusal.
        assert.equal(await refusesCode(() => lines(w.foremanB, batchId, worker)), await refusesCode(() => lines(w.foremanB, randomUUID(), worker)));
        assert.equal(await refusesCode(() => submitBatch({ ...scopeA, actorUserId: w.foremanB, batchId })), "batch_unknown");
        await lines(w.foremanA, batchId, worker);
        await submitBatch({ ...scopeA, actorUserId: w.foremanA, batchId });
        assert.equal(await refusesCode(() => withdrawBatch({ ...scopeA, actorUserId: w.foremanB, batchId })), "batch_unknown");
        await withdrawBatch({ ...scopeA, actorUserId: w.foremanA, batchId });
        const status = (await db.execute<{ status: string }>(sql`select status from crew_time_batches where id = ${batchId}`)).rows[0]?.status;
        assert.equal(status, "draft", "A works their own batch end to end");
      });
    },
  }),
  scopeRow({
    name: "opening a crew batch needs the foreman's own identity or time.manage, and an in-scope project",
    ...CREW,
    seed: crewSite,
    write: (w, { foremanA, projectA, projectB }) => withOrg(w.orgId, async () => {
      const open = (actorUserId: string, projectId: string, allowedSubsidiaryIds: Set<string> | null) => createBatch({
        orgId: w.orgId, actorUserId, foremanPartyId: foremanA, projectId, workedOn: "2026-09-14",
        canManageAll: allowedSubsidiaryIds === null, allowedSubsidiaryIds,
      });
      const outOfScope = await refusesCode(() => open(w.foremanA, projectB, new Set([w.subA])));
      assert.equal(outOfScope, "project_unknown");
      assert.equal(await refusesCode(() => open(w.foremanA, randomUUID(), new Set([w.subA]))), outOfScope, "a missing project refuses identically");
      assert.equal(await refusesCode(() => open(w.foremanB, projectA, new Set([w.subA, w.subB]))), "foreman_not_self");
      assert.ok(await open(w.foremanB, projectA, null), "a supervisor acting for the foreman may still open it");
    }),
  }),
  scopeRow({
    name: "crew batch creation waits for the foreman assignment to remain valid",
    ...CREW,
    seed: crewSite,
    write: async (w, { foremanA, projectA }) => {
      const assignment = sql`from schedule_resources where org_id = ${w.orgId} and project_id = ${projectA} and party_id = ${foremanA}`;
      const lock = holdLock(w.orgId, sql`select id ${assignment} for update`, sql`delete ${assignment}`);
      try {
        await lock.locked;
        const creation = refusesCode(() => withOrg(w.orgId, () => createBatch({
          orgId: w.orgId, actorUserId: w.foremanA, foremanPartyId: foremanA, projectId: projectA, workedOn: "2026-09-14",
          canManageAll: false, allowedSubsidiaryIds: new Set([w.subA]),
        })));
        assert.ok(await stillPending(creation), "creation waits for the locked assignment row");
        await lock.release();
        assert.equal(await creation, "foreman_not_on_project", "a removed foreman assignment prevents batch creation");
        // Counted under the org's RLS context, the same visibility the refused creation had.
        const stored = await withOrg(w.orgId, () => countRows(sql`from crew_time_batches where org_id = ${w.orgId} and project_id = ${projectA} and foreman_party_id = ${foremanA}`));
        assert.equal(stored, 0);
      } finally {
        await lock.release();
      }
    },
  }),
  scopeRow({
    name: "an entity-restricted certifications holder neither sees nor changes another entity's qualifications",
    ...CERTIFICATIONS,
    actors: { admin: { scope: "all" }, scoped: { scope: "A", overrides: true } },
    seed: credentials,
    read: async (w, { empB, qualA, qualB1 }) => {
      const hr = { orgId: w.orgId, actorId: w.scoped };
      assert.deepEqual((await listQualifications(db, hr)).map((row) => row.id), [qualA.id], "only the caller's own entity is enumerated");
      assert.deepEqual(await listQualifications(db, { ...hr, employmentId: empB }), [], "a named out-of-scope employment answers as if it held nothing");
      assert.equal(await loadQualification(db, { ...hr, qualificationId: qualB1.id }), null, "an out-of-scope row reads as null, exactly like a missing one");
      await refuseAll([["events on B's row", () => listQualificationEvents(db, { ...hr, qualificationId: qualB1.id })]], HrmQualificationError, QUAL_NOT_FOUND);
    },
    write: async (w, { empB, typeId, qualB1, qualB2 }) => {
      const hr = { orgId: w.orgId, actorId: w.scoped };
      const ledger = sql`from hrm_worker_qualifications where org_id = ${w.orgId}`;
      const before = await countRows(ledger);
      await refuseAll([
        ["record on B's employment", () => recordQualification(db, { ...hr, employmentId: empB, typeId, issuedOn: "2026-02-02" })],
        ["verify B's row", () => verifyQualification(db, { ...hr, qualificationId: qualB1.id, reason: "saw the certificate" })],
        ["revoke B's row", () => revokeQualification(db, { ...hr, qualificationId: qualB2.id, reason: "scope probe" })],
      ], HrmQualificationError, QUAL_NOT_FOUND);
      assert.equal(await countRows(ledger), before, "refused mutations write nothing");
      const admin = { orgId: w.orgId, actorId: w.admin };
      assert.equal((await loadQualification(db, { ...admin, qualificationId: qualB1.id }))?.storedStatus, "pending_verification", "a refused verify changes no status");
      assert.equal((await listQualifications(db, admin)).length, 3, "an unrestricted holder keeps the full surface");
      assert.equal((await verifyQualification(db, { ...admin, qualificationId: qualB1.id, reason: "certificate on file" })).storedStatus, "valid");
    },
  }),
  scopeRow({
    name: "qualification requirements, alerts and the assignment gate honor the actor's entity lens",
    ...CERTIFICATIONS,
    seed: credentials,
    write: async (w, { empA, empB, typeId, qualA, qualB1 }) => {
      const { orgId } = w;
      const [projectA, projectB, equipmentId, positionId, classificationId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, status)
        values (${projectA}, ${orgId}, ${w.subA}, 'QUAL-A', 'QUAL-A', 'active'), (${projectB}, ${orgId}, ${w.subB}, 'QUAL-B', 'QUAL-B', 'active')`);
      await db.execute(sql`
        insert into equipment_units (id, org_id, subsidiary_id, unit_number, name, status, purchase_price)
        values (${equipmentId}, ${orgId}, ${w.subB}, ${`EQ-${equipmentId.slice(0, 8)}`}, 'Branch equipment', 'active', 0)`);
      await db.execute(sql`insert into positions (id, org_id, position_code, revision) values (${positionId}, ${orgId}, ${`POS-${positionId.slice(0, 8)}`}, 1)`);
      await db.execute(sql`
        insert into position_versions (org_id, position_id, version_no, title, employer_subsidiary_id, planned_fte, status, effective_from, recorded_at)
        values (${orgId}, ${positionId}, 1, 'Branch role', ${w.subB}, 1, 'open', '2020-01-01', now())`);
      await db.execute(sql`
        insert into hrm_work_classifications (id, org_id, code, name, trade)
        values (${classificationId}, ${orgId}, ${`GLOBAL-${classificationId.slice(0, 8)}`}, 'Organization classification', 'General')`);
      const requirement = (subjectKind: "project" | "equipment" | "position" | "classification", subjectId: string, actorId = w.admin) =>
        setRequirement(db, { orgId, actorId, subjectKind, subjectId, typeId });
      await requirement("project", projectA);
      const requirementB = await requirement("project", projectB);
      await requirement("equipment", equipmentId);
      await requirement("position", positionId);
      await requirement("classification", classificationId);
      await db.execute(sql`
        insert into hrm_qualification_alerts (org_id, qualification_id, lead_days, due_on, channel)
        values (${orgId}, ${qualA.id}, 30, '2026-12-31', 'inbox'), (${orgId}, ${qualB1.id}, 14, '2026-12-31', 'inbox')`);

      const hr = { orgId, actorId: w.scoped };
      assert.deepEqual((await listRequirements(db, { ...hr, subjectKind: "project" })).map((row) => row.subjectId), [projectA]);
      assert.deepEqual(
        (await listRequirements(db, hr)).map((row) => row.subjectId).sort(), [projectA, classificationId].sort(),
        "project, equipment and position requirements filter by entity; classifications are organization-wide",
      );
      assert.deepEqual((await listAlerts(db, hr)).map((row) => row.qualificationId), [qualA.id]);
      assert.deepEqual(await listAlerts(db, { ...hr, employmentId: empB }), [], "a named out-of-scope employment reads like one with no alerts");
      const check = (employmentId: string, subjectKind: "project" | "equipment", subjectId: string) =>
        checkAssignment(db, { ...hr, employmentId, subjectKind, subjectId });
      await refuseAll([
        ["requirement on B's project", () => requirement("project", projectB, w.scoped)],
        ["removing B's project requirement", () => removeRequirement(db, { ...hr, requirementId: requirementB.id })],
        ["requirement on B's equipment", () => requirement("equipment", equipmentId, w.scoped)],
        ["requirement on B's position", () => requirement("position", positionId, w.scoped)],
        ["gate check for B's employment", () => withOrgTransaction(orgId, () => check(empB, "project", projectA))],
        ["gate check on B's project", () => check(empA, "project", projectB)],
        ["gate check on B's equipment", () => check(empA, "equipment", equipmentId)],
      ], HrmQualificationError, QUAL_NOT_FOUND);
    },
  }),
  scopeRow({
    name: "qualification decisions wait for the employment scope lock",
    ...CERTIFICATIONS,
    seed: credentials,
    write: async (w, { empA, qualA }) => {
      const lock = holdLock(w.orgId, sql`select id from worker_employments where org_id = ${w.orgId} and id = ${empA} for update`);
      try {
        await lock.locked;
        const decision = verifyQualification(db, { orgId: w.orgId, actorId: w.admin, qualificationId: qualA.id });
        assert.ok(await stillPending(decision), "the decision waits until the locked employment scope is rechecked");
        await lock.release();
        assert.equal((await decision).storedStatus, "valid");
      } finally {
        await lock.release();
      }
    },
  }),
]);
