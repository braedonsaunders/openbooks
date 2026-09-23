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
  readOfferForSigning,
  renderOfferVersion,
  sendOfferLink,
  signOffer,
} from "./offers-signing.ts";

/**
 * Offer signing link rotation (fnd_muddmw5k) over the real 0229/0240 tables — DB-owned, one file at a
 * time. No skip guards: the integration partition guarantees a database.
 *
 * Rotates the link on re-render and requires the displayed hash — proofs read back from storage, and every
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

test("re-rendering changed terms rotates the signing link", async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const { offerId, token: firstToken } = await seedRenderedOffer(h);
    const templateId = (await db.execute<{ templateId: string }>(sql`
      select template_id as "templateId" from hrm_offers where org_id = ${orgId} and id = ${offerId}
    `)).rows[0]!.templateId;
    await renderOfferVersion({
      orgId,
      actorId: h.recruiterId,
      offerId,
      templateId,
      selectedClauseKeys: [],
    });
    // The outstanding link dies with the version it displayed, proved from storage.
    const stored = (await db.execute<{ tokenHash: string | null; version: number }>(sql`
      select signing_token_hash as "tokenHash", version from hrm_offers
       where org_id = ${orgId} and id = ${offerId}
    `)).rows[0]!;
    assert.equal(stored.tokenHash, null);
    assert.equal(stored.version, 2);
    const error = recruitingError(await readOfferForSigning(firstToken).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(error.code, "REFUSED");
    assert.match(error.message, /no longer the current one/);
  });
});

test("signing without the displayed hash is refused", async () => {
  await withHarness(async (h) => {
    const { token } = await seedRenderedOffer(h);
    const error = recruitingError(await signOffer({
      signingToken: token,
      signerName: "Offer Candidate",
      ipHash: "test",
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(error.code, "REFUSED");
    assert.match(error.message, /needs the hash of the displayed terms/);
  });
});

test("signing a stale hash after new terms render is refused", async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const { offerId, token: firstToken } = await seedRenderedOffer(h);
    const firstView = await readOfferForSigning(firstToken);
    const templateId = (await db.execute<{ templateId: string }>(sql`
      select template_id as "templateId" from hrm_offers where org_id = ${orgId} and id = ${offerId}
    `)).rows[0]!.templateId;
    await renderOfferVersion({ orgId, actorId: h.recruiterId, offerId, templateId, selectedClauseKeys: [] });
    const resent = await sendOfferLink({
      orgId,
      actorId: h.recruiterId,
      offerId,
      candidateEmail: "candidate@example.test",
      candidateName: "Offer Candidate",
      enqueueEmail: async () => {},
    });
    // The new link carries the new version, but the old display hash must not sign it.
    const error = recruitingError(await signOffer({
      signingToken: resent.signingToken,
      signerName: "Offer Candidate",
      ipHash: "test",
      documentHash: firstView.documentHash,
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(error.code, "REFUSED");
    assert.match(error.message, /changed since this link was opened/);
    // And the current hash signs cleanly, sealing the new version.
    const secondView = await readOfferForSigning(resent.signingToken);
    assert.notEqual(secondView.documentHash, firstView.documentHash);
    const signed = await signOffer({
      signingToken: resent.signingToken,
      signerName: "Offer Candidate",
      ipHash: "test",
      documentHash: secondView.documentHash,
    });
    assert.equal(signed.offerId, offerId);
  });
});

