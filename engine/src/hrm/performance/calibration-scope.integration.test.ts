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
import { HrmPerformanceError } from "./errors.ts";
import { createCycle, openCycle } from "./review-cycles.ts";
import { submitReview } from "./reviews.ts";
import {
  closeCalibrationSession,
  createCalibrationSession,
  openCalibrationSession,
  setCalibratedRating,
} from "./calibration.ts";

/**
 * Calibration subsidiary fence over the real 0228 tables — DB-owned, one
 * file at a time. No skip guards: the integration partition guarantees a
 * database.
 *
 * A scoped HR actor opens sessions, enters entries, and decides ratings
 * only for employments inside their subsidiaries; out-of-scope review ids
 * never surface through entries or the missing list. Proofs are read back
 * through the service, and every refusal asserts its code AND its message.
 */

type Harness = {
  org: ScratchOrg;
  subB: string;
  hrAll: string;
  hrA: string;
  managerAUser: string;
  managerBUser: string;
  workerAEmployment: string;
  workerBEmployment: string;
  cycleId: string;
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

async function enableCalibration(orgId: string): Promise<void> {
  for (const key of ["hrm", "hrmPerformance", "hrmCalibration"] as const) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), string_to_array(${`features,${key}`}, ','), 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

async function linkPerson(orgId: string, userId: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${`Person ${partyId.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${partyId} where id = ${userId} and org_id = ${orgId}`);
  return partyId;
}

async function mkEmployment(orgId: string, partyId: string, subsidiaryId: string): Promise<string> {
  const employmentId = (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date)`);
  return employmentId;
}

async function mkReporting(orgId: string, employmentId: string, managerEmploymentId: string): Promise<void> {
  await db.execute(sql`
    insert into reporting_relationships
      (org_id, employment_id, manager_employment_id, kind, relationship_id, version_no, effective_from)
    values (${orgId}, ${employmentId}, ${managerEmploymentId}, 'line', ${randomUUID()}, 1, '2020-01-01'::date)
  `);
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
  await enableCalibration(org.orgId);
  const hrAll = await createScratchUser(org.orgId, "Calibration HR All", "calibration_hr_all");
  await grant(org.orgId, hrAll, ["hrm.performance.manage"]);
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
      from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
  const hrA = await createScratchUser(org.orgId, "Calibration HR A", "calibration_hr_a");
  await grant(org.orgId, hrA, ["hrm.performance.manage"]);
  await restrictRole(org.orgId, "calibration_hr_a", { mode: "list", subsidiaryIds: [org.subsidiaryId] });
  // Two managed workers, one per subsidiary, each with a line manager.
  const managerAUser = await createScratchUser(org.orgId, "Manager A", "calibration_manager_a");
  const managerAParty = await linkPerson(org.orgId, managerAUser);
  const managerAEmployment = await mkEmployment(org.orgId, managerAParty, org.subsidiaryId);
  const workerAUser = await createScratchUser(org.orgId, "Worker A", "calibration_worker_a");
  const workerAParty = await linkPerson(org.orgId, workerAUser);
  const workerAEmployment = await mkEmployment(org.orgId, workerAParty, org.subsidiaryId);
  await mkReporting(org.orgId, workerAEmployment, managerAEmployment);
  const managerBUser = await createScratchUser(org.orgId, "Manager B", "calibration_manager_b");
  const managerBParty = await linkPerson(org.orgId, managerBUser);
  const managerBEmployment = await mkEmployment(org.orgId, managerBParty, subB);
  const workerBUser = await createScratchUser(org.orgId, "Worker B", "calibration_worker_b");
  const workerBParty = await linkPerson(org.orgId, workerBUser);
  const workerBEmployment = await mkEmployment(org.orgId, workerBParty, subB);
  await mkReporting(org.orgId, workerBEmployment, managerBEmployment);
  const templateId = await mkTemplate(org.orgId, hrAll);
  const cycle = await createCycle({
    orgId: org.orgId,
    actorId: hrAll,
    templateId,
    name: "FY26",
    periodStartOn: "2026-01-01",
    periodEndOn: "2026-12-31",
  });
  await openCycle({ orgId: org.orgId, actorId: hrAll, cycleId: cycle.id });
  return {
    org, subB, hrAll, hrA, managerAUser, managerBUser,
    workerAEmployment, workerBEmployment, cycleId: cycle.id,
  };
}

async function submittedManagerReview(
  h: Harness,
  managerUser: string,
  workerEmployment: string,
): Promise<string> {
  const reviewId = (await db.execute<{ id: string }>(sql`
    select id from hrm_reviews
     where org_id = ${h.org.orgId} and cycle_id = ${h.cycleId}
       and employment_id = ${workerEmployment} and kind = 'manager'`)).rows[0]!.id;
  const impact = (await db.execute<{ id: string }>(sql`
    select id from hrm_review_answers where org_id = ${h.org.orgId} and review_id = ${reviewId}
     order by position limit 1`)).rows[0]!.id;
  const submitted = await submitReview({
    orgId: h.org.orgId,
    actorId: managerUser,
    reviewId,
    answers: [{ answerId: impact, rating: "4", text: "solid quarter" }],
    overallRating: "4",
  });
  assert.equal(submitted.status, "submitted");
  return reviewId;
}

function perfError(error: unknown): HrmPerformanceError {
  assert.ok(error instanceof HrmPerformanceError, `expected HrmPerformanceError, got ${String(error)}`);
  return error;
}

test("calibration sessions refuse a cycle scoped to another subsidiary", async () => {
  const h = await setupHarness();
  try {
    const templateId = (await db.execute<{ templateId: string }>(sql`
      select template_id as "templateId" from hrm_review_cycles
       where org_id = ${h.org.orgId} and id = ${h.cycleId}`)).rows[0]!.templateId;
    const cycleB = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrAll,
      templateId,
      name: "B cycle",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-12-31",
      appliesTo: { employer_subsidiary_id: h.subB, department_id: null },
    });
    const error = perfError(await createCalibrationSession({
      orgId: h.org.orgId,
      actorId: h.hrA,
      cycleId: cycleB.id,
      name: "B session",
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(error.code, "NOT_FOUND");
    assert.match(error.message, /review cycle was not found/);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("opening a session enters only in-scope reviews and decides only in-scope entries", async () => {
  const h = await setupHarness();
  try {
    await submittedManagerReview(h, h.managerAUser, h.workerAEmployment);
    await submittedManagerReview(h, h.managerBUser, h.workerBEmployment);
    const draft = await createCalibrationSession({
      orgId: h.org.orgId,
      actorId: h.hrAll,
      cycleId: h.cycleId,
      name: "Scoped open",
    });
    const opened = await openCalibrationSession({ orgId: h.org.orgId, actorId: h.hrA, id: draft.id });
    assert.equal(opened.status, "open");
    assert.deepEqual(
      opened.entries.map((e) => e.employmentId),
      [h.workerAEmployment],
      "only the allowed subsidiary's reviews enter",
    );
    assert.ok(
      !opened.missing.some((m) => m.employmentId === h.workerBEmployment),
      "the other subsidiary's review is never named through the missing list — the fence cannot be probed",
    );
    // The in-scope entry decides normally.
    const entryA = opened.entries[0]!;
    const decided = await setCalibratedRating({
      orgId: h.org.orgId,
      actorId: h.hrA,
      entryId: entryA.id,
      calibratedRating: "4",
      justification: "evidence reviewed",
    });
    assert.equal(decided.calibratedRating, "4.0000");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("deciding and closing across the fence is refused", async () => {
  const h = await setupHarness();
  try {
    await submittedManagerReview(h, h.managerAUser, h.workerAEmployment);
    await submittedManagerReview(h, h.managerBUser, h.workerBEmployment);
    const draft = await createCalibrationSession({
      orgId: h.org.orgId,
      actorId: h.hrAll,
      cycleId: h.cycleId,
      name: "Fenced close",
    });
    const opened = await openCalibrationSession({ orgId: h.org.orgId, actorId: h.hrAll, id: draft.id });
    assert.equal(opened.entries.length, 2);
    const entryB = opened.entries.find((e) => e.employmentId === h.workerBEmployment)!;
    // Scoped HR cannot decide another subsidiary's entry, entry by entry.
    const decideError = perfError(await setCalibratedRating({
      orgId: h.org.orgId,
      actorId: h.hrA,
      entryId: entryB.id,
      calibratedRating: "4",
      justification: "evidence reviewed",
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(decideError.code, "NOT_FOUND");
    assert.match(decideError.message, /calibration entry was not found/);
    // …and cannot close a session holding decided out-of-scope entries.
    const entryA = opened.entries.find((e) => e.employmentId === h.workerAEmployment)!;
    await setCalibratedRating({
      orgId: h.org.orgId,
      actorId: h.hrAll,
      entryId: entryA.id,
      calibratedRating: "4",
      justification: "evidence reviewed",
    });
    await setCalibratedRating({
      orgId: h.org.orgId,
      actorId: h.hrAll,
      entryId: entryB.id,
      calibratedRating: "3",
      justification: "evidence reviewed",
    });
    const closeError = perfError(await closeCalibrationSession({
      orgId: h.org.orgId,
      actorId: h.hrA,
      id: draft.id,
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(closeError.code, "FORBIDDEN");
    assert.match(closeError.message, /outside your subsidiaries/);
    // Unrestricted HR closes cleanly.
    const closed = await closeCalibrationSession({ orgId: h.org.orgId, actorId: h.hrAll, id: draft.id });
    assert.equal(closed.status, "closed");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});
