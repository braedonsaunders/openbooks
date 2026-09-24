import { test } from "node:test";
import assert from "node:assert/strict";
import { HrmAuthorizationError } from "../authorization.ts";
import { createScratchUser } from "../../testing/fixtures.ts";
import { createCandidate } from "./candidates.ts";
import { createApplication, rejectApplication } from "./applications.ts";
import {
  ANONYMIZED_DISPLAY_NAME,
  createRetentionRule,
  evaluateRetentionRule,
  recordConsent,
} from "./retention.ts";
import {
  candidateDisplayName,
  grantPermissions,
  openScopedReq,
  setupScopeHarness,
  teardownScopeHarness,
} from "./recruiting-scope-test-fixture.ts";

/**
 * H-RECRUIT-RETENTION (+C-75): a retention run is destructive
 * (anonymize/delete), so authority lives in the service: a user run needs
 * the manage grant plus the runner's employer scope — a scoped runner's run
 * touches only candidates owned through in-scope requisitions — and the
 * scheduled system tick passes the explicit system sentinel for org-wide
 * coverage. Proofs read the candidates back from storage.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

test("H-RECRUIT-RETENTION: a scoped run anonymizes only in-scope candidates", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting", "hrmCandidateRetention"]);
  try {
    const orgId = h.org.orgId;
    const adminId = h.adminId;
    const scopedId = h.scopedId;

    const reqA = await openScopedReq(orgId, adminId, h.org.subsidiaryId, "A role");
    const reqB = await openScopedReq(orgId, adminId, h.subB, "B role");

    const { candidate: candA } = await createCandidate({ orgId, actorId: adminId, displayName: "Ann A", email: "ann@example.test" });
    const { candidate: candB } = await createCandidate({ orgId, actorId: adminId, displayName: "Bob B", email: "bob@example.test" });
    const appA = await createApplication({ orgId, actorId: adminId, requisitionId: reqA.id, candidateId: candA.id });
    const appB = await createApplication({ orgId, actorId: adminId, requisitionId: reqB.id, candidateId: candB.id });
    await rejectApplication({ orgId, actorId: adminId, applicationId: appA.id, reason: "not a fit" });
    await rejectApplication({ orgId, actorId: adminId, applicationId: appB.id, reason: "not a fit" });
    // Both candidates' consents already lapsed, so the consent-basis rule is due.
    const lapsed = new Date(Date.now() - 24 * 3_600_000).toISOString();
    await recordConsent({ orgId, actorId: adminId, candidateId: candA.id, purpose: "future_roles", expiresAt: lapsed });
    await recordConsent({ orgId, actorId: adminId, candidateId: candB.id, purpose: "future_roles", expiresAt: lapsed });

    const rule = await createRetentionRule({
      orgId,
      actorId: adminId,
      name: "lapsed consents",
      basis: "consent",
      retainMonths: 1,
      action: "anonymize",
    });

    const run = await evaluateRetentionRule({ orgId, actorId: scopedId, ruleId: rule.id });
    assert.equal(run.candidatesAnonymized, 1);
    assert.equal(await candidateDisplayName(orgId, candA.id), ANONYMIZED_DISPLAY_NAME);
    assert.equal(await candidateDisplayName(orgId, candB.id), "Bob B");

    // The system tick's explicit sentinel still covers the whole org. A is
    // still due (lapsed consent, no open application), so the sweep
    // re-processes it alongside the newly covered B.
    const full = await evaluateRetentionRule({ orgId, actorId: adminId, ruleId: rule.id }, { runner: { kind: "system" } });
    assert.equal(full.candidatesAnonymized, 2);
    assert.equal(await candidateDisplayName(orgId, candB.id), ANONYMIZED_DISPLAY_NAME);
  } finally {
    await teardownScopeHarness(h);
  }
});

test("H-RECRUIT-RETENTION: running a rule needs the manage grant", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting", "hrmCandidateRetention"]);
  try {
    const orgId = h.org.orgId;
    const adminId = h.adminId;
    const readerId = await createScratchUser(h.org.orgId, "Reader", "retention_reader");
    await grantPermissions(orgId, readerId, ["hrm.recruiting.read"]);
    const rule = await createRetentionRule({
      orgId,
      actorId: adminId,
      name: "stale prospects",
      basis: "inactivity",
      retainMonths: 12,
      action: "anonymize",
    });
    await assert.rejects(
      evaluateRetentionRule({ orgId, actorId: readerId, ruleId: rule.id }),
      (error: unknown) => error instanceof HrmAuthorizationError,
    );
    // ...unless it is the scheduled system job carrying the sentinel.
    const run = await evaluateRetentionRule({ orgId, actorId: readerId, ruleId: rule.id }, { runner: { kind: "system" } });
    assert.equal(run.candidatesAnonymized, 0);
  } finally {
    await teardownScopeHarness(h);
  }
});
