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
import {
  DB,
  grantPermissions,
  linkPerson,
  refusalOf,
  scopeRole,
  seedLevel,
  seedPayGapWorker,
  setupHarness,
  withHarness,
} from "../../testing/hrm-harness.ts";
import {
  createJobFamily,
  createJobLevel,
} from "./architecture.ts";
import {
  computeGapSnapshot,
  fulfilPayInformationRequest,
  latestGapSnapshot,
  refusePayInformationRequest,
  requestPayInformation,
} from "./pay-transparency.ts";

/**
 * F10 (with the F13 pay-information surface): org-wide frozen pay-gap
 * snapshots need an unrestricted actor.
 *
 * A stored snapshot aggregates every worker into immutable means,
 * medians, quartiles and regressions that cannot be post-filtered, so
 * compute and latest refuse any subsidiary-restricted lens — a list
 * (even one covering every subsidiary today), or an empty set — by
 * name with the remedy, and write nothing on refusal. Fulfilment
 * copies org-wide frozen category averages, so it carries the same
 * bar after its target-employment lens; refuse fences the same lens
 * with uniform hidden/missing behavior. Workers keep their own
 * authorized request path through hrm.self.request.
 *
 * Proofs are read back from storage, never from the service's own
 * return values alone.
 */


const PAY_GAP_SCOPE_SPEC = {
  compensation: { comparisonAttributeKey: "eeo_group", gapThresholdPct: "5", responseDays: 30 },
  users: [
    { key: "hrId", name: "Gap HR", handle: "gap_hr", permissions: ["hrm.compensation.read", "hrm.compensation.manage"], link: true },
    { key: "workerId", name: "Gap Worker", handle: "gap_worker", permissions: ["hrm.self.request"] },
    { key: "scopedAId", name: "Gap Scoped A", handle: "gap_scoped_a", permissions: ["hrm.compensation.read", "hrm.compensation.manage"] },
    { key: "scopedNoneId", name: "Gap Scoped None", handle: "gap_scoped_none", permissions: ["hrm.compensation.read", "hrm.compensation.manage"] },
    { key: "scopedAllId", name: "Gap Scoped All", handle: "gap_scoped_all", permissions: ["hrm.compensation.read", "hrm.compensation.manage"] },
    { key: "strangerId", name: "Gap Stranger", handle: "gap_stranger", link: true },
  ],
} as const;

async function snapshotCount(orgId: string): Promise<number> {
  const row = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from hrm_pay_gap_snapshots where org_id = ${orgId}`)).rows[0];
  return Number(row?.n ?? "0");
}

async function requestStatus(orgId: string, requestId: string): Promise<string | null> {
  const row = (await db.execute<{ status: string }>(sql`
    select status from hrm_pay_information_requests where org_id = ${orgId} and id = ${requestId}`)).rows[0];
  return row?.status ?? null;
}

/** Exact refusal identity (code plus message): hidden and missing ids must match fully. */
async function setupPayGapScopeHarness() {
  return setupHarness(PAY_GAP_SCOPE_SPEC, async (base) => {
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${base.org.orgId}, ${base.org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${base.org.subsidiaryId} and org_id = ${base.org.orgId}`);
    const levelId = await seedLevel(base.org.orgId, base.hrId);
    // G1 in A, G2 in B: both comparison sides priced, across subsidiaries.
    const empA = await seedPayGapWorker(base.org.orgId, base.hrId, base.org.subsidiaryId, levelId, "G1");
    const empB = await seedPayGapWorker(base.org.orgId, base.hrId, subB, levelId, "G2");
    // Self-service worker with their own positioned employment in A.
    const workerParty = await linkPerson(base.org.orgId, base.workerId);
    const workerEmp = await seedPayGapWorker(base.org.orgId, base.hrId, base.org.subsidiaryId, levelId, "G1", { workerPartyId: workerParty });
    await scopeRole(base.org.orgId, "gap_scoped_a", ["hrm.compensation.read", "hrm.compensation.manage"], [base.org.subsidiaryId]);
    await scopeRole(base.org.orgId, "gap_scoped_none", ["hrm.compensation.read", "hrm.compensation.manage"], []);
    await scopeRole(
      base.org.orgId,
      "gap_scoped_all",
      ["hrm.compensation.read", "hrm.compensation.manage"],
      [base.org.subsidiaryId, subB],
    );
    return {
      subB,
      workerEmploymentId: workerEmp.employmentId,
      empA: empA.employmentId,
      empB: empB.employmentId,
    };
  });
}

test("F10 unrestricted HR keeps full compute and latest access", { skip: !DB }, async () => {
  await withHarness(() => setupPayGapScopeHarness(), async (h) => {
    const snapshot = await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    assert.ok(snapshot.id);
    const reread = await latestGapSnapshot({ orgId: h.org.orgId, actorId: h.hrId });
    assert.equal(reread?.id, snapshot.id);
  });
});

test("F10 subsidiary-restricted lenses cannot compute org-wide snapshots", { skip: !DB }, async () => {
  await withHarness(() => setupPayGapScopeHarness(), async (h) => {
    const before = await snapshotCount(h.org.orgId);
    for (const actorId of [h.scopedAId, h.scopedNoneId, h.scopedAllId]) {
      await assert.rejects(
        computeGapSnapshot({ orgId: h.org.orgId, actorId, asOf: "2024-06-01", groupA: "G1", groupB: "G2" }),
        /measure the whole organization.*no subsidiary restriction/,
      );
    }
    assert.equal(await snapshotCount(h.org.orgId), before, "refused computes wrote no rows");
  });
});

test("F10 subsidiary-restricted lenses cannot read frozen org-wide snapshots", { skip: !DB }, async () => {
  await withHarness(() => setupPayGapScopeHarness(), async (h) => {
    // A frozen snapshot exists; restricted readers still see nothing.
    await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    for (const actorId of [h.scopedAId, h.scopedNoneId, h.scopedAllId]) {
      await assert.rejects(
        latestGapSnapshot({ orgId: h.org.orgId, actorId }),
        /measure the whole organization.*no subsidiary restriction/,
      );
    }
    // A list covering every subsidiary today is still a list, not the
    // whole org: adding a subsidiary afterwards changes nothing.
    const subC = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subC}, ${h.org.orgId}, ${h.org.subsidiaryId}, 'Third entity', base_currency, country
        from subsidiaries where id = ${h.org.subsidiaryId} and org_id = ${h.org.orgId}`);
    await assert.rejects(
      latestGapSnapshot({ orgId: h.org.orgId, actorId: h.scopedAllId }),
      /measure the whole organization/,
    );
  });
});

test("F10 other-org actors cannot compute or read snapshots", { skip: !DB }, async () => {
  await withHarness(() => setupPayGapScopeHarness(), async (h) => {
    await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    const other = await createScratchOrg();
    try {
      const otherHr = await createScratchUser(other.orgId, "Other HR", "other_hr");
      await grantPermissions(other.orgId, otherHr, ["hrm.compensation.read", "hrm.compensation.manage"]);
      await assert.rejects(
        computeGapSnapshot({ orgId: h.org.orgId, actorId: otherHr, asOf: "2024-06-01", groupA: "G1", groupB: "G2" }),
        /hrm\.compensation\.manage|not visible|not established/,
      );
      await assert.rejects(
        latestGapSnapshot({ orgId: h.org.orgId, actorId: otherHr }),
        /hrm\.compensation\.read|not visible|not established/,
      );
    } finally {
      await dropScratchOrg(other.orgId);
    }
  });
});

test("F10/F13 workers keep their own authorized request path", { skip: !DB }, async () => {
  await withHarness(() => setupPayGapScopeHarness(), async (h) => {
    const req = await requestPayInformation({
      orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmploymentId,
    });
    assert.equal(req.status, "open");
    assert.equal(await requestStatus(h.org.orgId, req.id), "open");
    // Identity alone files nothing: a grant-less owner is refused by name.
    const nogId = await createScratchUser(h.org.orgId, "Gap Nog", "gap_nog");
    const nogParty = await linkPerson(h.org.orgId, nogId);
    const nogEmp = await seedPayGapWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, (await levelOf(h.org, h.workerEmploymentId))!, "G1", { workerPartyId: nogParty });
    await assert.rejects(
      requestPayInformation({ orgId: h.org.orgId, actorId: nogId, employmentId: nogEmp.employmentId }),
      /hrm\.self\.request/,
    );
    // Someone else's employment stays refused with the existing message.
    await assert.rejects(
      requestPayInformation({ orgId: h.org.orgId, actorId: h.strangerId, employmentId: h.workerEmploymentId }),
      /your own employment/,
    );
    // Unrestricted HR fulfils from the frozen snapshot: the worker's own
    // category answer stays available.
    await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    const done = await fulfilPayInformationRequest({
      orgId: h.org.orgId, actorId: h.hrId, requestId: req.id,
    });
    assert.equal(done.status, "fulfilled");
    assert.ok(done.categoryAverages);
    assert.equal(await requestStatus(h.org.orgId, req.id), "fulfilled");
  });
});

async function levelOf(org: ScratchOrg, workerEmploymentId: string): Promise<string | null> {
  const row = (await db.execute<{ level_id: string | null }>(sql`
    select pv.job_level_id as level_id
      from employment_assignment_versions aav
      join position_versions pv
        on pv.org_id = aav.org_id and pv.position_id = aav.position_id
       and pv.recorded_until is null
     where aav.org_id = ${org.orgId} and aav.employment_id = ${workerEmploymentId}
     order by aav.effective_from desc limit 1`)).rows[0];
  return row?.level_id ?? null;
}

test("F10 fulfilment is not a restricted-read bypass", { skip: !DB }, async () => {
  await withHarness(() => setupPayGapScopeHarness(), async (h) => {
    await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    const req = await requestPayInformation({
      orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmploymentId,
    });
    // In-lens employment, restricted org-wide lens: the fulfil would
    // launder frozen org-wide averages, so it refuses by name.
    await assert.rejects(
      fulfilPayInformationRequest({ orgId: h.org.orgId, actorId: h.scopedAId, requestId: req.id }),
      /measure the whole organization/,
    );
    assert.equal(await requestStatus(h.org.orgId, req.id), "open", "the refused fulfil wrote nothing");
  });
});

test("F13 fulfil/refuse hide out-of-scope requests exactly like missing ones", { skip: !DB }, async () => {
  await withHarness(() => setupPayGapScopeHarness(), async (h) => {
    await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    // A request on subsidiary B employment: hidden from the A-scoped HR.
    const wbUser = await createScratchUser(h.org.orgId, "Gap WB", "gap_wb");
    await grantPermissions(h.org.orgId, wbUser, ["hrm.self.request"]);
    const workerBParty = await linkPerson(h.org.orgId, wbUser);
    const empBWorker = await seedPayGapWorker(h.org.orgId, h.hrId, h.subB, (await levelOf(h.org, h.workerEmploymentId))!, "G2", { workerPartyId: workerBParty });
    const reqB = await requestPayInformation({
      orgId: h.org.orgId, actorId: wbUser, employmentId: empBWorker.employmentId,
    });
    const unknownFulfil = await refusalOf(
      fulfilPayInformationRequest({ orgId: h.org.orgId, actorId: h.scopedAId, requestId: randomUUID() }),
    );
    const hiddenFulfil = await refusalOf(
      fulfilPayInformationRequest({ orgId: h.org.orgId, actorId: h.scopedAId, requestId: reqB.id }),
    );
    assert.deepEqual(hiddenFulfil, unknownFulfil);
    assert.equal(hiddenFulfil.code, "NOT_FOUND");
    const unknownRefuse = await refusalOf(
      refusePayInformationRequest({
        orgId: h.org.orgId, actorId: h.scopedAId, requestId: randomUUID(), reason: "no grounds",
      }),
    );
    const hiddenRefuse = await refusalOf(
      refusePayInformationRequest({
        orgId: h.org.orgId, actorId: h.scopedAId, requestId: reqB.id, reason: "no grounds",
      }),
    );
    assert.deepEqual(hiddenRefuse, unknownRefuse);
    assert.equal(hiddenRefuse.code, "NOT_FOUND");
    assert.equal(await requestStatus(h.org.orgId, reqB.id), "open", "refused mutations wrote nothing");
    // The in-scope HR still fulfils and refuses normally.
    const done = await fulfilPayInformationRequest({
      orgId: h.org.orgId, actorId: h.hrId, requestId: reqB.id,
    });
    assert.equal(done.status, "fulfilled");
    const reqA = await requestPayInformation({
      orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmploymentId,
    });
    const refused = await refusePayInformationRequest({
      orgId: h.org.orgId, actorId: h.hrId, requestId: reqA.id, reason: "answered separately",
    });
    assert.equal(refused.status, "refused");
  });
});
