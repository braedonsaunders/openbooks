import { test } from "node:test";
import assert from "node:assert/strict";
import { listPostings, publishPosting } from "./postings.ts";
import {
  openScopedReq,
  setupScopeHarness,
  teardownScopeHarness,
} from "./recruiting-scope-test-fixture.ts";

/**
 * H-RECRUIT-POSTINGS: the manager list path returned every org posting. The
 * read grant plus the actor's employer scope over each posting's
 * requisition now filters it — a scoped reader lists only their entities'
 * postings (and a per-requisition filter for an out-of-scope opening yields
 * nothing, not a denial).
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

test("H-RECRUIT-POSTINGS: the postings list respects employer scope", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting", "hrmJobBoards"]);
  try {
    const orgId = h.org.orgId;
    const reqA = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role");
    const reqB = await openScopedReq(orgId, h.adminId, h.subB, "B role");
    await publishPosting({ orgId, actorId: h.adminId, requisitionId: reqA.id, boardKey: "internal" });
    await publishPosting({ orgId, actorId: h.adminId, requisitionId: reqB.id, boardKey: "internal" });

    const scoped = await listPostings({ orgId, actorId: h.scopedId });
    assert.deepEqual(
      scoped.map((posting) => posting.requisitionId),
      [reqA.id],
      "the B posting never lists to an A-scoped reader",
    );
    const filtered = await listPostings({ orgId, actorId: h.scopedId, requisitionId: reqB.id });
    assert.deepEqual(filtered, [], "filtering to an out-of-scope opening yields nothing");

    const all = await listPostings({ orgId, actorId: h.adminId });
    assert.equal(all.length, 2, "unrestricted readers still list the whole board");
  } finally {
    await teardownScopeHarness(h);
  }
});
