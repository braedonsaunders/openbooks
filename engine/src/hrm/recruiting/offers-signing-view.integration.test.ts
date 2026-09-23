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
import { RecruitingError } from "./errors.ts";
import {
  createRequisition,
  openRequisition,
} from "./requisitions.ts";
import { createCandidate } from "./candidates.ts";
import { createApplication } from "./applications.ts";
import { createOffer, sendOffer } from "./offers.ts";
import {
  createOfferTemplate,
  hashOfferDocument,
  readOfferForSigning,
  renderOfferVersion,
  sendOfferLink,
} from "./offers-signing.ts";

/**
 * Offer signing view (fnd_muddmw7f) over the real 0229/0240 tables — DB-owned, one file at a
 * time. No skip guards: the integration partition guarantees a database.
 *
 * Serves the sealed terms and letter the signature seals — proofs read back from storage, and every
 * refusal asserts its code AND its message.
 */

const priorSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = priorSecret ?? "openbooks-test-only-offer-signing-secret";
test.after(() => {
  if (priorSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = priorSecret;
});

type Harness = {
  org: ScratchOrg;
  recruiterId: string;
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

async function enableDepth(orgId: string): Promise<void> {
  for (const key of ["hrm", "hrmRecruiting", "hrmOfferSigning"] as const) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), string_to_array(${`features,${key}`}, ','), 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableDepth(org.orgId);
  const recruiterId = await createScratchUser(org.orgId, "Offer Signing Recruiter", "offer_signing_recruiter");
  await grant(org.orgId, recruiterId, ["hrm.recruiting.read", "hrm.recruiting.manage"]);
  return { org, recruiterId };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function seedSentOffer(h: Harness): Promise<{ applicationId: string; offerId: string }> {
  const orgId = h.org.orgId;
  const requisition = await createRequisition({
    orgId,
    actorId: h.recruiterId,
    title: "Backend engineer",
    employerSubsidiaryId: h.org.subsidiaryId,
    headcount: 1,
  });
  const opened = await openRequisition({ orgId, actorId: h.recruiterId, requisitionId: requisition.id });
  const { candidate } = await createCandidate({
    orgId,
    actorId: h.recruiterId,
    displayName: "Offer Candidate",
    email: `offer-${randomUUID()}@example.test`,
    source: "direct",
  });
  const application = await createApplication({
    orgId,
    actorId: h.recruiterId,
    requisitionId: opened.id,
    candidateId: candidate.id,
  });
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
    expiresOn: "2027-12-31",
  });
  const sent = await sendOffer({ orgId, actorId: h.recruiterId, offerId: offer.id });
  assert.equal(sent.status, "sent");
  return { applicationId: application.id, offerId: offer.id };
}

async function seedRenderedOffer(h: Harness): Promise<{ offerId: string; token: string }> {
  const { offerId } = await seedSentOffer(h);
  const orgId = h.org.orgId;
  const template = await createOfferTemplate({
    orgId,
    actorId: h.recruiterId,
    name: "Standard letter",
    bodyTemplate: "Dear {{candidate_name}}, we offer you {{job_title}} at {{compensation_amount}} {{compensation_currency}} starting {{start_date}}.",
    clauses: [{ key: "at_will", label: "At will", body: "Employment is at will.", default_on: true }],
  });
  await renderOfferVersion({
    orgId,
    actorId: h.recruiterId,
    offerId,
    templateId: template.id,
    selectedClauseKeys: ["at_will"],
  });
  const link = await sendOfferLink({
    orgId,
    actorId: h.recruiterId,
    offerId,
    candidateEmail: "candidate@example.test",
    candidateName: "Offer Candidate",
    enqueueEmail: async () => {},
  });
  return { offerId, token: link.signingToken };
}

function recruitingError(error: unknown): RecruitingError {
  assert.ok(error instanceof RecruitingError, `expected RecruitingError, got ${String(error)}`);
  return error;
}

test("signing view serves the sealed terms and letter with the hash the signature seals", async () => {
  await withHarness(async (h) => {
    const { offerId, token } = await seedRenderedOffer(h);
    const view = await readOfferForSigning(token);
    assert.equal(view.offerId, offerId);
    assert.equal(view.version, 1);
    // The letter is the rendered terms — the candidate reads what they sign.
    assert.match(view.letter, /Backend engineer/);
    assert.match(view.letter, /120000/);
    assert.match(view.letter, /Employment is at will\./);
    // The served hash is the seal over the stored payload, proved from storage.
    const stored = (await db.execute<{ payload: unknown }>(sql`
      select payload from hrm_offer_versions
       where org_id = ${h.org.orgId} and offer_id = ${offerId} order by version desc limit 1
    `)).rows[0]!.payload;
    assert.deepEqual(view.terms, stored);
    assert.equal(view.documentHash, hashOfferDocument(JSON.stringify(stored)));
  });
});

test("signing view refuses when no terms were ever rendered", async () => {
  await withHarness(async (h) => {
    const { offerId } = await seedSentOffer(h);
    const link = await sendOfferLink({
      orgId: h.org.orgId,
      actorId: h.recruiterId,
      offerId,
      candidateEmail: "candidate@example.test",
      candidateName: "Offer Candidate",
      enqueueEmail: async () => {},
    });
    const error = recruitingError(await readOfferForSigning(link.signingToken).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(error.code, "REFUSED");
    assert.match(error.message, /no terms have been rendered/);
  });
});
