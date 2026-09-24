import { test } from "node:test";
import assert from "node:assert/strict";
import { RecruitingError } from "./errors.ts";
import { createCandidate } from "./candidates.ts";
import { createApplication } from "./applications.ts";
import { addPoolMember, createTalentPool, listPoolMembers, removePoolMember, tagCandidate } from "./pools.ts";
import {
  openScopedReq,
  setupScopeHarness,
  teardownScopeHarness,
} from "./recruiting-scope-test-fixture.ts";

/**
 * H-RECRUIT-POOLS: pool membership shares the candidate with pool readers,
 * so every mutation through the pool — add, remove, tag — requires owning
 * the candidate through an in-scope requisition, and member lists render
 * only owned candidates. Unknown and out-of-scope refuse identically.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

function recruitingError(error: unknown): RecruitingError {
  assert.ok(error instanceof RecruitingError, `expected RecruitingError, got ${String(error)}`);
  return error;
}

async function seedAB(h: Awaited<ReturnType<typeof setupScopeHarness>>) {
  const orgId = h.org.orgId;
  const reqA = await openScopedReq(orgId, h.adminId, h.org.subsidiaryId, "A role");
  const reqB = await openScopedReq(orgId, h.adminId, h.subB, "B role");
  const { candidate: candA } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Ann A", email: "ann@example.test" });
  const { candidate: candB } = await createCandidate({ orgId, actorId: h.adminId, displayName: "Bob B", email: "bob@example.test" });
  await createApplication({ orgId, actorId: h.adminId, requisitionId: reqA.id, candidateId: candA.id });
  await createApplication({ orgId, actorId: h.adminId, requisitionId: reqB.id, candidateId: candB.id });
  const pool = await createTalentPool({ orgId, actorId: h.adminId, name: "bench" });
  await addPoolMember({ orgId, actorId: h.adminId, poolId: pool.id, candidateId: candA.id, note: "strong" });
  await addPoolMember({ orgId, actorId: h.adminId, poolId: pool.id, candidateId: candB.id, note: "backup" });
  return { orgId, pool, candA, candB };
}

test("H-RECRUIT-POOLS: member lists show only owned candidates", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting", "hrmTalentPool"]);
  try {
    const { orgId, pool } = await seedAB(h);
    const members = await listPoolMembers({ orgId, actorId: h.scopedId, poolId: pool.id });
    assert.deepEqual(
      members.map((member) => member.displayName),
      ["Ann A"],
      "the B member never enumerates to an A-scoped reader",
    );
    const all = await listPoolMembers({ orgId, actorId: h.adminId, poolId: pool.id });
    assert.equal(all.length, 2, "unrestricted readers still list the whole pool");
  } finally {
    await teardownScopeHarness(h);
  }
});

test("H-RECRUIT-POOLS: add, remove and tag need ownership", { skip: !DB }, async () => {
  const h = await setupScopeHarness(["hrmRecruiting", "hrmTalentPool"]);
  try {
    const { orgId, pool, candA, candB } = await seedAB(h);

    for (const [name, call] of [
      ["add", () => addPoolMember({ orgId, actorId: h.scopedId, poolId: pool.id, candidateId: candB.id })],
      ["remove", () => removePoolMember({ orgId, actorId: h.scopedId, poolId: pool.id, candidateId: candB.id })],
      ["tag", () => tagCandidate({ orgId, actorId: h.scopedId, candidateId: candB.id, tags: ["x"] })],
    ] as const) {
      const refusal = await call().then(
        () => null,
        (error: unknown) => recruitingError(error),
      );
      assert.ok(refusal, `${name} refuses the out-of-scope candidate`);
      assert.equal(refusal.code, "NOT_FOUND", `${name} denials are uniform with not-found`);
    }

    const untouched = await listPoolMembers({ orgId, actorId: h.adminId, poolId: pool.id });
    assert.equal(untouched.length, 2, "refused mutations wrote nothing");

    // The owned candidate still flows through every mutation.
    const added = await addPoolMember({ orgId, actorId: h.scopedId, poolId: pool.id, candidateId: candA.id }).then(
      () => "duplicate",
      (error: unknown) => recruitingError(error).code,
    );
    assert.equal(added, "REFUSED", "re-adding the owned candidate names the duplicate rule, not a scope denial");
    await removePoolMember({ orgId, actorId: h.scopedId, poolId: pool.id, candidateId: candA.id });
    const tags = await tagCandidate({ orgId, actorId: h.scopedId, candidateId: candA.id, tags: ["hot"] });
    assert.deepEqual(tags, ["hot"]);
  } finally {
    await teardownScopeHarness(h);
  }
});
