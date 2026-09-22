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

const DB = !!process.env.OPENBOOKS_DB_URL;

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function linkPerson(orgId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'person', ${`Person ${id.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${id} where id = ${userId} and org_id = ${orgId}`);
  return id;
}

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function setCompensationSettings(orgId: string, patch: Record<string, unknown>): Promise<void> {
  const current = (await db.execute<{ settings: Record<string, unknown> }>(sql`
    select settings from orgs where id = ${orgId}`)).rows[0]?.settings ?? {};
  const next = {
    ...(current as Record<string, unknown>),
    compensation: { ...((current as Record<string, unknown>).compensation as Record<string, unknown> ?? {}), ...patch },
  };
  await db.execute(sql`update orgs set settings = ${JSON.stringify(next)}::jsonb where id = ${orgId}`);
}

async function scopeRole(orgId: string, roleKey: string, permissions: string[], subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

type Harness = {
  org: ScratchOrg;
  subB: string;
  hrId: string;
  workerId: string;
  workerEmploymentId: string;
  scopedAId: string;
  scopedNoneId: string;
  scopedAllId: string;
  strangerId: string;
  empA: string;
  empB: string;
};

async function seedLevel(orgId: string, hrId: string): Promise<string> {
  const family = await createJobFamily({ orgId, actorId: hrId, code: "ENG", name: "Engineering" });
  const level = await createJobLevel({
    orgId,
    actorId: hrId,
    familyId: family.id,
    code: "IC3",
    name: "Engineer III",
    rank: 3,
    equalValueCriteria: [
      { criterion: "skills", weight: "3" },
      { criterion: "effort", weight: "2" },
      { criterion: "responsibility", weight: "3" },
      { criterion: "working_conditions", weight: "1" },
    ],
  });
  return level.id;
}

async function seedWorker(
  orgId: string,
  actorId: string,
  subsidiaryId: string,
  levelId: string,
  group: string,
  workerPartyId?: string,
): Promise<{ employmentId: string; workerPartyId: string }> {
  const partyId = workerPartyId ?? randomUUID();
  if (!workerPartyId) {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${partyId}, ${orgId}, 'person', ${`W ${partyId.slice(0, 6)}`}, true,
              ${JSON.stringify({ eeo_group: group })}::jsonb)
    `);
  } else {
    await db.execute(sql`
      update parties set custom = ${JSON.stringify({ eeo_group: group })}::jsonb
       where id = ${partyId} and org_id = ${orgId}`);
  }
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  const positionId = randomUUID();
  await db.execute(sql`
    insert into positions (id, org_id, position_code, revision)
    values (${positionId}, ${orgId}, ${`POS-${positionId.slice(0, 6)}`}, 1)
  `);
  await db.execute(sql`
    insert into position_versions (org_id, position_id, version_no, title, department_id, location_id,
      employer_subsidiary_id, planned_fte, status, effective_from, job_level_id)
    values (${orgId}, ${positionId}, 1, 'Engineer', null, null,
      ${subsidiaryId}, 1, 'filled', '2020-01-01', ${levelId})
  `);
  const assignmentId = randomUUID();
  await db.execute(sql`
    insert into employment_assignments (id, org_id, employment_id, assignment_key)
    values (${assignmentId}, ${orgId}, ${employmentId}, 'primary')
  `);
  await db.execute(sql`
    insert into employment_assignment_versions (org_id, assignment_id, employment_id, version_no,
      job_title, department_id, fte, is_primary, effective_from, position_id)
    values (${orgId}, ${assignmentId}, ${employmentId}, 1,
      'Engineer', null, 1, true, '2020-01-01', ${positionId})
  `);
  const { withOrgTransaction } = await import("../../platform/db.ts");
  const { supersedeLaborCostRate } = await import("../../projects/labor-cost-rates.ts");
  await withOrgTransaction(orgId, async () => {
    await supersedeLaborCostRate({
      orgId,
      actorId,
      scope: { employeePartyId: partyId, jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null },
      effectiveFrom: "2020-01-01",
      rate: group === "G1" ? "100000" : "80000",
      currency: "CAD",
      basis: "year",
      annualHours: "2080",
      notes: null,
      reason: "test wage",
    });
  });
  return { employmentId, workerPartyId: partyId };
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const hrId = await createScratchUser(org.orgId, "Gap HR", "gap_hr");
  await grantPermissions(org.orgId, hrId, ["hrm.compensation.read", "hrm.compensation.manage"]);
  await linkPerson(org.orgId, hrId);
  await setCompensationSettings(org.orgId, {
    comparisonAttributeKey: "eeo_group",
    gapThresholdPct: 5,
    responseDays: 30,
  });
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
      from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
  const levelId = await seedLevel(org.orgId, hrId);
  // G1 in A, G2 in B: both comparison sides priced, across subsidiaries.
  const empA = await seedWorker(org.orgId, hrId, org.subsidiaryId, levelId, "G1");
  const empB = await seedWorker(org.orgId, hrId, subB, levelId, "G2");
  // Self-service worker with their own positioned employment in A.
  const workerId = await createScratchUser(org.orgId, "Gap Worker", "gap_worker");
  await grantPermissions(org.orgId, workerId, ["hrm.self.request"]);
  const workerParty = await linkPerson(org.orgId, workerId);
  const workerEmp = await seedWorker(org.orgId, hrId, org.subsidiaryId, levelId, "G1", workerParty);
  const scopedAId = await createScratchUser(org.orgId, "Gap Scoped A", "gap_scoped_a");
  await scopeRole(org.orgId, "gap_scoped_a", ["hrm.compensation.read", "hrm.compensation.manage"], [org.subsidiaryId]);
  const scopedNoneId = await createScratchUser(org.orgId, "Gap Scoped None", "gap_scoped_none");
  await scopeRole(org.orgId, "gap_scoped_none", ["hrm.compensation.read", "hrm.compensation.manage"], []);
  const scopedAllId = await createScratchUser(org.orgId, "Gap Scoped All", "gap_scoped_all");
  await scopeRole(
    org.orgId,
    "gap_scoped_all",
    ["hrm.compensation.read", "hrm.compensation.manage"],
    [org.subsidiaryId, subB],
  );
  const strangerId = await createScratchUser(org.orgId, "Gap Stranger", "gap_stranger");
  await linkPerson(org.orgId, strangerId);
  return {
    org, subB, hrId, workerId, workerEmploymentId: workerEmp.employmentId,
    scopedAId, scopedNoneId, scopedAllId, strangerId,
    empA: empA.employmentId, empB: empB.employmentId,
  };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  if (!DB) return;
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

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
async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { code: typeof code === "string" ? code : (e as Error).name, message: (e as Error).message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

test("F10 unrestricted HR keeps full compute and latest access", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const snapshot = await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    assert.ok(snapshot.id);
    const reread = await latestGapSnapshot({ orgId: h.org.orgId, actorId: h.hrId });
    assert.equal(reread?.id, snapshot.id);
  });
});

test("F10 subsidiary-restricted lenses cannot compute org-wide snapshots", { skip: !DB }, async () => {
  await withHarness(async (h) => {
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
  await withHarness(async (h) => {
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
  await withHarness(async (h) => {
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
  await withHarness(async (h) => {
    const req = await requestPayInformation({
      orgId: h.org.orgId, actorId: h.workerId, employmentId: h.workerEmploymentId,
    });
    assert.equal(req.status, "open");
    assert.equal(await requestStatus(h.org.orgId, req.id), "open");
    // Identity alone files nothing: a grant-less owner is refused by name.
    const nogId = await createScratchUser(h.org.orgId, "Gap Nog", "gap_nog");
    const nogParty = await linkPerson(h.org.orgId, nogId);
    const nogEmp = await seedWorker(h.org.orgId, h.hrId, h.org.subsidiaryId, (await levelOf(h))!, "G1", nogParty);
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

async function levelOf(h: Harness): Promise<string | null> {
  const row = (await db.execute<{ level_id: string | null }>(sql`
    select pv.job_level_id as level_id
      from employment_assignment_versions aav
      join position_versions pv
        on pv.org_id = aav.org_id and pv.position_id = aav.position_id
       and pv.recorded_until is null
     where aav.org_id = ${h.org.orgId} and aav.employment_id = ${h.workerEmploymentId}
     order by aav.effective_from desc limit 1`)).rows[0];
  return row?.level_id ?? null;
}

test("F10 fulfilment is not a restricted-read bypass", { skip: !DB }, async () => {
  await withHarness(async (h) => {
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
  await withHarness(async (h) => {
    await computeGapSnapshot({
      orgId: h.org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "G1", groupB: "G2",
    });
    // A request on subsidiary B employment: hidden from the A-scoped HR.
    const wbUser = await createScratchUser(h.org.orgId, "Gap WB", "gap_wb");
    await grantPermissions(h.org.orgId, wbUser, ["hrm.self.request"]);
    const workerBParty = await linkPerson(h.org.orgId, wbUser);
    const empBWorker = await seedWorker(h.org.orgId, h.hrId, h.subB, (await levelOf(h))!, "G2", workerBParty);
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
