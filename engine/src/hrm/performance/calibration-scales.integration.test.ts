import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import {
  enableHrm,
  grant,
  linkPerson,
  mkEmployment,
  mkReporting,
  mkReviewTemplate,
  perfError,
} from "../../testing/hrm-harness.ts";
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

async function setupScalesHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId, "hrmPerformance", "hrmCalibration");
  const hrId = await createScratchUser(org.orgId, "Scale HR", "scale_hr");
  await grant(org.orgId, hrId, ["hrm.performance.manage"]);
  const managerUser = await createScratchUser(org.orgId, "Scale Manager", "scale_manager");
  const managerParty = await linkPerson(org.orgId, managerUser);
  const managerEmployment = await mkEmployment(org.orgId, managerParty, org.subsidiaryId, {});
  const workerUser = await createScratchUser(org.orgId, "Scale Worker", "scale_worker");
  const workerParty = await linkPerson(org.orgId, workerUser);
  const workerEmployment = await mkEmployment(org.orgId, workerParty, org.subsidiaryId, {});
  await mkReporting(org.orgId, workerEmployment, managerEmployment);
  const templateId = await mkReviewTemplate(org.orgId, hrId);
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

test("decided ratings and potential keys validate against the cycle scales", async () => {
  const h = await setupScalesHarness();
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
  const h = await setupScalesHarness();
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
  const h = await setupScalesHarness();
  try {
    const templateId = (await db.execute<{ id: string }>(sql`
      insert into hrm_review_templates (org_id, name, rating_scale, created_by, updated_by)
      values (${h.org.orgId}, 'Labelless', '{"min": 1, "max": 3}'::jsonb, ${h.hrId}, ${h.hrId})
      returning id`)).rows[0]!.id;
    // openCycle requires a required question on the template; a text
    // question keeps the scale label-less, which is what this test probes.
    const labellessSection = (await db.execute<{ id: string }>(sql`
      insert into hrm_review_template_sections (org_id, template_id, position, title, kind, created_by, updated_by)
      values (${h.org.orgId}, ${templateId}, 0, 'Notes', 'competency', ${h.hrId}, ${h.hrId})
      returning id`)).rows[0]!.id;
    await db.execute(sql`
      insert into hrm_review_template_questions
        (org_id, section_id, position, prompt, answer_kind, required, created_by, updated_by)
      values (${h.org.orgId}, ${labellessSection}, 0, 'General notes', 'text', true, ${h.hrId}, ${h.hrId})
    `);
    const cycle = await createCycle({
      orgId: h.org.orgId,
      actorId: h.hrId,
      templateId,
      name: "FY26 labelless",
      periodStartOn: "2026-01-01",
      periodEndOn: "2026-12-31",
    });
    // Calibration sessions require a live cycle: the
    // label-less probe runs on an opened cycle, as the editor would.
    await openCycle({ orgId: h.org.orgId, actorId: h.hrId, cycleId: cycle.id });
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
