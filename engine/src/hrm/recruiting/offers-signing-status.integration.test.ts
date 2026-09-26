import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
} from "../../testing/fixtures.ts";
import {
  recruitingError,
  seedSigningRenderedOffer,
  setupHarness,
  withHarness,
} from "../../testing/hrm-harness.ts";
import { RecruitingError } from "./errors.ts";
import {
  createRequisition,
  openRequisition,
} from "./requisitions.ts";
import { createCandidate } from "./candidates.ts";
import { createApplication } from "./applications.ts";
import { createOffer, declineOffer, sendOffer, withdrawOffer } from "./offers.ts";
import {
  createOfferTemplate,
  readOfferForSigning,
  renderOfferVersion,
  sendOfferLink,
  signOffer,
} from "./offers-signing.ts";

/**
 * Offer signing commercial-status gate (fnd_muddmw3t) over the real 0229/0240 tables — DB-owned, one file at a
 * time. No skip guards: the integration partition guarantees a database.
 *
 * Refuses terminal offers and revokes the token on terminal transitions — proofs read back from storage, and every
 * refusal asserts its code AND its message.
 */

const OFFER_SIGNING_SPEC = {
  features: ["hrm", "hrmRecruiting", "hrmOfferSigning"],
  users: [
    { key: "recruiterId", name: "Offer Signing Recruiter", handle: "offer_signing_recruiter", permissions: ["hrm.recruiting.read", "hrm.recruiting.manage"] },
  ],
} as const;

const priorSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = priorSecret ?? "openbooks-test-only-offer-signing-secret";
test.after(() => {
  if (priorSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = priorSecret;
});

test("signing a withdrawn offer is refused and the token dies on withdraw", async () => {
  await withHarness(() => setupHarness(OFFER_SIGNING_SPEC), async (h) => {
    const { offerId, token } = await seedSigningRenderedOffer(h.org, h.recruiterId);
    await withdrawOffer({ orgId: h.org.orgId, actorId: h.recruiterId, offerId, reason: "role closed" });
    // The commercial write revokes the outstanding link, proved from storage.
    const stored = (await db.execute<{ tokenHash: string | null }>(sql`
      select signing_token_hash as "tokenHash" from hrm_offers
       where org_id = ${h.org.orgId} and id = ${offerId}
    `)).rows[0]!;
    assert.equal(stored.tokenHash, null);
    const error = recruitingError(await signOffer({
      signingToken: token,
      signerName: "Offer Candidate",
      ipHash: "test",
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(error.code, "REFUSED");
    assert.match(error.message, /no longer the current one/);
  });
});

test("signing a declined offer is refused and the token dies on decline", async () => {
  await withHarness(() => setupHarness(OFFER_SIGNING_SPEC), async (h) => {
    const { offerId, token } = await seedSigningRenderedOffer(h.org, h.recruiterId);
    await declineOffer({ orgId: h.org.orgId, actorId: h.recruiterId, offerId, reason: "accepted elsewhere" });
    const stored = (await db.execute<{ tokenHash: string | null }>(sql`
      select signing_token_hash as "tokenHash" from hrm_offers
       where org_id = ${h.org.orgId} and id = ${offerId}
    `)).rows[0]!;
    assert.equal(stored.tokenHash, null);
    const error = recruitingError(await signOffer({
      signingToken: token,
      signerName: "Offer Candidate",
      ipHash: "test",
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(error.code, "REFUSED");
    assert.match(error.message, /no longer the current one/);
  });
});

test("signing a past-due sent offer is refused as expired", async () => {
  await withHarness(() => setupHarness(OFFER_SIGNING_SPEC), async (h) => {
    const orgId = h.org.orgId;
    const yesterday = new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10);
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
      expiresOn: yesterday,
    });
    await sendOffer({ orgId, actorId: h.recruiterId, offerId: offer.id });
    const template = await createOfferTemplate({
      orgId,
      actorId: h.recruiterId,
      name: "Standard letter",
      bodyTemplate: "Dear {{candidate_name}}, we offer you {{job_title}}.",
      clauses: [],
    });
    await renderOfferVersion({ orgId, actorId: h.recruiterId, offerId: offer.id, templateId: template.id });
    const link = await sendOfferLink({
      orgId,
      actorId: h.recruiterId,
      offerId: offer.id,
      candidateEmail: "candidate@example.test",
      candidateName: "Offer Candidate",
      enqueueEmail: async () => {},
    });
    // The link is still the current one, but the offer is past due: the
    // commercial status gates the signature, not just the token.
    const view = await readOfferForSigning(link.signingToken);
    const error = recruitingError(await signOffer({
      signingToken: link.signingToken,
      signerName: "Offer Candidate",
      ipHash: "test",
      documentHash: view.documentHash,
    }).then(
      () => null,
      (e: unknown) => e,
    ));
    assert.equal(error.code, "REFUSED");
    assert.match(error.message, /expired before it was signed/);
  });
});

