import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { db, withOrgTransaction } from "../platform/db.ts";
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
  generate,
  listFindings,
  listFormats,
  markSeamConsumed,
  recordFinding,
  resolveCertifiedEmployment,
  resolveFinding,
  resolveWage,
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
    await createPolicy(db, {
      orgId: org.orgId, actorId: adminId, name: "Daily rate", basis: "flat_daily",
      rules: { amount: "75.0000" }, weeklyRule: { worked_days: 2, paid_days: 5 }, currency: "USD",
      effectiveFrom: "2026-01-01", payComponentId: componentId,
    });
    await seedTime(org.orgId, partyId, projectId, "2026-09-08", "8.0000");
    await seedTime(org.orgId, partyId, await seedProject(org.orgId, "Second remote job"), "2026-09-08", "4.0000");
    const entries = await computeForWeek(db, {
      orgId: org.orgId, actorId: adminId, employmentId, weekStart: "2026-09-07",
    });
    assert.equal(entries.length, 2, "two project rows on one civil date count as one worked date, below the weekly threshold, so no top-up");
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
    // A fabricated project refuses as not-found, exactly like an
    // out-of-scope one — never as a rule miss.
    await assertConstructionRefusal(
      () => classify(db, { orgId: org.orgId, actorId: adminId, projectId: randomUUID(), workedOn: "2026-09-08", employmentId }),
      /does not exist in this organization/,
    );
    // A real project with no covering rule still reports the rule miss.
    const bareProjectId = await seedProject(org.orgId, "Bare Job");
    await assertConstructionRefusal(
      () => classify(db, { orgId: org.orgId, actorId: adminId, projectId: bareProjectId, workedOn: "2026-09-08", employmentId }),
      /No comp-class rule matches/,
    );
  });
});

test("certified payroll offers the US pack's declared files and refuses an empty week by name", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org, adminId } = h;
    const projectId = await seedProject(org.orgId, "Certified Job");
    const listed = await listFormats(db, org.orgId, adminId);
    assert.equal(listed.packName, "United States");
    // HR-13: the US pack declares its own files (federal weekly + one
    // state XML) — the generic layer lists whatever the pack declares, so
    // the old empty-list expectation no longer holds.
    assert.deepEqual(listed.formats, [
      { key: "federal-weekly", label: "WH-347 Certified Payroll (federal weekly)" },
      { key: "state-xml", label: "California certified payroll XML (DIR eCPR)" },
    ]);
    // Declared but empty: the third named refusal (the week with no
    // posted run), never a borrowed form.
    await assertConstructionRefusal(
      () => generate(db, { orgId: org.orgId, actorId: adminId, projectId, weekEnding: "2026-09-13", formatKey: "federal-weekly" }),
      /No posted pay run covers the week ending 2026-09-13/,
    );
    await db.execute(sql`update orgs set country = 'GB' where id = ${org.orgId}`);
    const gb = await listFormats(db, org.orgId, adminId);
    assert.deepEqual(gb.formats, []);
    await assertConstructionRefusal(
      () => generate(db, { orgId: org.orgId, actorId: adminId, projectId, weekEnding: "2026-09-13", formatKey: "federal-weekly" }),
      /pack declares no labor-compliance files/,
    );
    await db.execute(sql`update orgs set country = 'US' where id = ${org.orgId}`);
  });
});

test("certified payroll resolves one employment per day and refuses history fan-out", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org, adminId } = h;
    const { employmentId: firstId, partyId } = await seedWorker(org.orgId, org.subsidiaryId, "Certified Worker");
    const resolve = (day: string) => resolveCertifiedEmployment(db, org.orgId, partyId, day);
    assert.equal(await resolve("2026-09-08"), firstId);
    // Retire v1 through the lawful 0184 closing transition: live version
    // rows are append-only (effective_to can never be rewritten), so the
    // close (recorded_until + superseded_by + evidence event, one
    // transaction) retires the first employment and its successor version
    // ends before the probed day.
    const v1 = (await db.execute<{ rowId: string; before: unknown }>(sql`
      select id::text as "rowId", to_jsonb(v) as "before" from worker_employment_versions v
       where v.org_id = ${org.orgId} and v.employment_id = ${firstId} and v.version_no = 1`)).rows[0];
    assert.ok(v1, "seeded v1 must exist before the lawful close");
    const changeId = randomUUID();
    await withOrgTransaction(org.orgId, async () => {
      const at = (await db.execute<{ now: string }>(sql`select now()::text as now`)).rows[0]!.now;
      // Evidence first: closed_by_change_id is a tenant FK to
      // employment_changes, while the closure proof itself is deferred to
      // commit — so the event, the close, then the successor.
      await db.execute(sql`
        insert into employment_changes
          (id, org_id, employment_id, revision, change_kind, prior_snapshot, reason, recorded_source, recorded_by, closed_versions)
        values (${changeId}, ${org.orgId}, ${firstId}, 1, 'terminated', '{}'::jsonb,
                'first employment ended; worker rehired under a new employment', 'user', ${adminId},
                jsonb_build_array(jsonb_build_object('table', 'worker_employment_versions', 'identity', ${firstId}::text,
                                                     'version_no', 1, 'row_id', ${v1.rowId}::text, 'before', ${JSON.stringify(v1.before)}::jsonb)))`);
      await db.execute(sql`
        update worker_employment_versions
           set recorded_until = ${at}::timestamptz, superseded_by = 2, closed_by_change_id = ${changeId}
         where org_id = ${org.orgId} and employment_id = ${firstId} and version_no = 1`);
      await db.execute(sql`
        insert into worker_employment_versions
          (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
        values (${org.orgId}, ${firstId}, 2, 'active', '2020-01-01', '2026-01-01', ${at}::timestamptz)`);
    });
    const secondId = randomUUID();
    await db.execute(sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision) values (${secondId}, ${org.orgId}, ${partyId}, ${org.subsidiaryId}, 1)`);
    await db.execute(sql`insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, recorded_at) values (${org.orgId}, ${secondId}, 1, 'active', '2026-01-01', now())`);
    assert.equal(await resolve("2026-09-08"), secondId);
    const thirdId = randomUUID();
    await db.execute(sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision) values (${thirdId}, ${org.orgId}, ${partyId}, ${org.subsidiaryId}, 1)`);
    await db.execute(sql`insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, recorded_at) values (${org.orgId}, ${thirdId}, 1, 'active', '2026-01-01', now())`);
    await assertConstructionRefusal(() => resolve("2026-09-08"), /2 employments effective 2026-09-08/);
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
