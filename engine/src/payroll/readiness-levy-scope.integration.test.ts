import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { payRunStaleness } from "./readiness.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// Employer-levy staleness used to fire across packs and scopes: the
// 'consumed' query filtered only org, year, status and timestamp, so a
// calculated CA run went stale on ANY committed or voided run in the tax
// year — a US pack, another subsidiary, a disjoint roster — while arming
// read schedule-wide profiles with no termination filter. Staleness is now
// scoped to runs sharing the pack, the levy's aggregation unit (the
// employer as a whole, or the employer in one region), and — for
// per-employee caps — the affected employees; terminated profiles arm
// nothing.

async function setup(orgId: string, actorId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = settings || '{"features":{"payroll":true}}'::jsonb
     where id = ${orgId}`);
  await seedPayrollComponents(orgId, actorId, "CA");
  await seedPayrollComponents(orgId, actorId, "US");
}

async function makeSchedule(orgId: string, actorId: string): Promise<string> {
  const id = randomUUID();
  const name = `Biweekly ${randomUUID().slice(0, 8)}`;
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${id}, ${orgId}, ${name}, 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);
  return id;
}

async function makeEmployee(
  orgId: string,
  actorId: string,
  scheduleId: string,
  name: string,
  country: string,
  province: string,
  terminatedOn: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, terminated_on)
    values (${randomUUID()}, ${orgId}, ${id}, ${terminatedOn})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${orgId}, ${id}, 'CAD', '30', 'hour', '2080', '2026-01-01', true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           vacation_percent, vacation_method, is_active,
                                           created_by, updated_by)
    values (${orgId}, ${id}, ${scheduleId}, ${country}, ${province}, 'hourly', 1, 1,
            '4', 'accrue', true, ${actorId}, ${actorId})`);
  return id;
}

async function makeRun(orgId: string, actorId: string, scheduleId: string): Promise<{ documentId: string }> {
  return createPayRun({
    orgId, actorId, payScheduleId: scheduleId,
    periodStart: "2026-07-05", periodEnd: "2026-07-18",
  });
}

/** Mark a run committed after the given timestamp without the commit path. */
async function markCommittedAfter(
  orgId: string,
  documentId: string,
  after: string,
): Promise<void> {
  await db.execute(sql`
    update pay_runs set run_status = 'committed', updated_at = ${after}::timestamptz + interval '1 minute'
     where org_id = ${orgId} and document_id = ${documentId}`);
}

async function levyStale(orgId: string, documentId: string): Promise<boolean> {
  const staleness = await payRunStaleness(orgId, documentId);
  return staleness.reasons.includes("employerLevyYtd");
}

test("a committed US-pack run does not stale a calculated CA run", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  try {
    await setup(org.orgId, actorId);
    const caSchedule = await makeSchedule(org.orgId, actorId);
    const usSchedule = await makeSchedule(org.orgId, actorId);
    await makeEmployee(org.orgId, actorId, caSchedule, "Amy CA", "CA", "ON");
    await makeEmployee(org.orgId, actorId, usSchedule, "Uma US", "US", "CA");
    const caRun = await makeRun(org.orgId, actorId, caSchedule);
    const { calculatePayRun } = await import("./run-calculation.ts");
    await calculatePayRun({ orgId: org.orgId, documentId: caRun.documentId, actorId });
    const calculated = (await db.execute<{ calculated_at: string }>(sql`
      select calculated_at::text as calculated_at from pay_runs
       where org_id = ${org.orgId} and document_id = ${caRun.documentId}`)).rows[0]!;
    const usRun = await makeRun(org.orgId, actorId, usSchedule);
    await markCommittedAfter(org.orgId, usRun.documentId, calculated.calculated_at);
    assert.equal(await levyStale(org.orgId, caRun.documentId), false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a committed CA run still stales a calculated CA run sharing the province", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  try {
    await setup(org.orgId, actorId);
    const scheduleA = await makeSchedule(org.orgId, actorId);
    const scheduleB = await makeSchedule(org.orgId, actorId);
    await makeEmployee(org.orgId, actorId, scheduleA, "Amy CA", "CA", "ON");
    await makeEmployee(org.orgId, actorId, scheduleB, "Bob CA", "CA", "ON");
    const runA = await makeRun(org.orgId, actorId, scheduleA);
    const runB = await makeRun(org.orgId, actorId, scheduleB);
    const { calculatePayRun } = await import("./run-calculation.ts");
    await calculatePayRun({ orgId: org.orgId, documentId: runB.documentId, actorId });
    const calculated = (await db.execute<{ calculated_at: string }>(sql`
      select calculated_at::text as calculated_at from pay_runs
       where org_id = ${org.orgId} and document_id = ${runB.documentId}`)).rows[0]!;
    await markCommittedAfter(org.orgId, runA.documentId, calculated.calculated_at);
    assert.equal(await levyStale(org.orgId, runB.documentId), true);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a terminated roster arms nothing, so a later CA commit does not stale it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  try {
    await setup(org.orgId, actorId);
    const scheduleA = await makeSchedule(org.orgId, actorId);
    const scheduleB = await makeSchedule(org.orgId, actorId);
    // Terminated before the run period: not paid, claims no room.
    await makeEmployee(org.orgId, actorId, scheduleA, "Tam CA", "CA", "ON", "2026-07-01");
    await makeEmployee(org.orgId, actorId, scheduleB, "Bob CA", "CA", "ON");
    const runA = await makeRun(org.orgId, actorId, scheduleA);
    const runB = await makeRun(org.orgId, actorId, scheduleB);
    const { calculatePayRun } = await import("./run-calculation.ts");
    await calculatePayRun({ orgId: org.orgId, documentId: runA.documentId, actorId });
    const calculated = (await db.execute<{ calculated_at: string }>(sql`
      select calculated_at::text as calculated_at from pay_runs
       where org_id = ${org.orgId} and document_id = ${runA.documentId}`)).rows[0]!;
    await markCommittedAfter(org.orgId, runB.documentId, calculated.calculated_at);
    assert.equal(await levyStale(org.orgId, runA.documentId), false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
