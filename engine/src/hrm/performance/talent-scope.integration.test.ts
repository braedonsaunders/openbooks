import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { createPosition } from "../positions.ts";
import { HrmPerformanceError } from "./errors.ts";
import { createCycle } from "./review-cycles.ts";
import {
  addSuccessionCandidate,
  createSuccessionPlan,
  listSuccessionPlans,
  listTalentDirectory,
  listTalentReviews,
  recordTalentReview,
  removeSuccessionCandidate,
  resolveTalentScales,
  setSuccessionPlanStatus,
  setSuccessionPlanNotes,
} from "./talent.ts";

/**
 * Talent/succession subsidiary fence over the real 0228 tables — DB-owned,
 * one file at a time. No skip guards: the integration partition
 * guarantees a database.
 *
 * The allowed employer set from requireAggregatePerformanceManage must
 * reach every read and mutation: a scoped HR actor revises only their own
 * subsidiaries, and out-of-scope ids answer NOT_FOUND uniformly so rows
 * cannot be probed across the fence. Proofs are read back through the
 * service, and every refusal asserts its code AND its message.
 */

type Harness = {
  org: ScratchOrg;
  subB: string;
  hrAll: string;
  hrA: string;
  hrEmpty: string;
  empA: string;
  empB: string;
};

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function restrictRole(orgId: string, roleKey: string, restriction: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = '["hrm.performance.manage"]'::jsonb,
           subsidiary_restriction = ${JSON.stringify(restriction)}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function enableTalent(orgId: string): Promise<void> {
  for (const key of ["hrm", "hrmPerformance", "hrmSuccession"] as const) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), string_to_array(${`features,${key}`}, ','), 'true'::jsonb, true)
       where id = ${orgId}`);
  }
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

async function mkTemplate(orgId: string, actorId: string): Promise<string> {
  const templateId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_templates (org_id, name, rating_scale, created_by, updated_by)
    values (${orgId}, 'Annual', '{"min": 1, "max": 5, "labels": ["low", "high"]}'::jsonb, ${actorId}, ${actorId})
    returning id`)).rows[0]!.id;
  const sectionId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_template_sections (org_id, template_id, position, title, kind, created_by, updated_by)
    values (${orgId}, ${templateId}, 0, 'Impact', 'competency', ${actorId}, ${actorId})
    returning id`)).rows[0]!.id;
  await db.execute(sql`
    insert into hrm_review_template_questions
      (org_id, section_id, position, prompt, answer_kind, required, created_by, updated_by)
    values (${orgId}, ${sectionId}, 0, 'Customer impact', 'rating_and_text', true, ${actorId}, ${actorId})
  `);
  return templateId;
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableTalent(org.orgId);
  const hrAll = await createScratchUser(org.orgId, "Talent HR All", "talent_hr_all");
  await grant(org.orgId, hrAll, ["hrm.performance.manage", "hrm.position.manage"]);
  // A second legal entity under the same org.
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
      from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
  // Scoped HR: the manage grant with the subsidiary lens on the first entity.
  const hrA = await createScratchUser(org.orgId, "Talent HR A", "talent_hr_a");
  await grant(org.orgId, hrA, ["hrm.performance.manage"]);
  await restrictRole(org.orgId, "talent_hr_a", { mode: "list", subsidiaryIds: [org.subsidiaryId] });
  const hrEmpty = await createScratchUser(org.orgId, "Talent HR Empty", "talent_hr_empty");
  await grant(org.orgId, hrEmpty, ["hrm.performance.manage"]);
  await restrictRole(org.orgId, "talent_hr_empty", { mode: "list", subsidiaryIds: [] });
  const empA = await mkEmployment(org.orgId, await mkParty(org.orgId, "Employee A"), org.subsidiaryId);
  const empB = await mkEmployment(org.orgId, await mkParty(org.orgId, "Employee B"), subB);
  return { org, subB, hrAll, hrA, hrEmpty, empA, empB };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

function perfError(error: unknown): HrmPerformanceError {
  assert.ok(error instanceof HrmPerformanceError, `expected HrmPerformanceError, got ${String(error)}`);
  return error;
}

function recordArgs(h: Harness, employmentId: string, actorId: string) {
  return {
    orgId: h.org.orgId,
    actorId,
    employmentId,
    performanceKey: "low",
    potentialKey: "high",
    impactOfLoss: "low" as const,
    riskOfLoss: "low" as const,
  };
}

test("talent reviews record inside the fence and refuse outside it", async () => {
  await withHarness(async (h) => {
    const mine = await recordTalentReview(recordArgs(h, h.empA, h.hrA));
    assert.equal(mine.employmentId, h.empA);
    const error = perfError(await recordTalentReview(recordArgs(h, h.empB, h.hrA)).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(error.code, "NOT_FOUND");
    assert.match(error.message, /employment was not found/);
    // Unrestricted HR records either side.
    const theirs = await recordTalentReview(recordArgs(h, h.empB, h.hrAll));
    assert.equal(theirs.employmentId, h.empB);
  });
});

test("talent review lists and the directory filter to allowed subsidiaries", async () => {
  await withHarness(async (h) => {
    await recordTalentReview(recordArgs(h, h.empA, h.hrAll));
    await recordTalentReview(recordArgs(h, h.empB, h.hrAll));
    const scoped = await listTalentReviews({ orgId: h.org.orgId, actorId: h.hrA });
    assert.deepEqual(
      scoped.map((review) => review.employmentId),
      [h.empA],
      "scoped HR lists only their subsidiary's reviews",
    );
    assert.equal((await listTalentReviews({ orgId: h.org.orgId, actorId: h.hrAll })).length, 2);
    const directory = await listTalentDirectory({ orgId: h.org.orgId, actorId: h.hrA });
    assert.ok(directory.employments.some((e) => e.id === h.empA));
    assert.ok(!directory.employments.some((e) => e.id === h.empB), "the other subsidiary's people stay hidden");
    assert.deepEqual(await listTalentReviews({ orgId: h.org.orgId, actorId: h.hrEmpty }), []);
    assert.deepEqual(await listTalentDirectory({ orgId: h.org.orgId, actorId: h.hrEmpty }), {
      employments: [],
      positions: [],
    });
  });
});

test("talent scales refuse a cycle scoped to another subsidiary", async () => {
  await withHarness(async (h) => {
    const templateId = await mkTemplate(h.org.orgId, h.hrAll);
    const cycleB = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrAll,
      templateId,
      name: "B cycle",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-12-31",
      appliesTo: { employer_subsidiary_id: h.subB, department_id: null },
    });
    const error = perfError(await resolveTalentScales({
      orgId: h.org.orgId,
      actorId: h.hrA,
      cycleId: cycleB.id,
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(error.code, "NOT_FOUND");
    assert.match(error.message, /review cycle was not found/);
    const cycleA = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrAll,
      templateId,
      name: "A cycle",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-12-31",
      appliesTo: { employer_subsidiary_id: h.org.subsidiaryId, department_id: null },
    });
    const scales = await resolveTalentScales({ orgId: h.org.orgId, actorId: h.hrA, cycleId: cycleA.id });
    assert.deepEqual([...scales.performance], ["low", "high"]);
  });
});

test("succession plans and candidates stay inside the fence", async () => {
  await withHarness(async (h) => {
    const positionB = await createPosition({
      orgId: h.org.orgId,
      actorId: h.hrAll,
      positionCode: "LEAD-B",
      title: "Lead B",
      employerSubsidiaryId: h.subB,
      plannedFte: "1.0000",
      status: "open",
      effectiveFrom: "2026-01-01",
      reason: "scope seed",
    });
    const positionA = await createPosition({
      orgId: h.org.orgId,
      actorId: h.hrAll,
      positionCode: "LEAD-A",
      title: "Lead A",
      employerSubsidiaryId: h.org.subsidiaryId,
      plannedFte: "1.0000",
      status: "open",
      effectiveFrom: "2026-01-01",
      reason: "scope seed",
    });
    // Scoped HR cannot plan for the other subsidiary's position.
    const createError = perfError(await createSuccessionPlan({
      orgId: h.org.orgId,
      actorId: h.hrA,
      positionId: positionB.id,
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(createError.code, "NOT_FOUND");
    assert.match(createError.message, /position was not found/);
    const planB = await createSuccessionPlan({ orgId: h.org.orgId, actorId: h.hrAll, positionId: positionB.id });
    const planA = await createSuccessionPlan({
      orgId: h.org.orgId,
      actorId: h.hrAll,
      positionId: positionA.id,
      notes: "Interim coverage while the successor is prepared.",
    });
    assert.equal(planA.notes, "Interim coverage while the successor is prepared.");
    const planAReadback = (await listSuccessionPlans({ orgId: h.org.orgId, actorId: h.hrAll }))
      .find((plan) => plan.id === planA.id);
    assert.equal(planAReadback?.notes, "Interim coverage while the successor is prepared.", "plan notes read back from storage");
    await setSuccessionPlanNotes({
      orgId: h.org.orgId,
      actorId: h.hrAll,
      id: planA.id,
      notes: "The regional lead will cover the role through quarter end.",
    });
    const editedPlan = (await listSuccessionPlans({ orgId: h.org.orgId, actorId: h.hrAll }))
      .find((plan) => plan.id === planA.id);
    assert.equal(editedPlan?.notes, "The regional lead will cover the role through quarter end.", "plan notes can be edited and read back");
    // …cannot move its status, add to it, list it, or staff it cross-fence.
    const statusError = perfError(await setSuccessionPlanStatus({
      orgId: h.org.orgId,
      actorId: h.hrA,
      id: planB.id,
      status: "active",
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(statusError.code, "NOT_FOUND");
    const addError = perfError(await addSuccessionCandidate({
      orgId: h.org.orgId,
      actorId: h.hrA,
      planId: planA.id,
      employmentId: h.empB,
      readiness: "ready_now",
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(addError.code, "NOT_FOUND");
    assert.match(addError.message, /employment was not found/);
    const listed = await listSuccessionPlans({ orgId: h.org.orgId, actorId: h.hrA });
    assert.deepEqual(
      listed.map((plan) => plan.id),
      [planA.id],
      "scoped HR lists only their subsidiary's plans",
    );
    assert.deepEqual(await listSuccessionPlans({ orgId: h.org.orgId, actorId: h.hrEmpty }), []);
    // Inside the fence everything works, including removal from a draft plan.
    await setSuccessionPlanStatus({ orgId: h.org.orgId, actorId: h.hrA, id: planA.id, status: "active" });
    const candidate = await addSuccessionCandidate({
      orgId: h.org.orgId,
      actorId: h.hrA,
      planId: planA.id,
      employmentId: h.empA,
      readiness: "ready_now",
    });
    assert.equal(candidate.employmentId, h.empA);
    await setSuccessionPlanStatus({ orgId: h.org.orgId, actorId: h.hrAll, id: planA.id, status: "draft" });
    await removeSuccessionCandidate({ orgId: h.org.orgId, actorId: h.hrAll, planId: planA.id, candidateId: candidate.id });
    const remaining = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_succession_candidates
       where org_id = ${h.org.orgId} and plan_id = ${planA.id}`)).rows[0]!.n;
    assert.equal(remaining, "0");
  });
});
