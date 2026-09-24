import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../testing/fixtures.ts";
import { AiRailsError } from "./errors.ts";
import { draftFromEvidence } from "./drafting.ts";

/**
 * C-80: a manager-review draft assembles the subject's shared calibrated
 * priors, so the HR override must stay inside the actor's allowed
 * employers — a restricted HR drafts only the subjects they cover, and a
 * cross-subsidiary draft refuses the whole draft with the remedy, never a
 * redacted half-draft. DB-owned (skips without OPENBOOKS_DB_URL, one file
 * at a time).
 *
 * Every refusal asserts its code AND its message: the message is the
 * entire product of a failing check.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableDrafting(orgId: string): Promise<void> {
  // hrmDrafting rides the hrm → hrmAiAssist parent chain: the whole chain
  // must be on, or the gate answers feature-off before any scope check.
  for (const feature of ["hrm", "hrmAiAssist", "hrmDrafting"]) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}, 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'`);
  }
}

async function restrictRole(orgId: string, roleKey: string, subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function linkPerson(orgId: string, userId: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${`Person ${partyId.slice(0, 8)}`}, true, '{}'::jsonb)`);
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

async function mkManagerReview(
  orgId: string,
  actorId: string,
  employmentId: string,
  subjectPartyId: string,
  reviewerPartyId: string,
  calibratedRating: string,
): Promise<string> {
  const templateId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_templates (org_id, name, rating_scale, created_by, updated_by)
    values (${orgId}, ${`Annual ${randomUUID().slice(0, 8)}`}, '{"min": 1, "max": 5}'::jsonb, ${actorId}, ${actorId})
    returning id`)).rows[0]!.id;
  const priorCycleId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_cycles (org_id, template_id, name, period_start_on, period_end_on)
    values (${orgId}, ${templateId}, 'FY25', '2025-01-01', '2025-12-31')
    returning id`)).rows[0]!.id;
  const cycleId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_cycles (org_id, template_id, name, period_start_on, period_end_on)
    values (${orgId}, ${templateId}, 'FY26', '2026-01-01', '2026-12-31')
    returning id`)).rows[0]!.id;
  // A prior-cycle shared calibrated review: the sensitive payload the
  // draft assembles, readable only inside the subject's subsidiary.
  await db.execute(sql`
    insert into hrm_reviews
      (org_id, cycle_id, employment_id, subject_party_id, reviewer_party_id, kind, status,
       overall_rating, calibrated_rating, calibration_reason, submitted_at, shared_at)
    values (${orgId}, ${priorCycleId}, ${employmentId}, ${subjectPartyId}, ${reviewerPartyId}, 'manager', 'shared',
            ${calibratedRating}, ${calibratedRating}, 'calibrated', now(), now())`);
  return (await db.execute<{ id: string }>(sql`
    insert into hrm_reviews
      (org_id, cycle_id, employment_id, subject_party_id, reviewer_party_id, kind, status)
    values (${orgId}, ${cycleId}, ${employmentId}, ${subjectPartyId}, ${reviewerPartyId}, 'manager', 'pending')
    returning id`)).rows[0]!.id;
}

async function decisionCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from ai_decisions
     where org_id = ${orgId} and capability_key = 'hrmDrafting'`)).rows;
  return Number(rows[0]?.n ?? 0);
}

test("a restricted HR drafts manager reviews only inside their legal-entity scope", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableDrafting(org.orgId);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    // B-side worker with a calibrated prior, reviewed by their manager.
    const worker = await createScratchUser(org.orgId, "Review Worker", "draft_worker");
    await grant(org.orgId, worker, ["hrm.self.read"]);
    const workerParty = await linkPerson(org.orgId, worker);
    const workerEmployment = await mkEmployment(org.orgId, workerParty, subB);
    const manager = await createScratchUser(org.orgId, "Review Manager", "draft_manager");
    await grant(org.orgId, manager, ["hrm.performance.manage"]);
    const managerParty = await linkPerson(org.orgId, manager);
    const reviewB = await mkManagerReview(
      org.orgId, manager, workerEmployment, workerParty, managerParty, "4.7500",
    );
    // HR-A holds the manage and retention grants but covers A only.
    const hrA = await createScratchUser(org.orgId, "Scoped HR A", "draft_hr_a");
    await grant(org.orgId, hrA, ["hrm.performance.manage", "hrm.retention.read"]);
    await linkPerson(org.orgId, hrA);
    await restrictRole(org.orgId, "draft_hr_a", [org.subsidiaryId]);

    // The cross-subsidiary draft refuses whole, names the remedy, and
    // writes no decision row — B's calibrated priors never reach A.
    const before = await decisionCount(org.orgId);
    await assert.rejects(
      draftFromEvidence(db, {
        orgId: org.orgId, actorId: hrA, kind: "review_manager", subjectId: reviewB,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AiRailsError);
        assert.equal(error.code, "ai_subject_refused");
        assert.match(error.message, /outside your allowed subsidiaries/);
        assert.match(error.message, /HR covering that subsidiary/);
        return true;
      },
    );
    assert.equal(await decisionCount(org.orgId), before, "a refused draft writes no decision row");

    // The assigned reviewer still drafts their own report's review, and
    // the outline carries the calibrated prior as evidence.
    const draft = await draftFromEvidence(db, {
      orgId: org.orgId, actorId: manager, kind: "review_manager", subjectId: reviewB,
    });
    assert.match(draft.text, /4\.75/, "the draft cites the prior calibrated rating");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
