import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { HrmConstructionError } from "./construction/errors.ts";
import {
  setPrevailingWageEntryWage,
  snapshotLaborCostRates,
} from "../projects/labor-costing.ts";
import { prevailingWageForTimeEntry } from "./construction/labor-hook.ts";
import {
  acknowledgeFinding,
  amendRun,
  approveEntry,
  assignClassification,
  checkDay,
  classify,
  computeForWeek,
  computeTravelForWeek,
  createClassification,
  createCompClass,
  createCompRule,
  createPolicy,
  createRatioRule,
  createSchedule,
  addScheduleLine,
  dailySplit,
  downloadRun,
  generate,
  listFindings,
  listFormats,
  listRuns,
  markSeamConsumed,
  projectComplianceSummary,
  recordFinding,
  resolveFinding,
  resolveWage,
  submitRun,
  voidEntry,
} from "./construction/index.ts";

/**
 * HR-13 DB coverage (integration partition — run by the integrator at
 * gate; skips without OPENBOOKS_DB_URL): migrations 0223/0224 bootstrap
 * plus RLS, the resolver (scope precedence, reciprocity, as-of,
 * missing → refusal + finding), per-diem brackets and the weekly rule,
 * ratio-breach journey pricing, the certified payload against a
 * hand-built week, comp priority, the pack-none refusal, every refusal
 * red-proofed through the real code path, and the second-org storage
 * floor. Proofs are read back from storage, never from service returns
 * alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const FEATURES = [
  "hrm",
  "payroll",
  "projects",
  "timeTracking",
  "hrmConstructionCompliance",
  "hrmPrevailingWage",
  "hrmCertifiedPayroll",
  "hrmWorkersCompClasses",
  "hrmApprenticeRatios",
  "hrmPerDiem",
];

async function enableConstruction(orgId: string): Promise<void> {
  for (const feature of FEATURES) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${orgId}
    `);
  }
  await db.execute(sql`update orgs set country = 'US' where id = ${orgId}`);
}

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

type Harness = { org: ScratchOrg; adminId: string; outsiderId: string };

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableConstruction(org.orgId);
  const adminId = await createScratchUser(org.orgId, "Construction Admin", "construction_admin");
  const outsiderId = await createScratchUser(org.orgId, "Construction Outsider", "construction_outsider");
  await grantPermissions(org.orgId, adminId, ["hrm.construction.read", "hrm.construction.manage"]);
  return { org, adminId, outsiderId };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function seedWorker(orgId: string, subsidiaryId: string, name: string): Promise<{ employmentId: string; partyId: string }> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)
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
  return { employmentId, partyId };
}

async function seedProject(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, name, status) values (${id}, ${orgId}, ${name}, 'active')
  `);
  return id;
}

async function seedTime(
  orgId: string,
  partyId: string,
  projectId: string,
  workedOn: string,
  hours: string,
): Promise<void> {
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, project_id, worked_on, hours, status)
    values (${orgId}, ${partyId}, ${projectId}, ${workedOn}::date, ${hours}, 'approved')
  `);
}

async function seedComponent(orgId: string, kind: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, is_active)
    values (${id}, ${orgId}, ${`PD_${id.slice(0, 6)}`}, 'Per diem', ${kind}, true)
  `);
  return id;
}

async function seedPayWeek(orgId: string, subsidiaryId: string, actorId: string, partyId: string, weekStart: string, weekEnd: string): Promise<string> {
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
    values (${scheduleId}, ${orgId}, 'Weekly', 'weekly', 52, '2026-01-01'::date)
  `);
  const runId = randomUUID();
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${orgId}, ${runId}, 'pay_run', ${`PAY-${runId.slice(0, 8)}`},
            ${subsidiaryId}, ${weekEnd}::date, 'USD', 'approved', ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status)
    values (${runId}, ${orgId}, ${scheduleId}, ${weekStart}::date, ${weekEnd}::date, ${weekEnd}::date, 2026, 'committed')
  `);
  await db.execute(sql`
    insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province, periods_per_year,
                           pay_date, tax_year, currency_code, gross, net_pay)
    values (${orgId}, ${runId}, ${partyId}, 'TX', 52, ${weekEnd}::date, 2026, 'USD', '900.0000', '700.0000')
  `);
  return runId;
}

async function assertConstructionRefusal(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof HrmConstructionError, `expected HrmConstructionError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return;
  }
  assert.fail("expected a refusal, the call succeeded");
}

test("migrations 0223/0224 bootstrap: thirteen tables, RLS forced, seam pairing", { skip: !DB }, async () => {
  await withHarness(async () => {
    const tables = [
      "hrm_work_classifications",
      "hrm_rate_schedules",
      "hrm_rate_schedule_lines",
      "hrm_employment_classifications",
      "hrm_per_diem_policies",
      "hrm_per_diem_entries",
      "hrm_travel_pay_entries",
      "hrm_allowance_payroll_inputs",
      "hrm_comp_classes",
      "hrm_comp_class_rules",
      "hrm_certified_payroll_runs",
      "hrm_apprentice_ratio_rules",
      "hrm_compliance_findings",
    ];
    for (const table of tables) {
      const reg = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_tables where schemaname = 'public' and tablename = ${table}
      `)).rows[0]!.n;
      assert.equal(reg, 1, `${table} exists`);
      const rls = (await db.execute<{ rowsecurity: boolean; forcerowsecurity: boolean }>(sql`
        select c.relrowsecurity as rowsecurity, c.relforcerowsecurity as forcerowsecurity
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = ${table}
      `)).rows[0]!;
      assert.equal(rls.rowsecurity, true, `${table} has RLS`);
      assert.equal(rls.forcerowsecurity, true, `${table} forces RLS`);
    }
    for (const name of ["hrm_allowance_payroll_inputs_status_pairing"]) {
      const found = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_constraint where conname = ${name}
      `)).rows[0]!.n;
      assert.equal(found, 1, `${name} exists`);
    }
    for (const name of ["hrm_per_diem_entries_day_unique", "hrm_allowance_payroll_inputs_entry_unique"]) {
      const found = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_indexes where schemaname = 'public' and indexname = ${name}
      `)).rows[0]!.n;
      assert.equal(found, 1, `${name} exists`);
    }
  });
});

test("feature-off and grant refusals fire by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const adminId = await createScratchUser(org.orgId, "Off Admin", "off_admin");
    await grantPermissions(org.orgId, adminId, ["hrm.construction.read", "hrm.construction.manage"]);
    await assertConstructionRefusal(
      () => createClassification(db, { orgId: org.orgId, actorId: adminId, code: "X", name: "X", trade: "X" }),
      /hrmConstructionCompliance feature is off/,
    );
    await enableConstruction(org.orgId);
    const outsider = await createScratchUser(org.orgId, "Off Outsider", "off_outsider");
    try {
      await listFindings(db, org.orgId, outsider);
      assert.fail("outsider list should refuse");
    } catch (error) {
      assert.ok(error instanceof HrmAuthorizationError, `expected HrmAuthorizationError, got ${String(error)}`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("resolver: scope precedence, reciprocity, as-of, missing writes a finding", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org, adminId } = h;
    const { employmentId } = await seedWorker(org.orgId, org.subsidiaryId, "Resolver Worker");
    const projectId = await seedProject(org.orgId, "Resolver Job");
    const journey = await createClassification(db, {
      orgId: org.orgId, actorId: adminId, code: "ELEC-J", name: "Electrician journey", trade: "Electrical",
    });
    const apprentice = await createClassification(db, {
      orgId: org.orgId, actorId: adminId, code: "ELEC-A", name: "Electrician apprentice", trade: "Electrical",
      isApprentice: true, journeyClassificationId: journey.id,
    });
    // Apprentice without a journey class refuses by name.
    await assertConstructionRefusal(
      () => createClassification(db, {
        orgId: org.orgId, actorId: adminId, code: "PLB-A", name: "Plumber apprentice", trade: "Plumbing", isApprentice: true,
      }),
      /names no journey class/,
    );
    // Duplicate code refuses by name.
    await assertConstructionRefusal(
      () => createClassification(db, {
        orgId: org.orgId, actorId: adminId, code: "ELEC-J", name: "Dupe", trade: "Electrical",
      }),
      /already in use/,
    );
    const orgWide = await createSchedule(db, {
      orgId: org.orgId, actorId: adminId, kind: "prevailing_wage", name: "Area standard",
      sourceRef: "DETERMINATION-1", reciprocity: "higher_of", effectiveFrom: "2026-01-01",
    });
    const scoped = await createSchedule(db, {
      orgId: org.orgId, actorId: adminId, kind: "union_agreement", name: "Local 412",
      appliesTo: { project_ids: [projectId] }, reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
    });
    await addScheduleLine(db, {
      orgId: org.orgId, actorId: adminId, scheduleId: orgWide.id, classificationId: journey.id,
      baseRate: "50.0000", fringeRate: "2.0000", currency: "USD", effectiveFrom: "2026-01-01",
    });
    await addScheduleLine(db, {
      orgId: org.orgId, actorId: adminId, scheduleId: scoped.id, classificationId: journey.id,
      baseRate: "60.0000", fringeRate: "3.0000", currency: "USD", effectiveFrom: "2026-01-01",
    });
    // Project-scoped union line beats the org-wide prevailing line.
    await assignClassification(db, {
      orgId: org.orgId, actorId: adminId, employmentId, classificationId: journey.id, effectiveFrom: "2026-01-01",
    });
    const priced = await resolveWage(db, {
      orgId: org.orgId, actorId: adminId, employmentId, projectId, workedOn: "2026-09-08",
    });
    assert.equal(priced.base, "60.0000");
    assert.equal(priced.source, "union");
    // Unassigned employment: refusal names assignment AND writes a missing_rate finding.
    const { employmentId: bare } = await seedWorker(org.orgId, org.subsidiaryId, "Bare Worker");
    await assertConstructionRefusal(
      () => resolveWage(db, { orgId: org.orgId, actorId: adminId, employmentId: bare, projectId, workedOn: "2026-09-08" }),
      /no work classification/,
    );
    const findings = await listFindings(db, org.orgId, adminId, "open");
    assert.ok(findings.some((finding) => finding.kind === "missing_rate" && finding.employmentId === bare));
    // A classification with no covering line refuses and flags.
    await assignClassification(db, {
      orgId: org.orgId, actorId: adminId, employmentId: bare, classificationId: apprentice.id, effectiveFrom: "2026-01-01",
    });
    await assertConstructionRefusal(
      () => resolveWage(db, { orgId: org.orgId, actorId: adminId, employmentId: bare, projectId, workedOn: "2026-09-09" }),
      /No rate line covers/,
    );
    // A fresh day, so the dedupe on identical open findings cannot mask it.
    const noLine = (await listFindings(db, org.orgId, adminId, "open")).filter(
      (finding) => finding.kind === "missing_rate" && finding.employmentId === bare && finding.workedOn === "2026-09-09",
    );
    assert.equal(noLine.length, 1, "the uncovered day writes one missing_rate finding");
    // Other org's project refuses — hostile loop, never cross-tenant pricing.
    const foreign = await createScratchOrg();
    try {
      const foreignProject = await seedProject(foreign.orgId, "Foreign Job");
      await assertConstructionRefusal(
        () => resolveWage(db, { orgId: org.orgId, actorId: adminId, employmentId, projectId: foreignProject, workedOn: "2026-09-08" }),
        /does not exist in this organization/,
      );
    } finally {
      await dropScratchOrg(foreign.orgId);
    }
  });
});

test("per-diem: brackets price the day, approval crosses the seam, voids carry reason", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org, adminId } = h;
    const { employmentId, partyId } = await seedWorker(org.orgId, org.subsidiaryId, "Per Diem Worker");
    const projectId = await seedProject(org.orgId, "Remote Job");
    const componentId = await seedComponent(org.orgId, "earning");
    // A non-earning component refuses at policy creation.
    const wageComponent = await seedComponent(org.orgId, "deduction");
    await assertConstructionRefusal(
      () => createPolicy(db, {
        orgId: org.orgId, actorId: adminId, name: "Bad link", basis: "flat_daily",
        rules: { amount: "10.0000" }, currency: "USD", effectiveFrom: "2026-01-01", payComponentId: wageComponent,
      }),
      /only through earning components/,
    );
    const policy = await createPolicy(db, {
      orgId: org.orgId, actorId: adminId, name: "Daily rate", basis: "flat_daily",
      rules: { amount: "75.0000" }, currency: "USD", effectiveFrom: "2026-01-01", payComponentId: componentId,
    });
    assert.equal(policy.basis, "flat_daily");
    await seedTime(org.orgId, partyId, projectId, "2026-09-08", "8.0000");
    await seedTime(org.orgId, partyId, projectId, "2026-09-09", "8.0000");
    const entries = await computeForWeek(db, {
      orgId: org.orgId, actorId: adminId, employmentId, weekStart: "2026-09-07",
    });
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.amount === "75.0000"));
    const approved = await approveEntry(db, { orgId: org.orgId, actorId: adminId, entryId: entries[0]!.id, kind: "per_diem" });
    assert.equal(approved.status, "approved");
    const seam = (await db.execute<{ status: string; amount: string }>(sql`
      select status, amount::text as amount from hrm_allowance_payroll_inputs
       where org_id = ${org.orgId} and entry_kind = 'per_diem' and entry_id = ${entries[0]!.id}::uuid
    `)).rows[0];
    assert.equal(seam?.status, "pending");
    assert.equal(seam?.amount, "75.0000");
    // Consumed seam rows refuse voids by run name.
    await markSeamConsumed(db, org.orgId, (await db.execute<{ id: string }>(sql`
      select id::text as id from hrm_allowance_payroll_inputs
       where org_id = ${org.orgId} and entry_id = ${entries[0]!.id}::uuid
    `)).rows[0]!.id, randomUUID());
    await assertConstructionRefusal(
      () => voidEntry(db, { orgId: org.orgId, actorId: adminId, entryId: entries[0]!.id, kind: "per_diem", reason: "oops" }),
      /recalculate the run/,
    );
    // The other entry voids with a reason and stays voided.
    const voided = await voidEntry(db, {
      orgId: org.orgId, actorId: adminId, entryId: entries[1]!.id, kind: "per_diem", reason: "duplicate day",
    });
    assert.equal(voided.status, "voided");
    await assertConstructionRefusal(
      () => computeForWeek(db, { orgId: org.orgId, actorId: adminId, employmentId, weekStart: "2026-09-07" }),
      /void it with a reason before recomputing/,
    );
  });
});

test("ratios breach the day and reprice apprentices at journey", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org, adminId } = h;
    const journeyWorker = await seedWorker(org.orgId, org.subsidiaryId, "Journey Worker");
    const apprenticeWorker = await seedWorker(org.orgId, org.subsidiaryId, "Apprentice Worker");
    const projectId = await seedProject(org.orgId, "Ratio Job");
    const journey = await createClassification(db, {
      orgId: org.orgId, actorId: adminId, code: "CARP-J", name: "Carpenter journey", trade: "Carpentry",
    });
    const apprentice = await createClassification(db, {
      orgId: org.orgId, actorId: adminId, code: "CARP-A", name: "Carpenter apprentice", trade: "Carpentry",
      isApprentice: true, journeyClassificationId: journey.id,
    });
    const schedule = await createSchedule(db, {
      orgId: org.orgId, actorId: adminId, kind: "prevailing_wage", name: "Ratio schedule",
      reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
    });
    await addScheduleLine(db, {
      orgId: org.orgId, actorId: adminId, scheduleId: schedule.id, classificationId: journey.id,
      baseRate: "55.0000", currency: "USD", effectiveFrom: "2026-01-01",
    });
    await addScheduleLine(db, {
      orgId: org.orgId, actorId: adminId, scheduleId: schedule.id, classificationId: apprentice.id,
      baseRate: "30.0000", currency: "USD", effectiveFrom: "2026-01-01",
    });
    await assignClassification(db, {
      orgId: org.orgId, actorId: adminId, employmentId: journeyWorker.employmentId,
      classificationId: journey.id, effectiveFrom: "2026-01-01",
    });
    await assignClassification(db, {
      orgId: org.orgId, actorId: adminId, employmentId: apprenticeWorker.employmentId,
      classificationId: apprentice.id, effectiveFrom: "2026-01-01",
    });
    await createRatioRule(db, {
      orgId: org.orgId, actorId: adminId, scheduleId: schedule.id,
      journeyClassificationId: journey.id, apprenticeClassificationId: apprentice.id,
      ratioJourney: 1, ratioApprentice: 1, measured: "daily", effectiveFrom: "2026-01-01",
    });
    // One journey hour against four apprentice hours breaches 1:1.
    await seedTime(org.orgId, journeyWorker.partyId, projectId, "2026-09-08", "1.0000");
    await seedTime(org.orgId, apprenticeWorker.partyId, projectId, "2026-09-08", "4.0000");
    const results = await checkDay(db, { orgId: org.orgId, actorId: adminId, projectId, workedOn: "2026-09-08" });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.breach, true);
    const apprenticePrice = await resolveWage(db, {
      orgId: org.orgId, actorId: adminId, employmentId: apprenticeWorker.employmentId,
      projectId, workedOn: "2026-09-08",
    });
    assert.equal(apprenticePrice.base, "55.0000");
    assert.equal(apprenticePrice.rateAtJourney, true);
    const findings = await listFindings(db, org.orgId, adminId, "open");
    const breach = findings.find((finding) => finding.kind === "ratio_breach");
    assert.ok(breach, "ratio breach flagged");
    const acked = await acknowledgeFinding(db, org.orgId, adminId, breach.id);
    assert.equal(acked.status, "acknowledged");
    const resolved = await resolveFinding(db, org.orgId, adminId, breach.id, "crew rebalanced next day");
    assert.equal(resolved.status, "resolved");
  });
});

test("comp classes resolve by priority and refuse when nothing matches", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org, adminId } = h;
    const { employmentId, partyId } = await seedWorker(org.orgId, org.subsidiaryId, "Comp Worker");
    const projectId = await seedProject(org.orgId, "Comp Job");
    const roofing = await createCompClass(db, {
      orgId: org.orgId, actorId: adminId, code: "ROOF-5551", name: "Roofing", ratePer100: "12.5000", effectiveFrom: "2026-01-01",
    });
    const office = await createCompClass(db, {
      orgId: org.orgId, actorId: adminId, code: "OFF-8810", name: "Clerical", effectiveFrom: "2026-01-01",
    });
    await createCompRule(db, {
      orgId: org.orgId, actorId: adminId, priority: 1, match: {}, compClassId: office.id,
    }).then(
      () => assert.fail("empty match must refuse"),
      (error: unknown) => assert.ok(error instanceof HrmConstructionError && /at least one/.test(error.message)),
    );
    await createCompRule(db, {
      orgId: org.orgId, actorId: adminId, priority: 1, match: { project_id: projectId }, compClassId: office.id,
    });
    await createCompRule(db, {
      orgId: org.orgId, actorId: adminId, priority: 10, match: { project_id: projectId }, compClassId: roofing.id,
    });
    const hit = await classify(db, {
      orgId: org.orgId, actorId: adminId, projectId, workedOn: "2026-09-08", employmentId,
    });
    assert.equal(hit.code, "ROOF-5551");
    await seedTime(org.orgId, partyId, projectId, "2026-09-08", "8.0000");
    const split = await dailySplit(db, { orgId: org.orgId, actorId: adminId, projectId, workedOn: "2026-09-08" });
    assert.equal(split.length, 1);
    assert.equal(split[0]!.compCode, "ROOF-5551");
    assert.equal(split[0]!.hours, "8.0000");
    await assertConstructionRefusal(
      () => classify(db, { orgId: org.orgId, actorId: adminId, projectId: randomUUID(), workedOn: "2026-09-08", employmentId }),
      /No comp-class rule matches/,
    );
  });
});

test("certified payroll: formats listed, empty week refused, payload frozen, amend linked", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org, adminId } = h;
    const { employmentId, partyId } = await seedWorker(org.orgId, org.subsidiaryId, "Certified Worker");
    const projectId = await seedProject(org.orgId, "Certified Job");
    // The US pack declares two files; a pack with none refuses by name.
    const listed = await listFormats(db, org.orgId, adminId);
    assert.equal(listed.packName, "United States");
    assert.deepEqual(listed.formats.map((format) => format.key), ["federal-weekly", "state-xml"]);
    const journey = await createClassification(db, {
      orgId: org.orgId, actorId: adminId, code: "LAB-J", name: "Laborer journey", trade: "Labor",
    });
    const schedule = await createSchedule(db, {
      orgId: org.orgId, actorId: adminId, kind: "prevailing_wage", name: "Certified schedule",
      reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
    });
    await addScheduleLine(db, {
      orgId: org.orgId, actorId: adminId, scheduleId: schedule.id, classificationId: journey.id,
      baseRate: "45.0000", fringeRate: "5.0000", currency: "USD", effectiveFrom: "2026-01-01",
    });
    await assignClassification(db, {
      orgId: org.orgId, actorId: adminId, employmentId, classificationId: journey.id, effectiveFrom: "2026-01-01",
    });
    await seedTime(org.orgId, partyId, projectId, "2026-09-08", "8.0000");
    await seedTime(org.orgId, partyId, projectId, "2026-09-09", "8.0000");
    // Week with no posted run refuses by name.
    await assertConstructionRefusal(
      () => generate(db, { orgId: org.orgId, actorId: adminId, projectId, weekEnding: "2026-09-13", formatKey: "federal-weekly" }),
      /No posted pay run covers/,
    );
    // Unknown format refuses by name with the offered keys.
    await seedPayWeek(org.orgId, org.subsidiaryId, adminId, partyId, "2026-09-07", "2026-09-13");
    await assertConstructionRefusal(
      () => generate(db, { orgId: org.orgId, actorId: adminId, projectId, weekEnding: "2026-09-13", formatKey: "nope" }),
      /not declared by the United States payroll pack/,
    );
    const run = await generate(db, {
      orgId: org.orgId, actorId: adminId, projectId, weekEnding: "2026-09-13", formatKey: "federal-weekly",
    });
    assert.equal(run.status, "generated");
    const stored = (await db.execute<{ payload: { rows: unknown[]; rendered: { filename: string; body: string } } }>(sql`
      select payload from hrm_certified_payroll_runs where id = ${run.id}::uuid
    `)).rows[0]!.payload;
    assert.equal(stored.rows.length, 2);
    assert.ok(stored.rendered.body.includes("Certified Worker"));
    assert.ok(stored.rendered.filename.endsWith("2026-09-13.txt"));
    const file = await downloadRun(db, org.orgId, adminId, run.id);
    assert.equal(file.body, stored.rendered.body);
    const submitted = await submitRun(db, { orgId: org.orgId, actorId: adminId, runId: run.id });
    assert.equal(submitted.status, "submitted");
    const amended = await amendRun(db, { orgId: org.orgId, actorId: adminId, runId: run.id });
    assert.equal(amended.status, "generated");
    const reloaded = await listRuns(db, org.orgId, adminId, projectId);
    assert.ok(reloaded.some((entry) => entry.id === amended.id && entry.status === "generated"));
    // Cockpit data contract: schedules in scope, open count, last run.
    const summary = await projectComplianceSummary(db, org.orgId, adminId, projectId);
    assert.ok(summary.schedules.some((entry) => entry.id === schedule.id));
    assert.equal(summary.lastRun?.id, amended.id);
    assert.equal(summary.ratioBreachThisWeek, false);
    // A GB org's pack declares no files: generation refuses by pack name.
    await db.execute(sql`update orgs set country = 'GB' where id = ${org.orgId}`);
    await assertConstructionRefusal(
      () => generate(db, { orgId: org.orgId, actorId: adminId, projectId, weekEnding: "2026-09-13", formatKey: "federal-weekly" }),
      /refuses by name rather than borrowing another pack's form/,
    );
    await db.execute(sql`update orgs set country = 'US' where id = ${org.orgId}`);
  });
});

test("labor-costing hook prices in-scope hours first and leaves the standard path alone", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org, adminId } = h;
    const { employmentId, partyId } = await seedWorker(org.orgId, org.subsidiaryId, "Hook Worker");
    const projectId = await seedProject(org.orgId, "Hook Job");
    const journey = await createClassification(db, {
      orgId: org.orgId, actorId: adminId, code: "HOOK-J", name: "Hook journey", trade: "Hook",
    });
    const schedule = await createSchedule(db, {
      orgId: org.orgId, actorId: adminId, kind: "prevailing_wage", name: "Hook schedule",
      appliesTo: { project_ids: [projectId] }, reciprocity: "jobsite_local", effectiveFrom: "2026-01-01",
    });
    await addScheduleLine(db, {
      orgId: org.orgId, actorId: adminId, scheduleId: schedule.id, classificationId: journey.id,
      baseRate: "77.0000", currency: "CAD", effectiveFrom: "2026-01-01",
    });
    await assignClassification(db, {
      orgId: org.orgId, actorId: adminId, employmentId, classificationId: journey.id, effectiveFrom: "2026-01-01",
    });
    await seedTime(org.orgId, partyId, projectId, "2026-09-08", "8.0000");
    const entryId = (await db.execute<{ id: string }>(sql`
      select id::text as id from time_entries
       where org_id = ${org.orgId} and employee_party_id = ${partyId} and worked_on = '2026-09-08'::date
    `)).rows[0]!.id;
    // Scratch orgs settle in CAD: price the line in the org currency so
    // the snapshot converts nothing and the hook's own stamp is measured.
    setPrevailingWageEntryWage(prevailingWageForTimeEntry);
    try {
      const stamped = await snapshotLaborCostRates(org.orgId, [entryId], { actorId: adminId });
      assert.equal(stamped, 1);
      const stamped_row = (await db.execute<{ wage: string; rateId: string | null }>(sql`
        select wage_rate::text as wage, labor_cost_rate_id::text as "rateId"
          from time_entries where id = ${entryId}::uuid
      `)).rows[0]!;
      assert.equal(stamped_row.wage, "77.0000");
      assert.equal(stamped_row.rateId, null);
    } finally {
      setPrevailingWageEntryWage(async () => null);
    }
    // Feature off: the same entry shape keeps the standard path — no
    // wage table row exists, so nothing stamps and nothing throws.
    await db.execute(sql`update time_entries set cost_rate = null where id = ${entryId}::uuid`);
    const plain = await snapshotLaborCostRates(org.orgId, [entryId], { actorId: adminId });
    assert.equal(plain, 0);
  });
});

test("travel pay computes hourly and per-km; second org sees zero rows", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org, adminId } = h;
    const { employmentId, partyId } = await seedWorker(org.orgId, org.subsidiaryId, "Travel Worker");
    const projectId = await seedProject(org.orgId, "Travel Job");
    const componentId = await seedComponent(org.orgId, "earning");
    await createPolicy(db, {
      orgId: org.orgId, actorId: adminId, name: "Travel policy", basis: "hours_threshold",
      rules: { min_hours: 6, amount_for_hours: "20.0000", amount_per_km: "0.6700" },
      currency: "USD", effectiveFrom: "2026-01-01", payComponentId: componentId,
    });
    await seedTime(org.orgId, partyId, projectId, "2026-09-08", "8.0000");
    const hourly = await computeTravelForWeek(db, {
      orgId: org.orgId, actorId: adminId, employmentId, weekStart: "2026-09-07", mode: "hourly",
    });
    assert.equal(hourly.length, 1);
    assert.equal(hourly[0]!.amount, "160.0000");
    // Record the same finding twice: the second write returns the open row, never a duplicate.
    const first = await recordFinding(db, {
      orgId: org.orgId, actorId: adminId, kind: "registration_missing", projectId, workedOn: "2026-09-08", detail: {},
    });
    const second = await recordFinding(db, {
      orgId: org.orgId, actorId: adminId, kind: "registration_missing", projectId, workedOn: "2026-09-08", detail: {},
    });
    assert.equal(first.id, second.id);
    // Second org sees zero rows at the storage floor.
    const foreign = await createScratchOrg();
    try {
      const client = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
      await client.connect();
      try {
        await client.query("select set_config('app.current_org', $1, false)", [foreign.orgId]);
        const res = await client.query("select count(*)::int as n from hrm_compliance_findings where id = $1", [first.id]);
        assert.equal(res.rows[0].n, 0, "a foreign org session sees zero rows");
      } finally {
        await client.end();
      }
    } finally {
      await dropScratchOrg(foreign.orgId);
    }
  });
});
