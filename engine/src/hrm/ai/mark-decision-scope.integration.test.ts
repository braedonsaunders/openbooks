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
import { logDecision, markDecision } from "./governance.ts";

/**
 * Marking an AI decision outcome is recipient- or reviewer-only. Any other
 * holder of an HRM grant — a self-service employee recording 'accepted' on
 * another user's recruiting or performance decision, or a manager scoped to
 * a different legal entity — gets the uniform not-found, and the refusal
 * writes no ledger row.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

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

async function mkReview(
  orgId: string,
  actorId: string,
  employmentId: string,
  subjectPartyId: string,
  reviewerPartyId: string,
  kind: "self" | "manager",
): Promise<string> {
  const templateId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_templates (org_id, name, rating_scale, created_by, updated_by)
    values (${orgId}, ${`Annual ${randomUUID().slice(0, 8)}`}, '{"min": 1, "max": 5}'::jsonb, ${actorId}, ${actorId})
    returning id`)).rows[0]!.id;
  const cycleId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_cycles (org_id, template_id, name, period_start_on, period_end_on)
    values (${orgId}, ${templateId}, 'FY26', '2026-01-01', '2026-12-31')
    returning id`)).rows[0]!.id;
  return (await db.execute<{ id: string }>(sql`
    insert into hrm_reviews
      (org_id, cycle_id, employment_id, subject_party_id, reviewer_party_id, kind, status)
    values (${orgId}, ${cycleId}, ${employmentId}, ${subjectPartyId}, ${reviewerPartyId}, ${kind}, 'pending')
    returning id`)).rows[0]!.id;
}

async function logDraft(args: {
  orgId: string;
  actorId: string;
  subjectKind: string;
  subjectId: string;
}): Promise<string> {
  return logDecision(db, {
    orgId: args.orgId,
    actorId: args.actorId,
    capabilityKey: "hrmDrafting",
    subjectKind: args.subjectKind,
    subjectId: args.subjectId,
    input: `draftFromEvidence ${args.subjectKind} subject=${args.subjectId}`,
    output: "outline",
    outputSummary: `${args.subjectKind} draft from 1 cited sources`,
    sources: [{ kind: "hrm_review", id: args.subjectId }],
    outcome: "shown",
    model: "drafting-service",
  });
}

async function outcomeCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from ai_decisions
     where org_id = ${orgId} and outcome in ('accepted', 'edited', 'rejected')`)).rows;
  return Number(rows[0]?.n ?? 0);
}

async function assertMarkDenied(promise: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AiRailsError, `${label}: refusal must stay an AiRailsError`);
    assert.equal(error.code, "ai_decision_missing", `${label}: refusal must read as uniform not-found`);
    return true;
  }, label);
}

test("a self-service user cannot mark another user's decision; the recipient can", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const recipient = await createScratchUser(org.orgId, "Draft Recipient", "mark_recipient");
    await grant(org.orgId, recipient, ["hrm.self.read"]);
    const stranger = await createScratchUser(org.orgId, "Self Service Stranger", "mark_stranger");
    await grant(org.orgId, stranger, ["hrm.self.read"]);
    const recipientParty = await linkPerson(org.orgId, recipient);
    const employmentId = await mkEmployment(org.orgId, recipientParty, org.subsidiaryId);
    const reviewId = await mkReview(org.orgId, recipient, employmentId, recipientParty, recipientParty, "self");
    const decisionId = await logDraft({
      orgId: org.orgId,
      actorId: recipient,
      subjectKind: "review_self",
      subjectId: reviewId,
    });

    const before = await outcomeCount(org.orgId);
    await assertMarkDenied(
      markDecision(db, { orgId: org.orgId, actorId: stranger, decisionId, outcome: "accepted" }),
      "stranger marks another user's decision",
    );
    assert.equal(await outcomeCount(org.orgId), before, "a refused mark writes no ledger row");

    const marked = await markDecision(db, {
      orgId: org.orgId,
      actorId: recipient,
      decisionId,
      outcome: "accepted",
    });
    assert.ok(typeof marked === "string" && marked.length > 0, "the recipient records the outcome");
    assert.equal(await outcomeCount(org.orgId), before + 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a reviewer needs the grant, the subject relationship, and the subsidiary", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    // The authoring recipient: a worker whose manager drafts the review.
    const worker = await createScratchUser(org.orgId, "Review Worker", "mark_worker");
    await grant(org.orgId, worker, ["hrm.self.read"]);
    const workerParty = await linkPerson(org.orgId, worker);
    const workerEmployment = await mkEmployment(org.orgId, workerParty, org.subsidiaryId);
    // The assigned manager, unrestricted: the reviewer path's happy case.
    const manager = await createScratchUser(org.orgId, "Review Manager", "mark_manager");
    await grant(org.orgId, manager, ["hrm.performance.manage"]);
    const managerParty = await linkPerson(org.orgId, manager);
    const reviewId = await mkReview(org.orgId, manager, workerEmployment, workerParty, managerParty, "manager");
    const decisionId = await logDraft({
      orgId: org.orgId,
      actorId: manager,
      subjectKind: "review_manager",
      subjectId: reviewId,
    });

    // A self-service holder with no reviewer grant cannot mark even a
    // same-entity decision they did not author.
    await grant(org.orgId, worker, ["hrm.performance.read"]);
    await assertMarkDenied(
      markDecision(db, { orgId: org.orgId, actorId: worker, decisionId, outcome: "edited" }),
      "non-manager without the manage grant",
    );

    // The assigned manager marks in scope.
    const marked = await markDecision(db, {
      orgId: org.orgId,
      actorId: manager,
      decisionId,
      outcome: "edited",
    });
    assert.ok(marked.length > 0);

    // A manager restricted to the other entity holds the grant and the HR
    // relationship but not the subsidiary: still not-found.
    const workerBParty = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${workerBParty}, ${org.orgId}, 'person', 'Worker B', true, '{}'::jsonb)`);
    const workerBEmployment = await mkEmployment(org.orgId, workerBParty, subB);
    const reviewB = await mkReview(org.orgId, manager, workerBEmployment, workerBParty, managerParty, "manager");
    const decisionB = await logDraft({
      orgId: org.orgId,
      actorId: manager,
      subjectKind: "review_manager",
      subjectId: reviewB,
    });
    const scopedHr = await createScratchUser(org.orgId, "Scoped HR", "mark_scoped_hr");
    await grant(org.orgId, scopedHr, ["hrm.performance.manage", "hrm.retention.read"]);
    await restrictRole(org.orgId, "mark_scoped_hr", [org.subsidiaryId]);
    await assertMarkDenied(
      markDecision(db, { orgId: org.orgId, actorId: scopedHr, decisionId: decisionB, outcome: "accepted" }),
      "HR reviewer outside the subject's subsidiary",
    );
    // ...while the same reviewer marks the in-scope decision.
    const markedInScope = await markDecision(db, {
      orgId: org.orgId,
      actorId: scopedHr,
      decisionId,
      outcome: "accepted",
    });
    assert.ok(markedInScope.length > 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
