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
  latestGapSnapshot,
} from "./pay-transparency.ts";

/**
 * F09 DB coverage (integration partition): gap snapshots convert every
 * wage to the org reporting currency before any statistic runs.
 *
 * - mixed CAD/USD year wages convert at the as-of spot quote (the old
 *   code compared natives and reported a 0% gap for 100kCAD vs 100kUSD);
 * - same-currency snapshots need no quote and freeze empty evidence;
 * - a missing quote refuses by name (never 1:1, never omitted) with no
 *   snapshot row written;
 * - the inverse leg arrives pre-oriented and the newest on-or-before
 *   quote wins (future coverage never leaks back);
 * - hour wages annualise with the wage row's own annual-hours, never
 *   the org's current annualHours;
 * - frozen evidence survives later FX and config edits.
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

async function setLaborCosting(orgId: string, patch: Record<string, unknown>): Promise<void> {
  const current = (await db.execute<{ settings: Record<string, unknown> }>(sql`
    select settings from orgs where id = ${orgId}`)).rows[0]?.settings ?? {};
  const next = {
    ...(current as Record<string, unknown>),
    laborCosting: { ...((current as Record<string, unknown>).laborCosting as Record<string, unknown> ?? {}), ...patch },
  };
  await db.execute(sql`update orgs set settings = ${JSON.stringify(next)}::jsonb where id = ${orgId}`);
}

type Harness = { org: ScratchOrg; hrId: string };

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const hrId = await createScratchUser(org.orgId, "FX HR", "fx_hr");
  await grantPermissions(org.orgId, hrId, ["hrm.compensation.read", "hrm.compensation.manage"]);
  await linkPerson(org.orgId, hrId);
  await setCompensationSettings(org.orgId, { comparisonAttributeKey: "eeo_group", gapThresholdPct: 5 });
  return { org, hrId };
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
  wage: { rate: string; currency: string; basis: "hour" | "year"; annualHours: string },
): Promise<void> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${`W ${partyId.slice(0, 6)}`}, true,
            ${JSON.stringify({ eeo_group: group })}::jsonb)
  `);
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
      rate: wage.rate,
      currency: wage.currency,
      basis: wage.basis,
      annualHours: wage.annualHours,
      notes: null,
      reason: "test wage",
    });
  });
}

async function seedFx(
  orgId: string,
  from: string,
  to: string,
  asOf: string,
  rate: string,
  source = "manual",
): Promise<void> {
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${orgId}, ${from}, ${to}, ${asOf}::date, 'spot', ${rate}, ${source})
  `);
}

async function storedMetrics(orgId: string, snapshotId: string): Promise<Record<string, unknown>> {
  const row = (await db.execute<{ metrics: Record<string, unknown> }>(sql`
    select metrics from hrm_pay_gap_snapshots where org_id = ${orgId} and id = ${snapshotId}`)).rows[0];
  assert.ok(row, "snapshot row is readable from storage");
  return row.metrics;
}

async function snapshotCount(orgId: string): Promise<number> {
  const row = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from hrm_pay_gap_snapshots where org_id = ${orgId}`)).rows[0];
  return Number(row?.n ?? "0");
}

test("F09 mixed currencies convert to the reporting currency before any statistic", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const levelId = await seedLevel(org.orgId, h.hrId);
    await seedFx(org.orgId, "USD", "CAD", "2024-01-01", "1.35", "bank");
    await seedWorker(org.orgId, h.hrId, org.subsidiaryId, levelId, "A", {
      rate: "100000", currency: "CAD", basis: "year", annualHours: "2080",
    });
    await seedWorker(org.orgId, h.hrId, org.subsidiaryId, levelId, "B", {
      rate: "100000", currency: "USD", basis: "year", annualHours: "2080",
    });
    const snapshot = await computeGapSnapshot({
      orgId: org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "A", groupB: "B",
    });
    // Converted: A 100000 CAD vs B 135000 CAD — the old code read 0%.
    const expected = ((100000 - 135000) / 135000) * 100;
    assert.ok(
      Math.abs(snapshot.metrics.meanGapPct! - expected) < 0.0001,
      `mean ${snapshot.metrics.meanGapPct}`,
    );
    assert.ok(snapshot.metrics.meanGapPct! < -25, "the gap is real, not the old 0%");
    assert.equal(snapshot.metrics.reportingCurrency, "CAD");
    assert.deepEqual(snapshot.metrics.fxEvidence, {
      USD: { rate: "1.3500000000", asOf: "2024-01-01", source: "bank", inverse: false },
    });
    // Frozen evidence is on the stored row — later FX and config edits
    // cannot reinterpret it.
    const stored = await storedMetrics(org.orgId, snapshot.id);
    assert.equal(stored.reporting_currency, "CAD");
    assert.deepEqual(stored.fx_evidence, {
      USD: { rate: "1.3500000000", as_of: "2024-01-01", source: "bank", inverse: false },
    });
    await seedFx(org.orgId, "USD", "CAD", "2024-05-01", "9.99", "late-arrival");
    await setLaborCosting(org.orgId, { annualHours: 1000 });
    const reread = await latestGapSnapshot({ orgId: org.orgId, actorId: h.hrId });
    assert.deepEqual(reread?.metrics, snapshot.metrics);
  });
});

test("F09 same-currency snapshots need no quote and freeze empty evidence", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const levelId = await seedLevel(org.orgId, h.hrId);
    await seedWorker(org.orgId, h.hrId, org.subsidiaryId, levelId, "A", {
      rate: "100000", currency: "CAD", basis: "year", annualHours: "2080",
    });
    await seedWorker(org.orgId, h.hrId, org.subsidiaryId, levelId, "B", {
      rate: "80000", currency: "CAD", basis: "year", annualHours: "2080",
    });
    const snapshot = await computeGapSnapshot({
      orgId: org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "A", groupB: "B",
    });
    assert.ok(Math.abs(snapshot.metrics.meanGapPct! - 25) < 0.001, `mean ${snapshot.metrics.meanGapPct}`);
    assert.equal(snapshot.metrics.reportingCurrency, "CAD");
    assert.deepEqual({ ...snapshot.metrics.fxEvidence }, {});
  });
});

test("F09 missing FX refuses by name with the remedy and writes nothing", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const levelId = await seedLevel(org.orgId, h.hrId);
    await seedWorker(org.orgId, h.hrId, org.subsidiaryId, levelId, "A", {
      rate: "100000", currency: "CAD", basis: "year", annualHours: "2080",
    });
    await seedWorker(org.orgId, h.hrId, org.subsidiaryId, levelId, "B", {
      rate: "100000", currency: "USD", basis: "year", annualHours: "2080",
    });
    const before = await snapshotCount(org.orgId);
    await assert.rejects(
      computeGapSnapshot({ orgId: org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "A", groupB: "B" }),
      /no spot rate for USD→CAD on or before 2024-06-01.*add an FX spot rate covering the snapshot date/s,
    );
    assert.equal(await snapshotCount(org.orgId), before, "the refused snapshot wrote no row");
  });
});

test("F09 inverse quotes arrive pre-oriented and the newest on-or-before wins", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const levelId = await seedLevel(org.orgId, h.hrId);
    // Only the CAD→USD direction is quoted: USD→CAD must invert once.
    await seedFx(org.orgId, "CAD", "USD", "2024-01-01", "0.75", "bank");
    await seedFx(org.orgId, "CAD", "USD", "2024-03-01", "0.80", "bank");
    // Future coverage must never leak back into the snapshot date.
    await seedFx(org.orgId, "CAD", "USD", "2024-09-01", "0.10", "future");
    await seedWorker(org.orgId, h.hrId, org.subsidiaryId, levelId, "A", {
      rate: "120000", currency: "CAD", basis: "year", annualHours: "2080",
    });
    await seedWorker(org.orgId, h.hrId, org.subsidiaryId, levelId, "B", {
      rate: "90000", currency: "USD", basis: "year", annualHours: "2080",
    });
    const snapshot = await computeGapSnapshot({
      orgId: org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "A", groupB: "B",
    });
    // Winning quote is the 2024-03-01 inverse: 1/0.80 = 1.25, so B is
    // 112500 CAD and the mean gap is (120000-112500)/112500 = 6.6667%.
    assert.equal(snapshot.metrics.fxEvidence.USD?.asOf, "2024-03-01");
    assert.equal(snapshot.metrics.fxEvidence.USD?.inverse, true);
    assert.equal(snapshot.metrics.fxEvidence.USD?.rate, "1.2500000000");
    assert.ok(
      Math.abs(snapshot.metrics.meanGapPct! - 6.6666667) < 0.0001,
      `mean ${snapshot.metrics.meanGapPct}`,
    );
  });
});

test("F09 hour wages annualise with the wage row's own annual-hours", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const levelId = await seedLevel(org.orgId, h.hrId);
    // Same hourly rate, different native annual-hours: 104000 vs 52000.
    // The org's current annualHours is deliberately set to a third
    // value, so any use of it would show.
    await setLaborCosting(org.orgId, { annualHours: 1000 });
    await seedWorker(org.orgId, h.hrId, org.subsidiaryId, levelId, "A", {
      rate: "50", currency: "CAD", basis: "hour", annualHours: "2080",
    });
    await seedWorker(org.orgId, h.hrId, org.subsidiaryId, levelId, "B", {
      rate: "50", currency: "CAD", basis: "hour", annualHours: "1040",
    });
    const snapshot = await computeGapSnapshot({
      orgId: org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "A", groupB: "B",
    });
    assert.ok(Math.abs(snapshot.metrics.meanGapPct! - 100) < 0.001, `mean ${snapshot.metrics.meanGapPct}`);
    assert.ok(Math.abs(snapshot.metrics.medianGapPct! - 100) < 0.001, `median ${snapshot.metrics.medianGapPct}`);
  });
});
