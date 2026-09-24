import { test } from "node:test";
import assert from "node:assert/strict";
import { RecruitingError } from "./errors.ts";
import { createCandidate } from "./candidates.ts";
import { createApplication } from "./applications.ts";
import { listCandidateConsents, recordConsent, withdrawConsent } from "./retention.ts";
import {
  openScopedReq,
  setupScopeHarness,
  teardownScopeHarness,
} from "./recruiting-scope-test-fixture.ts";

/**
 * H-RECRUIT-CONSENT: consent rows are privacy posture with legal effect, so
 * recording, withdrawing, and listing them all require owning the candidate
 * through an in-scope requisition. Unknown and out-of-scope refuse
 * identically — and refused writes land nowhere.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

function recruitingError(error: unknown): RecruitingError {
  assert.ok(error instanceof RecruitingError, `expected RecruitingError, got ${String(error)}`);
  return error;
}

test("H-RECRUIT-CONSENT: consent writes need ownership", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting", "hrmCandidateRetention"]);
  try {
    const orgId = h.org.orgId;
    const reqA = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role");
    const reqB = await openScopedReq(orgId, h.adminId, h.subB, "B role");
    const { candidate: candA } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Ann A", email: "ann@example.test" });
    const { candidate: candB } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Bob B", email: "bob@example.test" });
    await createApplication({ orgId, actorId: h.adminId, requisitionId: reqA.id, candidateId: candA.id });
    await createApplication({ orgId, actorId: h.adminId, requisitionId: reqB.id, candidateId: candB.id });
    await recordConsent({ orgId, actorId: h.adminId, candidateId: candB.id, purpose: "future_roles" });

    for (const [name, call] of [
      ["record", () => recordConsent({ orgId, actorId: h.scopedId, candidateId: candB.id, purpose: "talent_pool" })],
      ["withdraw", () => withdrawConsent({ orgId, actorId: h.scopedId, candidateId: candB.id, purpose: "future_roles" })],
      ["list", () => listCandidateConsents({ orgId, actorId: h.scopedId, candidateId: candB.id })],
    ] as const) {
      const refusal = await call().then(
        () => null,
        (error: unknown) => recruitingError(error),
      );
      assert.ok(refusal, `${name} refuses the out-of-scope candidate`);
      assert.equal(refusal.code, "NOT_FOUND", `${name} denials are uniform with not-found`);
    }

    // The refused record wrote nothing: only the admin's grant stands.
    const status = await listCandidateConsents({ orgId, actorId: h.adminId, candidateId: candB.id });
    assert.deepEqual(
      status.consents.map((consent) => consent.purpose),
      ["future_roles"],
      "the refused record consent landed nowhere",
    );
    // The owned candidate flows through every consent path.
    const consent = await recordConsent({ orgId, actorId: h.scopedId, candidateId: candA.id, purpose: "future_roles" });
    assert.equal(consent.candidateId, candA.id);
    await withdrawConsent({ orgId, actorId: h.scopedId, candidateId: candA.id, purpose: "future_roles" });
    const listed = await listCandidateConsents({ orgId, actorId: h.scopedId, candidateId: candA.id });
    assert.equal(listed.consents.length, 1, "the withdrawn row stays as evidence");
  } finally {
    await teardownScopeHarness(h);
  }
});
