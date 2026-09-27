import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  recruitingError,
  seedSigningRenderedOffer,
  setupHarness,
  withHarness,
} from "../../testing/hrm-harness.ts";
import {
  declineOfferSigning,
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

const OFFER_SIGNING_SPEC = {
  features: ["hrm", "hrmRecruiting"],
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

test("re-rendering changed terms rotates the signing link", async () => {
  await withHarness(() => setupHarness(OFFER_SIGNING_SPEC), async (h) => {
    const orgId = h.org.orgId;
    const { offerId, token: firstToken } = await seedSigningRenderedOffer(h.org, h.recruiterId);
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
    for (const staleAction of [
      () => readOfferForSigning(firstToken),
      () => declineOfferSigning({ signingToken: firstToken, reason: "terms changed" }),
    ]) {
      const error = recruitingError(await staleAction().then(() => null, (e: unknown) => e));
      assert.equal(error.code, "REFUSED");
      assert.match(error.message, /no longer the current one/);
    }
  });
});

test("signing without the displayed hash is refused", async () => {
  await withHarness(() => setupHarness(OFFER_SIGNING_SPEC), async (h) => {
    const { token } = await seedSigningRenderedOffer(h.org, h.recruiterId);
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
  await withHarness(() => setupHarness(OFFER_SIGNING_SPEC), async (h) => {
    const orgId = h.org.orgId, { offerId, token } = await seedSigningRenderedOffer(h.org, h.recruiterId);
    const shown = await readOfferForSigning(token);
    const templateId = (await db.execute<{ templateId: string }>(sql`select template_id as "templateId" from hrm_offers where org_id = ${orgId} and id = ${offerId}`)).rows[0]!.templateId;
    await renderOfferVersion({ orgId, actorId: h.recruiterId, offerId, templateId });
    const { signingToken } = await sendOfferLink({ orgId, actorId: h.recruiterId, offerId, candidateEmail: "candidate@example.test", candidateName: "Offer Candidate", enqueueEmail: async () => {} });
    const error = recruitingError(await signOffer({ signingToken, signerName: "Offer Candidate", ipHash: "test", documentHash: shown.documentHash }).then(() => null, (e: unknown) => e));
    assert.equal(error.code, "REFUSED");
    assert.match(error.message, /changed since this link was opened/);
    assert.equal((await signOffer({ signingToken, signerName: "Offer Candidate", ipHash: "test", documentHash: (await readOfferForSigning(signingToken)).documentHash })).offerId, offerId);
  });
});

test("render and signing serialize on the offer row", async () => {
  await withHarness(() => setupHarness(OFFER_SIGNING_SPEC), async (h) => {
    const { offerId, token } = await seedSigningRenderedOffer(h.org, h.recruiterId), orgId = h.org.orgId;
    const { version, documentHash } = await readOfferForSigning(token);
    const templateId = (await db.execute<{ templateId: string }>(sql`select template_id as "templateId" from hrm_offers where org_id = ${orgId} and id = ${offerId}`)).rows[0]!.templateId;
    const results = await Promise.allSettled([
      renderOfferVersion({ orgId, actorId: h.recruiterId, offerId, templateId }),
      signOffer({ signingToken: token, signerName: "Offer Candidate", ipHash: "test", documentHash }),
    ]);
    const renderWon = results[0]?.status === "fulfilled";
    const final = (await db.execute<{ signatureStatus: string | null; version: number }>(sql`select signature_status as "signatureStatus", version from hrm_offers where org_id = ${orgId} and id = ${offerId}`)).rows[0]!;
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(final.signatureStatus, renderWon ? "unsigned" : "signed");
    assert.equal(final.version, version + Number(renderWon));
  });
});
