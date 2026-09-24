import { test } from "node:test";
import assert from "node:assert/strict";
import { RecruitingError } from "./errors.ts";
import { createPosition } from "../positions.ts";
import { createCandidate } from "./candidates.ts";
import { createApplication } from "./applications.ts";
import { createOffer } from "./offers.ts";
import {
  grantPermissions,
  openScopedReq,
  setupScopeHarness,
  teardownScopeHarness,
} from "./recruiting-scope-test-fixture.ts";

/**
 * H-OFFER-ENTITY: an offer carries its own employerSubsidiaryId, and
 * nothing pinned it to the opening — an offer on an A requisition could
 * declare B's entity and book the hire into the wrong legal entity. The
 * declared employer must equal the requisition's employer (and the
 * requisition position's live-version employer when a position is in
 * play), with the expected entity named in the refusal.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

function recruitingError(error: unknown): RecruitingError {
  assert.ok(error instanceof RecruitingError, `expected RecruitingError, got ${String(error)}`);
  return error;
}

function offerTerms(employerSubsidiaryId: string) {
  return {
    employerSubsidiaryId,
    jobTitle: "Backend engineer",
    proposedStartOn: "2026-10-01",
    compensationAmount: "120000",
    compensationCurrency: "USD",
    compensationBasis: "annual" as const,
  };
}

test("H-OFFER-ENTITY: the offer employer must equal the requisition employer", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting"]);
  try {
    const orgId = h.org.orgId;
    const draft = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role");
    const { candidate } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Ann A", email: "ann@example.test" });
    const application = await createApplication({ orgId, actorId: h.adminId, requisitionId: draft.id, candidateId: candidate.id });

    const refusal = await createOffer({ orgId, actorId: h.adminId, applicationId: application.id, ...offerTerms(h.subB) }).then(
      () => null,
      (error: unknown) => recruitingError(error),
    );
    assert.ok(refusal, "the cross-entity offer refuses");
    assert.equal(refusal.code, "REFUSED");
    assert.match(refusal.message, new RegExp(h.org.subsidiaryId), "the refusal names the expected entity");

    const offer = await createOffer({ orgId, actorId: h.adminId, applicationId: application.id, ...offerTerms(h.org.subsidiaryId) });
    assert.equal(offer.employerSubsidiaryId, h.org.subsidiaryId);
  } finally {
    await teardownScopeHarness(h);
  }
});

test("H-OFFER-ENTITY: the offer employer must equal the position employer", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting"]);
  try {
    const orgId = h.org.orgId;
    // Seeding a position is positions-domain work and keeps its own gate:
    // the recruiting admin holds no position grant from the harness.
    await grantPermissions(orgId, h.adminId, ["hrm.position.manage", "hrm.position.read"]);
    async function seedPosition(code: string, employerSubsidiaryId: string) {
      return createPosition({
        orgId,
        actorId: h.adminId,
        positionCode: code,
        title: "Engineer",
        employerSubsidiaryId,
        plannedFte: "1.0000",
        status: "open",
        effectiveFrom: "2026-07-01",
        reason: "entity seed",
      });
    }
    // The requisition carries no position of its own, so the requisition
    // check passes on the declared entity and only the explicitly named
    // foreign position can refuse: the position's live-version employer
    // decides.
    const opened = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role, no position");
    const foreign = await seedPosition("ENG-9002", h.subB);
    const { candidate } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Ann A", email: "ann@example.test" });
    const application = await createApplication({ orgId, actorId: h.adminId, requisitionId: opened.id, candidateId: candidate.id });

    const refusal = await createOffer({
      orgId, actorId: h.adminId, applicationId: application.id, positionId: foreign.id, ...offerTerms(h.org.subsidiaryId),
    }).then(
      () => null,
      (error: unknown) => recruitingError(error),
    );
    assert.ok(refusal, "the cross-entity offer refuses");
    assert.equal(refusal.code, "REFUSED");
    assert.match(refusal.message, /position's legal entity/, "the refusal names the position rule");
    assert.match(refusal.message, new RegExp(h.subB), "the refusal names the position's entity as the expected one");

    const home = await seedPosition("ENG-9003", h.org.subsidiaryId);
    const offer = await createOffer({
      orgId, actorId: h.adminId, applicationId: application.id, positionId: home.id, ...offerTerms(h.org.subsidiaryId),
    });
    assert.equal(offer.employerSubsidiaryId, h.org.subsidiaryId);
  } finally {
    await teardownScopeHarness(h);
  }
});
