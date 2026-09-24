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
  calibrationPotentialOptions,
  createCalibrationSession,
  getCalibrationSession,
  openCalibrationSession,
  setCalibratedRating,
  setPotential,
} from "./calibration.ts";

/**
 * Calibration scale validation over the real 0228 tables — DB-owned, one
 * file at a time. No skip guards: the integration partition guarantees a
 * database.
 *
 * Close writes decided ratings and potential keys into the review, so
 * off-scale values are refused at decision time against the cycle's
 * declared scales — never stored first and validated later. Every refusal
 * asserts its code AND its message.
 */

type Harness = {
  org: ScratchOrg;
  hrId: string;
  managerUser: string;
  workerEmployment: string;
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
  const hrId = await createScratchUser(org.orgId, "Scale HR", "scale_hr");
  await grant(org.orgId, hrId, ["hrm.performance.manage"]);
  const managerUser = await createScratchUser(org.orgId, "Scale Manager", "scale_manager");
  const managerParty = await linkPerson(org.orgId, managerUser);
  const managerEmployment = await mkEmployment(org.orgId, managerParty, org.subsidiaryId);
  const workerUser = await createScratchUser(org.orgId, "Scale Worker", "scale_worker");
  const workerParty = await linkPerson(org.orgId, workerUser);
  const workerEmployment = await mkEmployment(org.orgId, workerParty, org.subsidiaryId);
  await db.execute(sql`
    insert into reporting_relationships
      (org_id, employment_id, manager_employment_id, kind, relationship_id, version_no, effective_from)
    values (${org.orgId}, ${workerEmployment}, ${managerEmployment}, 'line', ${randomUUID()}, 1, '2020-01-01'::date)
  `);
  const templateId = await mkTemplate(org.orgId, hrId);
  const cycle = await createCycle({
    orgId: org.orgId,
    actorId: hrId,
    templateId,
    name: "FY26",
    periodStartOn: "2026-01-01",
    periodEndOn: "2026-12-31",
  });
  await openCycle({ orgId: org.orgId, actorId: hrId, cycleId: cycle.id });
  return { org, hrId, managerUser, workerEmployment, cycleId: cycle.id };
}

async function openEntryId(h: Harness): Promise<string> {
  const reviewId = (await db.execute<{ id: string }>(sql`
    select id from hrm_reviews
     where org_id = ${h.org.orgId} and cycle_id = ${h.cycleId}
       and employment_id = ${h.workerEmployment} and kind = 'manager'`)).rows[0]!.id;
  const impact = (await db.execute<{ id: string }>(sql`
    select id from hrm_review_answers where org_id = ${h.org.orgId} and review_id = ${reviewId}
     order by position limit 1`)).rows[0]!.id;
  await submitReview({
    orgId: h.org.orgId,
    actorId: h.managerUser,
    reviewId,
    answers: [{ answerId: impact, rating: "4", text: "solid quarter" }],
    overallRating: "4",
  });
  const draft = await createCalibrationSession({
    orgId: h.org.orgId,
    actorId: h.hrId,
    cycleId: h.cycleId,
    name: "Scale session",
  });
  const opened = await openCalibrationSession({ orgId: h.org.orgId, actorId: h.hrId, id: draft.id });
  assert.equal(opened.entries.length, 1);
  return opened.entries[0]!.id;
}

function perfError(error: unknown): HrmPerformanceError {
  assert.ok(error instanceof HrmPerformanceError, `expected HrmPerformanceError, got ${String(error)}`);
  return error;
}

test("decided ratings and potential keys validate against the cycle scales", async () => {
  const h = await setupHarness();
  try {
    const entryId = await openEntryId(h);
    // Off-scale and non-numeric ratings name the scale.
    for (const bad of ["9", "0", "abc"]) {
      const error = perfError(await setCalibratedRating({
        orgId: h.org.orgId,
        actorId: h.hrId,
        entryId,
        calibratedRating: bad,
        justification: "evidence reviewed",
      }).then(
        () => null,
        (e: unknown) => e,
      ));
      assert.equal(error.code, "REFUSED", `rating ${bad} must be refused`);
      assert.match(error.message, /outside the template scale 1 to 5|must be a decimal rating/);
    }
    // Free-text potential names the declared labels.
    const potentialError = perfError(await setPotential({
      orgId: h.org.orgId,
      actorId: h.hrId,
      entryId,
      potentialKey: "cosmic",
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(potentialError.code, "REFUSED");
    assert.match(potentialError.message, /"low", "high"/);
    // Nothing was stored by the refusals.
    const stored = (await db.execute<{ rating: string | null; potential: string | null }>(sql`
      select calibrated_rating::text as rating, potential_key as potential
        from hrm_calibration_entries where org_id = ${h.org.orgId} and id = ${entryId}`)).rows[0]!;
    assert.equal(stored.rating, null);
    assert.equal(stored.potential, null);
    // In-scale values decide normally.
    const decided = await setCalibratedRating({
      orgId: h.org.orgId,
      actorId: h.hrId,
      entryId,
      calibratedRating: "4",
      justification: "evidence reviewed",
    });
    assert.equal(decided.calibratedRating, "4.0000");
    await setPotential({ orgId: h.org.orgId, actorId: h.hrId, entryId, potentialKey: "high" });
    const sessionId = (await db.execute<{ sessionId: string }>(sql`
      select session_id as "sessionId" from hrm_calibration_entries
       where org_id = ${h.org.orgId} and id = ${entryId}`)).rows[0]!.sessionId;
    const session = await getCalibrationSession({ orgId: h.org.orgId, actorId: h.hrId, id: sessionId });
    assert.equal(session.entries[0]!.potentialKey, "high");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("the calibration editor offers the cycle scale labels and saves one", async () => {
  // F3-34: the editor's options come from the same template labels
  // setPotential enforces, so an offered option always saves.
  const h = await setupHarness();
  try {
    const entryId = await openEntryId(h);
    const sessionId = (await db.execute<{ sessionId: string }>(sql`
      select session_id as "sessionId" from hrm_calibration_entries
       where org_id = ${h.org.orgId} and id = ${entryId}`)).rows[0]!.sessionId;
    assert.deepEqual(await calibrationPotentialOptions({ orgId: h.org.orgId, actorId: h.hrId, sessionId }), [
      "low",
      "high",
    ]);
    await setPotential({ orgId: h.org.orgId, actorId: h.hrId, entryId, potentialKey: "high" });
    const session = await getCalibrationSession({ orgId: h.org.orgId, actorId: h.hrId, id: sessionId });
    assert.equal(session.entries[0]!.potentialKey, "high");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});

test("a template with no scale labels offers no potential options", async () => {
  // F3-34: the missing arm degrades openly — the editor offers nothing
  // instead of inventing options the server would refuse.
  const h = await setupHarness();
  try {
    const templateId = (await db.execute<{ id: string }>(sql`
      insert into hrm_review_templates (org_id, name, rating_scale, created_by, updated_by)
      values (${h.org.orgId}, 'Labelless', '{"min": 1, "max": 3}'::jsonb, ${h.hrId}, ${h.hrId})
      returning id`)).rows[0]!.id;
    const cycle = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrId,
      templateId,
      name: "FY26 labelless",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-12-31",
    });
    const session = await createCalibrationSession({
      orgId: h.org.orgId,
      actorId: h.hrId,
      cycleId: cycle.id,
      name: "Labelless session",
    });
    assert.deepEqual(
      await calibrationPotentialOptions({ orgId: h.org.orgId, actorId: h.hrId, sessionId: session.id }),
      [],
    );
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});
