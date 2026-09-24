import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { RecruitingError } from "./errors.ts";
import { createCandidate } from "./candidates.ts";
import { createApplication } from "./applications.ts";
import {
  openScopedReq,
  setupScopeHarness,
  teardownScopeHarness,
} from "./recruiting-scope-test-fixture.ts";

/**
 * H-RECRUIT-ATTACH: authorizing only the target requisition lets a scoped
 * actor attach any org candidate (by guessed id) to their own opening and
 * pull them into scope. The candidate must be attachable too: owned through
 * an in-scope requisition, or a fresh prospect with no applications (first
 * attach wins). Anything else refuses exactly like an unknown id.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

function recruitingError(error: unknown): RecruitingError {
  assert.ok(error instanceof RecruitingError, `expected RecruitingError, got ${String(error)}`);
  return error;
}

async function applicationCount(orgId: string, requisitionId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from hrm_applications
     where org_id = ${orgId} and requisition_id = ${requisitionId}`)).rows[0]!.n;
}

test("H-RECRUIT-ATTACH: a B candidate cannot be attached to an A requisition", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting"]);
  try {
    const orgId = h.org.orgId;
    const reqA = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role");
    const reqB = await openScopedReq(orgId, h.adminId, h.subB, "B role");
    const { candidate: candB } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Bob B", email: "bob@example.test" });
    await createApplication({ orgId, actorId: h.adminId, requisitionId: reqB.id, candidateId: candB.id });

    const refusal = await createApplication({ orgId, actorId: h.scopedId, requisitionId: reqA.id, candidateId: candB.id }).then(
      () => null,
      (error: unknown) => recruitingError(error),
    );
    assert.ok(refusal, "the cross-entity attach refuses");
    assert.equal(refusal.code, "NOT_FOUND");
    assert.equal(
      refusal.message,
      "candidate is not visible in this organization — check the reference",
      "indistinguishable from an unknown id",
    );
    assert.equal(await applicationCount(orgId, reqA.id), 0, "the refused attach wrote no row");

    // A fresh prospect (no applications anywhere) still attaches: the
    // in-scope opening establishes first ownership.
    const { candidate: fresh } = await createCandidate({ orgId, actorId: h.adminId, displayName: "New N", email: "new@example.test" });
    const attached = await createApplication({ orgId, actorId: h.scopedId, requisitionId: reqA.id, candidateId: fresh.id });
    assert.equal(attached.candidateId, fresh.id);

    // ...and an already-owned candidate re-attaches to a second in-scope opening.
    const { candidate: candA } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Ann A", email: "ann@example.test" });
    await createApplication({ orgId, actorId: h.adminId, requisitionId: reqA.id, candidateId: candA.id });
    const reqA2 = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role 2");
    const second = await createApplication({ orgId, actorId: h.scopedId, requisitionId: reqA2.id, candidateId: candA.id });
    assert.equal(second.candidateId, candA.id);
  } finally {
    await teardownScopeHarness(h);
  }
});
