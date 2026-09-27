import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { countRows, refusal, scopeMatrix, scopeRow, type ScopeWorld } from "../../testing/hrm-scope-matrix.ts";
import { UNRESTRICTED_SCOPE_REQUIRED, UnrestrictedScopeError } from "../../organization/subsidiary-scope.ts";
import { HrmAuthorizationError } from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { DuplicateProspectError, createCandidate } from "./candidates.ts";
import { createApplication, rejectApplication } from "./applications.ts";
import { createRequisition, openRequisition } from "./requisitions.ts";
import { createPosition } from "../positions.ts";
import { createOffer } from "./offers.ts";
import { scheduleInterview } from "./interviews.ts";
import { listPostings, publishPosting } from "./postings.ts";
import { createKit, listKits } from "./kits.ts";
import { getCandidateDetail } from "./recruiting-read.ts";
import { scorecardSummary } from "./scorecards.ts";
import { addPoolMember, createTalentPool, listPoolMembers, listTalentPools, rediscoverForRequisition, removePoolMember, tagCandidate } from "./pools.ts";
import { createOfferTemplate, listOfferTemplates, listOfferVersions, listOffersWithSignature, renderOfferVersion } from "./offers-signing.ts";
import {
  ANONYMIZED_DISPLAY_NAME,
  createRetentionRule,
  evaluateRetentionRule,
  listCandidateConsents,
  listRetentionRules,
  listRetentionRuns,
  recordConsent,
  withdrawConsent,
} from "./retention.ts";

/**
 * Recruiting under a legal-entity lens. A scoped recruiter owns a candidate
 * only through an application on an in-scope requisition; every read and
 * mutation of a candidate they do not own refuses with the not-found code
 * an unknown id gets, so a refusal never confirms another entity's pipeline
 * exists. Shared
 * configuration is org-keyed and needs unrestricted scope to write.
 */

const PERMISSIONS = ["hrm.recruiting.read", "hrm.recruiting.manage"];
const READER = { scope: "direct", permissions: ["hrm.recruiting.read"] } as const;

async function openReq(w: ScopeWorld, subsidiaryId: string, title: string, positionId?: string) {
  const draft = await createRequisition({ orgId: w.orgId, actorId: w.admin, title, employerSubsidiaryId: subsidiaryId, headcount: 1, positionId });
  return openRequisition({ orgId: w.orgId, actorId: w.admin, requisitionId: draft.id });
}

async function candidate(w: ScopeWorld, displayName: string, extra: { phone?: string } = {}) {
  const email = `${displayName.split(" ")[0]!.toLowerCase()}@example.test`;
  return (await createCandidate({ orgId: w.orgId, actorId: w.admin, displayName, email, ...extra })).candidate;
}

/** Ann applied to an A requisition and Bob to a B one, both through the admin. */
async function pipeline(w: ScopeWorld, extra: { phones?: boolean } = {}) {
  const reqA = await openReq(w, w.subA, "A role");
  const reqB = await openReq(w, w.subB, "B role");
  const candA = await candidate(w, "Ann A", extra.phones ? { phone: "+1-555-0001" } : {});
  const candB = await candidate(w, "Bob B", extra.phones ? { phone: "+1-555-0002" } : {});
  const appA = await createApplication({ orgId: w.orgId, actorId: w.admin, requisitionId: reqA.id, candidateId: candA.id });
  const appB = await createApplication({ orgId: w.orgId, actorId: w.admin, requisitionId: reqB.id, candidateId: candB.id });
  return { reqA, reqB, candA, candB, appA, appB };
}

async function notFound(promise: Promise<unknown>, what: string): Promise<RecruitingError> {
  const error = await refusal(promise, RecruitingError);
  assert.equal(error.code, "NOT_FOUND", `${what}: scope denials are uniform with not-found`);
  return error;
}

async function displayName(orgId: string, candidateId: string): Promise<string | null> {
  return (await db.execute<{ displayName: string }>(sql`
    select display_name as "displayName" from hrm_candidates where org_id = ${orgId} and id = ${candidateId}`)).rows[0]?.displayName ?? null;
}

async function pooled(w: ScopeWorld) {
  const seeded = await pipeline(w);
  const pool = await createTalentPool({ orgId: w.orgId, actorId: w.admin, name: "bench" });
  await addPoolMember({ orgId: w.orgId, actorId: w.admin, poolId: pool.id, candidateId: seeded.candA.id, note: "strong" });
  await addPoolMember({ orgId: w.orgId, actorId: w.admin, poolId: pool.id, candidateId: seeded.candB.id, note: "backup" });
  return { ...seeded, pool };
}

/** An open position; seeding one is positions-domain work under its own grant. */
function position(w: ScopeWorld, code: string, employerSubsidiaryId: string) {
  return createPosition({
    orgId: w.orgId, actorId: w.admin, positionCode: code, title: "Engineer", employerSubsidiaryId,
    plannedFte: "1.0000", status: "open", effectiveFrom: "2026-07-01", reason: "entity seed",
  });
}

async function application(w: ScopeWorld, requisitionId: string) {
  const ann = await candidate(w, "Ann A");
  return createApplication({ orgId: w.orgId, actorId: w.admin, requisitionId, candidateId: ann.id });
}

const offerTerms = (employerSubsidiaryId: string) => ({
  employerSubsidiaryId, jobTitle: "Backend engineer", proposedStartOn: "2026-10-01",
  compensationAmount: "120000", compensationCurrency: "USD", compensationBasis: "annual" as const,
});

scopeMatrix([
  scopeRow({
    name: "the postings list shows a scoped reader only in-scope openings",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    seed: async (w) => {
      const reqA = await openReq(w, w.subA, "A role");
      const reqB = await openReq(w, w.subB, "B role");
      for (const req of [reqA, reqB]) await publishPosting({ orgId: w.orgId, actorId: w.admin, requisitionId: req.id, boardKey: "internal" });
      return { reqA, reqB };
    },
    read: async (w, { reqA, reqB }) => {
      const scoped = await listPostings({ orgId: w.orgId, actorId: w.scoped });
      assert.deepEqual(scoped.map((posting) => posting.requisitionId), [reqA.id], "the B posting never lists to an A-scoped reader");
      assert.deepEqual(await listPostings({ orgId: w.orgId, actorId: w.scoped, requisitionId: reqB.id }), [], "filtering to an out-of-scope opening yields nothing");
      assert.equal((await listPostings({ orgId: w.orgId, actorId: w.admin })).length, 2, "unrestricted readers list the whole board");
    },
  }),
  scopeRow({
    name: "shared recruiting configuration needs unrestricted scope to write",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    write: async (w) => {
      const writes = (actorId: string) => ({
        letter: () => createOfferTemplate({ orgId: w.orgId, actorId, name: "letter", bodyTemplate: "Dear {{candidate_name}}" }),
        kit: () => createKit({ orgId: w.orgId, actorId, name: "kit" }),
        rule: () => createRetentionRule({ orgId: w.orgId, actorId, name: "rule", basis: "inactivity", retainMonths: 6 }),
      });
      for (const [name, write] of Object.entries(writes(w.scoped))) {
        const error = await refusal(write(), UnrestrictedScopeError);
        assert.equal(error.message, UNRESTRICTED_SCOPE_REQUIRED, `${name}: the canonical 403 body`);
      }
      for (const [name, write] of Object.entries(writes(w.admin))) {
        assert.equal((await write()).name, name, `${name}: the unrestricted admin still writes`);
      }
    },
  }),
  scopeRow({
    name: "consent record, withdraw and list need ownership of the candidate",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    seed: async (w) => {
      const seeded = await pipeline(w);
      await recordConsent({ orgId: w.orgId, actorId: w.admin, candidateId: seeded.candB.id, purpose: "future_roles" });
      return seeded;
    },
    write: async (w, { candA, candB }) => {
      const orgId = w.orgId;
      await notFound(recordConsent({ orgId, actorId: w.scoped, candidateId: candB.id, purpose: "talent_pool" }), "record");
      await notFound(withdrawConsent({ orgId, actorId: w.scoped, candidateId: candB.id, purpose: "future_roles" }), "withdraw");
      await notFound(listCandidateConsents({ orgId, actorId: w.scoped, candidateId: candB.id }), "list");
      const status = await listCandidateConsents({ orgId, actorId: w.admin, candidateId: candB.id });
      assert.deepEqual(status.consents.map((consent) => consent.purpose), ["future_roles"], "the refused record consent landed nowhere");

      const consent = await recordConsent({ orgId, actorId: w.scoped, candidateId: candA.id, purpose: "future_roles" });
      assert.equal(consent.candidateId, candA.id);
      await withdrawConsent({ orgId, actorId: w.scoped, candidateId: candA.id, purpose: "future_roles" });
      const listed = await listCandidateConsents({ orgId, actorId: w.scoped, candidateId: candA.id });
      assert.equal(listed.consents.length, 1, "the withdrawn row stays as evidence");
    },
  }),
  scopeRow({
    name: "a B candidate cannot be attached to an A requisition",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    write: async (w) => {
      const orgId = w.orgId;
      const reqA = await openReq(w, w.subA, "A role");
      const reqB = await openReq(w, w.subB, "B role");
      const candB = await candidate(w, "Bob B");
      await createApplication({ orgId, actorId: w.admin, requisitionId: reqB.id, candidateId: candB.id });

      const error = await notFound(createApplication({ orgId, actorId: w.scoped, requisitionId: reqA.id, candidateId: candB.id }), "attach");
      assert.equal(error.message, "candidate is not visible in this organization — check the reference", "indistinguishable from an unknown id");
      assert.equal(await countRows(sql`from hrm_applications where org_id = ${orgId} and requisition_id = ${reqA.id}`), 0, "the refused attach wrote no row");

      // A fresh prospect with no applications anywhere: the in-scope opening establishes first ownership.
      const fresh = await candidate(w, "New N");
      assert.equal((await createApplication({ orgId, actorId: w.scoped, requisitionId: reqA.id, candidateId: fresh.id })).candidateId, fresh.id);
      // An already-owned candidate re-attaches to a second in-scope opening.
      const candA = await candidate(w, "Ann A");
      await createApplication({ orgId, actorId: w.admin, requisitionId: reqA.id, candidateId: candA.id });
      const reqA2 = await openReq(w, w.subA, "A role 2");
      assert.equal((await createApplication({ orgId, actorId: w.scoped, requisitionId: reqA2.id, candidateId: candA.id })).candidateId, candA.id);
    },
  }),
  scopeRow({
    name: "an out-of-scope duplicate or merge refuses like an unknown candidate",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    write: async (w) => {
      const orgId = w.orgId;
      const reqB = await openReq(w, w.subB, "B role");
      const survivor = await candidate(w, "Bea B");
      await createApplication({ orgId, actorId: w.admin, requisitionId: reqB.id, candidateId: survivor.id });
      // A scoped actor guessing the survivor's email or id learns nothing.
      for (const mergeInto of [undefined, survivor.id]) {
        const error = await notFound(createCandidate({ orgId, actorId: w.scoped, displayName: "Bea Clone", email: "bea@example.test", mergeInto }), "duplicate");
        assert.ok(!error.message.includes("Bea B"), "the denial names no identity");
      }
      // The unrestricted admin owns every candidate, so the merge attaches.
      const merged = await createCandidate({ orgId, actorId: w.admin, displayName: "Bea Clone", email: "bea@example.test", mergeInto: survivor.id });
      assert.equal(merged.mergedInto!.id, survivor.id, "no new record: the survivor attaches");
    },
  }),
  scopeRow({
    name: "an in-scope duplicate keeps the structural retry without the survivor's name",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    write: async (w) => {
      const first = await candidate(w, "Ada Original");
      const error = await refusal(createCandidate({ orgId: w.orgId, actorId: w.admin, displayName: "Ada Clone", email: "ADA@example.test" }), DuplicateProspectError, /mergeInto/);
      assert.equal(error.code, "REFUSED");
      assert.equal(error.candidateId, first.id, "the retry reference rides structurally");
      assert.ok(!error.message.includes("Ada Original"), "the survivor's name never rides the refusal");
    },
  }),
  scopeRow({
    name: "a scoped retention run anonymizes only in-scope candidates",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    write: async (w) => {
      const orgId = w.orgId;
      const { candA, candB, appA, appB } = await pipeline(w);
      const lapsed = new Date(Date.now() - 24 * 3_600_000).toISOString();
      for (const [app, cand] of [[appA, candA], [appB, candB]] as const) {
        await rejectApplication({ orgId, actorId: w.admin, applicationId: app.id, reason: "not a fit" });
        await recordConsent({ orgId, actorId: w.admin, candidateId: cand.id, purpose: "future_roles", expiresAt: lapsed });
      }
      const rule = await createRetentionRule({ orgId, actorId: w.admin, name: "lapsed consents", basis: "consent", retainMonths: 1, action: "anonymize" });

      assert.equal((await evaluateRetentionRule({ orgId, actorId: w.scoped, ruleId: rule.id })).candidatesAnonymized, 1);
      assert.equal(await displayName(orgId, candA.id), ANONYMIZED_DISPLAY_NAME);
      assert.equal(await displayName(orgId, candB.id), "Bob B");
      // The system tick's explicit sentinel covers the whole org; A is still due, so it is re-processed with B.
      const full = await evaluateRetentionRule({ orgId, actorId: w.admin, ruleId: rule.id }, { runner: { kind: "system" } });
      assert.equal(full.candidatesAnonymized, 2);
      assert.equal(await displayName(orgId, candB.id), ANONYMIZED_DISPLAY_NAME);
    },
  }),
  scopeRow({
    name: "running a retention rule needs the manage grant unless the system job runs it",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    actors: { admin: { scope: "all" }, reader: READER },
    write: async (w) => {
      const rule = await createRetentionRule({ orgId: w.orgId, actorId: w.admin, name: "stale prospects", basis: "inactivity", retainMonths: 12, action: "anonymize" });
      await refusal(evaluateRetentionRule({ orgId: w.orgId, actorId: w.reader, ruleId: rule.id }), HrmAuthorizationError);
      const run = await evaluateRetentionRule({ orgId: w.orgId, actorId: w.reader, ruleId: rule.id }, { runner: { kind: "system" } });
      assert.equal(run.candidatesAnonymized, 0);
    },
  }),
  scopeRow({
    name: "a scoped reader sees candidate PII only through in-scope requisitions",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    seed: (w) => pipeline(w, { phones: true }),
    read: async (w, { candA, candB }) => {
      const seen = await getCandidateDetail({ orgId: w.orgId, actorId: w.scoped, candidateId: candA.id });
      assert.equal(seen.email, "ann@example.test", "owned candidates show PII to grant holders");
      assert.equal(seen.applications.length, 1, "only the in-scope application renders");
      const error = await notFound(getCandidateDetail({ orgId: w.orgId, actorId: w.scoped, candidateId: candB.id }), "detail");
      assert.equal(error.message, "candidate is not visible in this organization", "the message names no entity");
      assert.equal((await getCandidateDetail({ orgId: w.orgId, actorId: w.admin, candidateId: candB.id })).email, "bob@example.test");
    },
  }),
  scopeRow({
    name: "a candidate attached to both entities shows only the reader's slice",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    read: async (w) => {
      const reqA = await openReq(w, w.subA, "A role");
      const reqB = await openReq(w, w.subB, "B role");
      const dual = await candidate(w, "Dual D");
      const appA = await createApplication({ orgId: w.orgId, actorId: w.admin, requisitionId: reqA.id, candidateId: dual.id });
      await createApplication({ orgId: w.orgId, actorId: w.admin, requisitionId: reqB.id, candidateId: dual.id });
      const seen = await getCandidateDetail({ orgId: w.orgId, actorId: w.scoped, candidateId: dual.id });
      assert.equal(seen.email, "dual@example.test", "ownership through A opens PII");
      assert.deepEqual(seen.applications.map((entry) => entry.applicationId), [appA.id], "the B slice never rides an A-scoped read");
    },
  }),
  scopeRow({
    name: "a pool-shared candidate renders identity-only to scoped readers",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    read: async (w) => {
      const reqB = await openReq(w, w.subB, "B role");
      const shared = await candidate(w, "Pooled P");
      await createApplication({ orgId: w.orgId, actorId: w.admin, requisitionId: reqB.id, candidateId: shared.id });
      const pool = await createTalentPool({ orgId: w.orgId, actorId: w.admin, name: "bench" });
      await addPoolMember({ orgId: w.orgId, actorId: w.admin, poolId: pool.id, candidateId: shared.id });
      const seen = await getCandidateDetail({ orgId: w.orgId, actorId: w.scoped, candidateId: shared.id });
      assert.equal(seen.displayName, "Pooled P", "pool sharing opens identity");
      assert.deepEqual([seen.email, seen.phone, seen.resumeAttachmentId], [null, null, null], "pool sharing never opens contact PII");
      assert.deepEqual(seen.applications, [], "the B funnel never rides an A-scoped read");
    },
  }),
  scopeRow({
    name: "pool members and rediscovery list only owned candidates",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    seed: pooled,
    read: async (w, { pool, candA, candB, reqA }) => {
      const members = await listPoolMembers({ orgId: w.orgId, actorId: w.scoped, poolId: pool.id });
      assert.deepEqual(members.map((member) => member.displayName), ["Ann A"], "the B member never enumerates to an A-scoped reader");
      assert.equal((await listPoolMembers({ orgId: w.orgId, actorId: w.admin, poolId: pool.id })).length, 2, "unrestricted readers list the whole pool");
      for (const cand of [candA, candB]) await tagCandidate({ orgId: w.orgId, actorId: w.admin, candidateId: cand.id, tags: ["rust"] });
      const matches = await rediscoverForRequisition({ orgId: w.orgId, actorId: w.scoped, poolId: pool.id, requisitionId: reqA.id, requisitionTags: ["RUST"] });
      assert.deepEqual(matches.map((match) => [match.candidateId, match.displayName]), [[candA.id, "Ann A"]]);
    },
  }),
  scopeRow({
    name: "pool add, remove and tag need ownership of the candidate",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    seed: pooled,
    write: async (w, { pool, candA, candB }) => {
      const orgId = w.orgId;
      await notFound(addPoolMember({ orgId, actorId: w.scoped, poolId: pool.id, candidateId: candB.id }), "add");
      await notFound(removePoolMember({ orgId, actorId: w.scoped, poolId: pool.id, candidateId: candB.id }), "remove");
      await notFound(tagCandidate({ orgId, actorId: w.scoped, candidateId: candB.id, tags: ["x"] }), "tag");
      assert.equal((await listPoolMembers({ orgId, actorId: w.admin, poolId: pool.id })).length, 2, "refused mutations wrote nothing");

      const duplicate = await refusal(addPoolMember({ orgId, actorId: w.scoped, poolId: pool.id, candidateId: candA.id }), RecruitingError);
      assert.equal(duplicate.code, "REFUSED", "re-adding the owned candidate names the duplicate rule, not a scope denial");
      await removePoolMember({ orgId, actorId: w.scoped, poolId: pool.id, candidateId: candA.id });
      assert.deepEqual(await tagCandidate({ orgId, actorId: w.scoped, candidateId: candA.id, tags: ["hot"] }), ["hot"]);
    },
  }),
  scopeRow({
    name: "readers list shared recruiting configuration and history",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    actors: { admin: { scope: "all" }, reader: READER },
    read: async (w) => {
      const orgId = w.orgId;
      const reqA = await openReq(w, w.subA, "A role");
      const ann = await candidate(w, "Ann A");
      await createApplication({ orgId, actorId: w.admin, requisitionId: reqA.id, candidateId: ann.id });
      const pool = await createTalentPool({ orgId, actorId: w.admin, name: "bench" });
      await createKit({ orgId, actorId: w.admin, name: "kit" });
      const rule = await createRetentionRule({ orgId, actorId: w.admin, name: "rule", basis: "inactivity", retainMonths: 12 });
      await evaluateRetentionRule({ orgId, actorId: w.admin, ruleId: rule.id });
      await createOfferTemplate({ orgId, actorId: w.admin, name: "letter", bodyTemplate: "Dear {{candidate_name}}" });

      const actorId = w.reader;
      assert.equal((await listTalentPools({ orgId, actorId })).length, 1, "pools list under read");
      assert.equal((await listKits({ orgId, actorId })).length, 1, "kits list under read");
      assert.equal((await listRetentionRules({ orgId, actorId })).length, 1, "rules list under read");
      assert.equal((await listRetentionRuns({ orgId, actorId, ruleId: rule.id })).length, 1, "runs list under read");
      assert.equal((await listOfferTemplates({ orgId, actorId })).length, 1, "templates list under read");
      assert.deepEqual(await listPoolMembers({ orgId, actorId, poolId: pool.id }), [], "empty pool lists under read");
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,hrmRecruiting}', 'false'::jsonb, true) where id = ${orgId}`);
      await assert.rejects(createCandidate({ orgId, actorId: w.admin, displayName: "Disabled", email: "disabled@example.test" }), /Recruiting is off/);
    },
  }),
  scopeRow({
    name: "requisition-bound reads open under the read grant with scope",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    actors: { admin: { scope: "all" }, scoped: { scope: "A" }, reader: READER },
    read: async (w) => {
      const orgId = w.orgId;
      const { reqA, candA, appA, appB } = await pipeline(w);
      const offer = (applicationId: string, employerSubsidiaryId: string, jobTitle: string) => createOffer({
        orgId, actorId: w.admin, applicationId, employerSubsidiaryId, jobTitle,
        proposedStartOn: "2026-10-01", compensationAmount: "1", compensationCurrency: "USD", compensationBasis: "annual",
      });
      const offerA = await offer(appA.id, w.subA, "A");
      const offerB = await offer(appB.id, w.subB, "B");
      const template = await createOfferTemplate({ orgId, actorId: w.admin, name: "letter", bodyTemplate: "Dear {{candidate_name}}" });
      await renderOfferVersion({ orgId, actorId: w.admin, offerId: offerA.id, templateId: template.id });

      assert.equal((await listOfferVersions({ orgId, actorId: w.reader, offerId: offerA.id })).length, 1);
      const desk = await listOffersWithSignature({ orgId, actorId: w.scoped });
      assert.deepEqual(desk.map((row) => row.jobTitle), ["A"], "the desk shows only in-scope offers");
      assert.equal((await listOfferVersions({ orgId, actorId: w.scoped, offerId: offerA.id })).length, 1, "scoped manage opens in-scope versions");
      await refusal(listOfferVersions({ orgId, actorId: w.scoped, offerId: offerB.id }), HrmAuthorizationError);

      const pool = await createTalentPool({ orgId, actorId: w.admin, name: "bench" });
      await addPoolMember({ orgId, actorId: w.admin, poolId: pool.id, candidateId: candA.id });
      await db.execute(sql`update hrm_candidates set tags = '{"rust"}' where org_id = ${orgId} and id = ${candA.id}`);
      const matches = await rediscoverForRequisition({ orgId, actorId: w.reader, poolId: pool.id, requisitionId: reqA.id, requisitionTags: ["rust"] });
      assert.deepEqual(matches.map((match) => match.candidateId), [candA.id], "rediscovery runs under read");
    },
  }),
  scopeRow({
    name: "the scorecard summary projects counts without panel names to readers",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    actors: { admin: { scope: "all" }, reader: READER },
    read: async (w) => {
      const orgId = w.orgId;
      const panelPartyId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${panelPartyId}, ${orgId}, 'person', 'Panelist Pam', true, '{}'::jsonb)`);
      const employmentId = randomUUID();
      await db.execute(sql`
        insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
        values (${employmentId}, ${orgId}, ${panelPartyId}, ${w.subA}, 1)`);
      await db.execute(sql`
        insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from)
        values (${orgId}, ${employmentId}, 1, 'active', '2026-07-01'::date)`);
      const reqA = await openReq(w, w.subA, "A role");
      const ann = await candidate(w, "Ann A");
      const app = await createApplication({ orgId, actorId: w.admin, requisitionId: reqA.id, candidateId: ann.id });
      // Scorecard shells exist only on kitted sittings; without a kit the summary is empty for every viewer.
      const kit = await createKit({ orgId, actorId: w.admin, name: "panel kit" });
      const interview = await scheduleInterview({
        orgId, actorId: w.admin, applicationId: app.id, kind: "video",
        scheduledAt: "2026-09-25T14:00:00Z", durationMinutes: 30, panelPartyIds: [panelPartyId], kitId: kit.id,
      });
      const full = await scorecardSummary({ orgId, actorId: w.admin, interviewId: interview.id });
      assert.deepEqual(full.missing, ["Panelist Pam"], "managers see whose verdict is outstanding");
      const projected = await scorecardSummary({ orgId, actorId: w.reader, interviewId: interview.id });
      assert.deepEqual(projected.missing, [], "readers get counts, never panel-member names");
      assert.deepEqual([projected.totalCount, projected.submittedCount], [full.totalCount, full.submittedCount], "the projection keeps the counts");
    },
  }),
  scopeRow({
    name: "an offer's employer must equal its requisition's employer",
    features: ["hrmRecruiting"],
    permissions: PERMISSIONS,
    write: async (w) => {
      const app = await application(w, (await openReq(w, w.subA, "A role")).id);
      const error = await refusal(createOffer({ orgId: w.orgId, actorId: w.admin, applicationId: app.id, ...offerTerms(w.subB) }), RecruitingError);
      assert.equal(error.code, "REFUSED");
      assert.match(error.message, new RegExp(w.subA), "the refusal names the expected entity");
      const offer = await createOffer({ orgId: w.orgId, actorId: w.admin, applicationId: app.id, ...offerTerms(w.subA) });
      assert.equal(offer.employerSubsidiaryId, w.subA);
    },
  }),
  scopeRow({
    name: "an offer draft cannot name a position other than the requisition's",
    features: ["hrmRecruiting"],
    permissions: [...PERMISSIONS, "hrm.position.manage", "hrm.position.read"],
    write: async (w) => {
      const pinned = await position(w, "ENG-9101", w.subA);
      const other = await position(w, "ENG-9102", w.subA);
      const app = await application(w, (await openReq(w, w.subA, "Pinned engineer", pinned.id)).id);
      const error = await refusal(
        createOffer({ orgId: w.orgId, actorId: w.admin, applicationId: app.id, positionId: other.id, ...offerTerms(w.subA) }),
        RecruitingError, /match the requisition's pinned position/,
      );
      assert.equal(error.code, "INVALID_INPUT");
      const inherited = await createOffer({ orgId: w.orgId, actorId: w.admin, applicationId: app.id, ...offerTerms(w.subA) });
      assert.equal(inherited.positionId, null, "omitting positionId leaves the requisition's pinned position for the hire to inherit");
    },
  }),
  scopeRow({
    name: "an offer's employer must equal its named position's employer",
    features: ["hrmRecruiting"],
    permissions: [...PERMISSIONS, "hrm.position.manage", "hrm.position.read"],
    write: async (w) => {
      // The requisition has no position, so only the named foreign position can refuse.
      const app = await application(w, (await openReq(w, w.subA, "A role, no position")).id);
      const foreign = await position(w, "ENG-9002", w.subB);
      const error = await refusal(
        createOffer({ orgId: w.orgId, actorId: w.admin, applicationId: app.id, positionId: foreign.id, ...offerTerms(w.subA) }),
        RecruitingError, /position's legal entity/,
      );
      assert.equal(error.code, "REFUSED");
      assert.match(error.message, new RegExp(w.subB), "the refusal names the position's entity as the expected one");
      const home = await position(w, "ENG-9003", w.subA);
      const offer = await createOffer({ orgId: w.orgId, actorId: w.admin, applicationId: app.id, positionId: home.id, ...offerTerms(w.subA) });
      assert.equal(offer.employerSubsidiaryId, w.subA);
    },
  }),
]);
