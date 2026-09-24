import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { HrmAuthorizationError } from "../authorization.ts";
import { createScratchUser } from "../../testing/fixtures.ts";
import { createCandidate } from "./candidates.ts";
import { createApplication } from "./applications.ts";
import { createOffer } from "./offers.ts";
import { scheduleInterview } from "./interviews.ts";
import { listTalentPools, listPoolMembers, createTalentPool, addPoolMember, rediscoverForRequisition } from "./pools.ts";
import { createKit, listKits } from "./kits.ts";
import { createRetentionRule, evaluateRetentionRule, listRetentionRules, listRetentionRuns } from "./retention.ts";
import { createOfferTemplate, listOfferTemplates, listOfferVersions, listOffersWithSignature, renderOfferVersion } from "./offers-signing.ts";
import { scorecardSummary } from "./scorecards.ts";
import {
  grantPermissions,
  openScopedReq,
  setupScopeHarness,
  teardownScopeHarness,
} from "./recruiting-scope-test-fixture.ts";

/**
 * H-RECRUIT-GRANTS: read-guarded routes were dead ends — the services
 * demanded manage, so readers got 403s. Read paths now carry read-level
 * authorization preserving employer scope; the scorecard summary returns a
 * read-safe projection (counts without panel-member names) to non-managers.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

test("H-RECRUIT-GRANTS: readers read shared config and history", { skip: !DB }, async () => {
  const h = await setupScopeHarness([
    "hrmRecruiting", "hrmTalentPool", "hrmStructuredInterviews", "hrmCandidateRetention", "hrmOfferSigning", "hrmJobBoards",
  ]);
  try {
    const orgId = h.org.orgId;
    const readerId = await createScratchUser(orgId, "Reader", "grants_reader");
    await grantPermissions(orgId, readerId, ["hrm.recruiting.read"]);

    const reqA = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role");
    const { candidate } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Ann A", email: "ann@example.test" });
    await createApplication({ orgId, actorId: h.adminId, requisitionId: reqA.id, candidateId: candidate.id });
    const pool = await createTalentPool({ orgId, actorId: h.adminId, name: "bench" });
    await createKit({ orgId, actorId: h.adminId, name: "kit" });
    const rule = await createRetentionRule({ orgId, actorId: h.adminId, name: "rule", basis: "inactivity", retainMonths: 12 });
    await evaluateRetentionRule({ orgId, actorId: h.adminId, ruleId: rule.id });
    await createOfferTemplate({ orgId, actorId: h.adminId, name: "letter", bodyTemplate: "Dear {{candidate_name}}" });

    assert.equal((await listTalentPools({ orgId, actorId: readerId })).length, 1, "pools list under read");
    assert.equal((await listKits({ orgId, actorId: readerId })).length, 1, "kits list under read");
    assert.equal((await listRetentionRules({ orgId, actorId: readerId })).length, 1, "rules list under read");
    assert.equal((await listRetentionRuns({ orgId, actorId: readerId, ruleId: rule.id })).length, 1, "runs list under read");
    assert.equal((await listOfferTemplates({ orgId, actorId: readerId })).length, 1, "templates list under read");
    assert.deepEqual(await listPoolMembers({ orgId, actorId: readerId, poolId: pool.id }), [], "empty pool lists under read");
  } finally {
    await teardownScopeHarness(h);
  }
});

test("H-RECRUIT-GRANTS: requisition-bound reads open under read with scope", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting", "hrmTalentPool", "hrmStructuredInterviews", "hrmOfferSigning"]);
  try {
    const orgId = h.org.orgId;
    const readerId = await createScratchUser(orgId, "Reader", "grants_reader2");
    await grantPermissions(orgId, readerId, ["hrm.recruiting.read"]);

    const reqA = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role");
    const reqB = await openScopedReq(orgId, h.adminId, h.subB, "B role");
    const { candidate: candA } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Ann A", email: "ann@example.test" });
    const { candidate: candB } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Bob B", email: "bob@example.test" });
    const appA = await createApplication({ orgId, actorId: h.adminId, requisitionId: reqA.id, candidateId: candA.id });
    const appB = await createApplication({ orgId, actorId: h.adminId, requisitionId: reqB.id, candidateId: candB.id });
    const offerA = await createOffer({
      orgId, actorId: h.adminId, applicationId: appA.id, employerSubsidiaryId: h.org.subsidiaryId,
      jobTitle: "A", proposedStartOn: "2026-10-01", compensationAmount: "1", compensationCurrency: "USD", compensationBasis: "annual",
    });
    await createOffer({
      orgId, actorId: h.adminId, applicationId: appB.id, employerSubsidiaryId: h.subB,
      jobTitle: "B", proposedStartOn: "2026-10-01", compensationAmount: "1", compensationCurrency: "USD", compensationBasis: "annual",
    });
    const template = await createOfferTemplate({ orgId, actorId: h.adminId, name: "letter", bodyTemplate: "Dear {{candidate_name}}" });
    await renderOfferVersion({ orgId, actorId: h.adminId, offerId: offerA.id, templateId: template.id });

    // Versions and the desk listing open under read, scoped per requisition.
    assert.equal((await listOfferVersions({ orgId, actorId: readerId, offerId: offerA.id })).length, 1);
    const desk = await listOffersWithSignature({ orgId, actorId: h.scopedId });
    assert.deepEqual(desk.map((row) => row.jobTitle), ["A"], "the desk shows only in-scope offers");
    // Scoped manage on the A requisition opens versions too (parity).
    assert.equal((await listOfferVersions({ orgId, actorId: h.scopedId, offerId: offerA.id })).length, 1);
    const offerB = (await db.execute<{ id: string }>(sql`
      select o.id from hrm_offers o
        join hrm_applications a on a.org_id = o.org_id and a.id = o.application_id
       where o.org_id = ${orgId} and o.job_title = 'B'`)).rows[0]!.id;
    await assert.rejects(
      listOfferVersions({ orgId, actorId: h.scopedId, offerId: offerB }),
      (error: unknown) => error instanceof HrmAuthorizationError,
      "versions on an out-of-scope offer refuse",
    );

    // Rediscovery matches under read on the target requisition.
    const pool = await createTalentPool({ orgId, actorId: h.adminId, name: "bench" });
    await addPoolMember({ orgId, actorId: h.adminId, poolId: pool.id, candidateId: candA.id });
    await db.execute(sql`update hrm_candidates set tags = '{\"rust\"}' where org_id = ${orgId} and id = ${candA.id}`);
    const matches = await rediscoverForRequisition({
      orgId, actorId: readerId, poolId: pool.id, requisitionId: reqA.id, requisitionTags: ["rust"],
    });
    assert.equal(matches.length, 1, "rediscovery runs under read");
    assert.equal(matches[0]!.candidateId, candA.id);
  } finally {
    await teardownScopeHarness(h);
  }
});

test("H-RECRUIT-GRANTS: the summary projects safely for readers", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting", "hrmStructuredInterviews"]);
  try {
    const orgId = h.org.orgId;
    const readerId = await createScratchUser(orgId, "Reader", "grants_reader3");
    await grantPermissions(orgId, readerId, ["hrm.recruiting.read"]);

    // One seated panel member with an outstanding verdict.
    const panelPartyId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${panelPartyId}, ${orgId}, 'person', 'Panelist Pam', true, '{}'::jsonb)`);
    const employmentId = randomUUID();
    await db.execute(sql`
      insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
      values (${employmentId}, ${orgId}, ${panelPartyId}, ${h.org.subsidiaryId}, 1)`);
    await db.execute(sql`
      insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from)
      values (${orgId}, ${employmentId}, 1, 'active', '2026-07-01'::date)`);

    const reqA = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role");
    const { candidate } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Ann A", email: "ann@example.test" });
    const app = await createApplication({ orgId, actorId: h.adminId, requisitionId: reqA.id, candidateId: candidate.id });
    // Scorecard shells exist only on kitted sittings (pre-existing HR-18
    // shape): without a kit there are no drafts and the summary is empty
    // for every viewer, which would assert nothing about the projection.
    const kit = await createKit({ orgId, actorId: h.adminId, name: "panel kit" });
    const interview = await scheduleInterview({
      orgId, actorId: h.adminId, applicationId: app.id, kind: "video",
      scheduledAt: "2026-09-25T14:00:00Z", durationMinutes: 30, panelPartyIds: [panelPartyId], kitId: kit.id,
    });

    const full = await scorecardSummary({ orgId, actorId: h.adminId, interviewId: interview.id });
    assert.deepEqual(full.missing, ["Panelist Pam"], "managers see whose verdict is outstanding");
    const projected = await scorecardSummary({ orgId, actorId: readerId, interviewId: interview.id });
    assert.deepEqual(projected.missing, [], "readers get counts, never panel-member names");
    assert.equal(projected.totalCount, full.totalCount, "the projection keeps the counts");
    assert.equal(projected.submittedCount, full.submittedCount);
  } finally {
    await teardownScopeHarness(h);
  }
});
