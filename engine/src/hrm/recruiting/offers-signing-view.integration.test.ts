import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  recruitingError,
  seedSigningOffer,
  seedSigningRenderedOffer,
  setupHarness,
  withHarness,
} from "../../testing/hrm-harness.ts";
import {
  hashOfferDocument,
  readOfferForSigning,
  sendOfferLink,
} from "./offers-signing.ts";

/**
 * Offer signing view (fnd_muddmw7f) over the real 0229/0240 tables — DB-owned, one file at a
 * time. No skip guards: the integration partition guarantees a database.
 *
 * Serves the sealed terms and letter the signature seals — proofs read back from storage, and every
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

test("signing view serves the sealed terms and letter with the hash the signature seals", async () => {
  await withHarness(() => setupHarness(OFFER_SIGNING_SPEC), async (h) => {
    const { offerId, token } = await seedSigningRenderedOffer(h.org, h.recruiterId);
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
  await withHarness(() => setupHarness(OFFER_SIGNING_SPEC), async (h) => {
    const { offerId } = await seedSigningOffer(h.org, h.recruiterId);
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
