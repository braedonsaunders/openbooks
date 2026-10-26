import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
import { seedCommittedBenefitRunWithoutStubs } from "../testing/benefit-fixtures.ts";
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
  seedPayrollAccountingConfiguration,
  seedPayrollEmployeeRole,
  seedPayrollProfile,
  seedPayrollTime,
  seedPayrollWage,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import {
  DB,
  enableFeatures,
  grantPermissions,
  seedComponent,
  seedNamedWorker,
  seedProject,
  setupHarness,
  withHarness,
} from "../testing/hrm-harness.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { HrmConstructionError } from "./construction/errors.ts";
import { setPrevailingWageEntryWage, snapshotLaborCostRates } from "../projects/labor-costing.ts";
import { prevailingWageForTimeEntry } from "./construction/labor-hook.ts";
import { createPayRun } from "../payroll/run-lifecycle.ts";
import { calculatePayRun } from "../payroll/run-calculation.ts";
import { commitPayRun } from "../payroll/run-commit.ts";
import { seedPayrollComponents } from "../payroll/run-setup.ts";
import { seedUsSuiAccount, seedUsEinAccount } from "../payroll/filing-test-fixtures.ts";
import { setPackSlotAccount } from "../payroll/packs.ts";
import { US_PACK_RATES } from "../payroll/us/rates.ts";
import { upsertStatutoryRate } from "../payroll/statutory-rates.ts";
import { recordPayRunPayment } from "../payroll/payment.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { fromUnits, sum, toUnits } from "../money/money.ts";
import type { LaborComplianceReportRow } from "../payroll/labor-compliance.ts";
import { seedPayrollSchedule } from "../testing/fixtures.ts";
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
  downloadRun,
  generate,
  listFindings,
  listFormats,
  listRuns,
  markSeamConsumed,
  recordFinding,
  resolveCertifiedEmployment,
  resolveFinding,
  resolveWage,
  voidEntry,
} from "./construction/index.ts";

/**
 * HR-13 DB coverage (integration partition — run at the integration gate;
 * skips without OPENBOOKS_DB_URL): migrations 0223/0224 bootstrap
 * plus RLS, the resolver (scope precedence, reciprocity, as-of,
 * missing → refusal + finding), per-diem brackets and the weekly rule,
 * ratio-breach journey pricing, the certified payload against a
 * hand-built week, comp priority, the pack-none refusal, every refusal
 * red-proofed through the real code path, and the second-org storage
 * floor. Proofs are read back from storage, never from service returns
 * alone.
 */

const CONSTRUCTION_FEATURES = [
  "hrm",
  "payroll",
  "projects",
  "timeTracking",
  "hrmConstructionCompliance",
] as const;

const CONSTRUCTION_SPEC = {
  features: CONSTRUCTION_FEATURES,
  country: "US",
  users: [
    {
      key: "adminId",
      name: "Construction Admin",
      handle: "construction_admin",
      permissions: ["hrm.construction.read", "hrm.construction.manage"],
    },
    { key: "outsiderId", name: "Construction Outsider", handle: "construction_outsider" },
  ],
} as const;

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

async function assertConstructionRefusal(
  fn: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(
      error instanceof HrmConstructionError,
      `expected HrmConstructionError, got ${String(error)}`,
    );
    assert.match(error.message, pattern);
    return;
  }
  assert.fail("expected a refusal, the call succeeded");
}

test(
  "migrations 0223/0224 bootstrap: thirteen tables, RLS forced, seam pairing",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CONSTRUCTION_SPEC),
      async () => {
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
          const reg = (
            await db.execute<{ n: number }>(
              sql`
        select count(*)::int as n from pg_tables where schemaname = 'public' and tablename = ${table}
      `,
              "objects",
            )
          )[0]!.n;
          assert.equal(reg, 1, `${table} exists`);
          const rls = (
            await db.execute<{ rowsecurity: boolean; forcerowsecurity: boolean }>(
              sql`
        select c.relrowsecurity as rowsecurity, c.relforcerowsecurity as forcerowsecurity
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = ${table}
      `,
              "objects",
            )
          )[0]!;
          assert.equal(rls.rowsecurity, true, `${table} has RLS`);
          assert.equal(rls.forcerowsecurity, true, `${table} forces RLS`);
        }
        for (const name of ["hrm_allowance_payroll_inputs_status_pairing"]) {
          const found = (
            await db.execute<{ n: number }>(
              sql`
        select count(*)::int as n from pg_constraint where conname = ${name}
      `,
              "objects",
            )
          )[0]!.n;
          assert.equal(found, 1, `${name} exists`);
        }
        for (const name of [
          "hrm_per_diem_entries_day_unique",
          "hrm_allowance_payroll_inputs_entry_unique",
        ]) {
          const found = (
            await db.execute<{ n: number }>(
              sql`
        select count(*)::int as n from pg_indexes where schemaname = 'public' and indexname = ${name}
      `,
              "objects",
            )
          )[0]!.n;
          assert.equal(found, 1, `${name} exists`);
        }
      },
    );
  },
);

test("feature-off and grant refusals fire by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const adminId = await createScratchUser(org.orgId, "Off Admin", "off_admin");
    await grantPermissions(org.orgId, adminId, [
      "hrm.construction.read",
      "hrm.construction.manage",
    ]);
    await assertConstructionRefusal(
      () =>
        createClassification(db, {
          orgId: org.orgId,
          actorId: adminId,
          code: "X",
          name: "X",
          trade: "X",
        }),
      /while Construction compliance is off/,
    );
    await enableFeatures(org.orgId, CONSTRUCTION_FEATURES);
    const outsider = await createScratchUser(org.orgId, "Off Outsider", "off_outsider");
    try {
      await listFindings(db, org.orgId, outsider);
      assert.fail("outsider list should refuse");
    } catch (error) {
      assert.ok(
        error instanceof HrmAuthorizationError,
        `expected HrmAuthorizationError, got ${String(error)}`,
      );
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "resolver: scope precedence, reciprocity, as-of, missing writes a finding",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CONSTRUCTION_SPEC),
      async (h) => {
        const { org, adminId } = h;
        const { employmentId } = await seedNamedWorker(
          org.orgId,
          org.subsidiaryId,
          "Resolver Worker",
        );
        const projectId = await seedProject(org.orgId, "Resolver Job");
        const journey = await createClassification(db, {
          orgId: org.orgId,
          actorId: adminId,
          code: "ELEC-J",
          name: "Electrician journey",
          trade: "Electrical",
        });
        const apprentice = await createClassification(db, {
          orgId: org.orgId,
          actorId: adminId,
          code: "ELEC-A",
          name: "Electrician apprentice",
          trade: "Electrical",
          isApprentice: true,
          journeyClassificationId: journey.id,
        });
        // Apprentice without a journey class refuses by name.
        await assertConstructionRefusal(
          () =>
            createClassification(db, {
              orgId: org.orgId,
              actorId: adminId,
              code: "PLB-A",
              name: "Plumber apprentice",
              trade: "Plumbing",
              isApprentice: true,
            }),
          /names no journey class/,
        );
        // Duplicate code refuses by name.
        await assertConstructionRefusal(
          () =>
            createClassification(db, {
              orgId: org.orgId,
              actorId: adminId,
              code: "ELEC-J",
              name: "Dupe",
              trade: "Electrical",
            }),
          /already in use/,
        );
        const orgWide = await createSchedule(db, {
          orgId: org.orgId,
          actorId: adminId,
          kind: "prevailing_wage",
          name: "Area standard",
          sourceRef: "DETERMINATION-1",
          reciprocity: "higher_of",
          effectiveFrom: "2026-01-01",
        });
        const scoped = await createSchedule(db, {
          orgId: org.orgId,
          actorId: adminId,
          kind: "union_agreement",
          name: "Local 412",
          appliesTo: { project_ids: [projectId] },
          reciprocity: "jobsite_local",
          effectiveFrom: "2026-01-01",
        });
        await addScheduleLine(db, {
          orgId: org.orgId,
          actorId: adminId,
          scheduleId: orgWide.id,
          classificationId: journey.id,
          baseRate: "50.0000",
          fringeRate: "2.0000",
          currency: "USD",
          effectiveFrom: "2026-01-01",
        });
        await addScheduleLine(db, {
          orgId: org.orgId,
          actorId: adminId,
          scheduleId: scoped.id,
          classificationId: journey.id,
          baseRate: "60.0000",
          fringeRate: "3.0000",
          currency: "USD",
          effectiveFrom: "2026-01-01",
        });
        // Project-scoped union line beats the org-wide prevailing line.
        await assignClassification(db, {
          orgId: org.orgId,
          actorId: adminId,
          employmentId,
          classificationId: journey.id,
          effectiveFrom: "2026-01-01",
        });
        const priced = await resolveWage(db, {
          orgId: org.orgId,
          actorId: adminId,
          employmentId,
          projectId,
          workedOn: "2026-09-08",
        });
        assert.equal(priced.base, "60.0000");
        assert.equal(priced.source, "union");
        // Unassigned employment: refusal names assignment AND writes a missing_rate finding.
        const { employmentId: bare } = await seedNamedWorker(
          org.orgId,
          org.subsidiaryId,
          "Bare Worker",
        );
        await assertConstructionRefusal(
          () =>
            resolveWage(db, {
              orgId: org.orgId,
              actorId: adminId,
              employmentId: bare,
              projectId,
              workedOn: "2026-09-08",
            }),
          /no work classification/,
        );
        const findings = await listFindings(db, org.orgId, adminId, "open");
        assert.ok(
          findings.some(
            (finding) => finding.kind === "missing_rate" && finding.employmentId === bare,
          ),
        );
        // A classification with no covering line refuses and flags.
        await assignClassification(db, {
          orgId: org.orgId,
          actorId: adminId,
          employmentId: bare,
          classificationId: apprentice.id,
          effectiveFrom: "2026-01-01",
        });
        await assertConstructionRefusal(
          () =>
            resolveWage(db, {
              orgId: org.orgId,
              actorId: adminId,
              employmentId: bare,
              projectId,
              workedOn: "2026-09-09",
            }),
          /No rate line covers/,
        );
        // A fresh day, so the dedupe on identical open findings cannot mask it.
        const noLine = (await listFindings(db, org.orgId, adminId, "open")).filter(
          (finding) =>
            finding.kind === "missing_rate" &&
            finding.employmentId === bare &&
            finding.workedOn === "2026-09-09",
        );
        assert.equal(noLine.length, 1, "the uncovered day writes one missing_rate finding");
        // Other org's project refuses — hostile loop, never cross-tenant pricing.
        const foreign = await createScratchOrg();
        try {
          const foreignProject = await seedProject(foreign.orgId, "Foreign Job");
          await assertConstructionRefusal(
            () =>
              resolveWage(db, {
                orgId: org.orgId,
                actorId: adminId,
                employmentId,
                projectId: foreignProject,
                workedOn: "2026-09-08",
              }),
            /does not exist in this organization/,
          );
        } finally {
          await dropScratchOrg(foreign.orgId);
        }
      },
    );
  },
);

test(
  "per-diem: brackets price the day, approval crosses the seam, voids carry reason",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CONSTRUCTION_SPEC),
      async (h) => {
        const { org, adminId } = h;
        const { employmentId, partyId } = await seedNamedWorker(
          org.orgId,
          org.subsidiaryId,
          "Per Diem Worker",
        );
        const projectId = await seedProject(org.orgId, "Remote Job");
        const componentId = await seedComponent(org.orgId, { kind: "earning" });
        // A non-earning component refuses at policy creation.
        const wageComponent = await seedComponent(org.orgId, { kind: "deduction" });
        await assertConstructionRefusal(
          () =>
            createPolicy(db, {
              orgId: org.orgId,
              actorId: adminId,
              name: "Bad link",
              basis: "flat_daily",
              rules: { amount: "10.0000" },
              currency: "USD",
              effectiveFrom: "2026-01-01",
              payComponentId: wageComponent,
            }),
          /only through earning components/,
        );
        await createPolicy(db, {
          orgId: org.orgId,
          actorId: adminId,
          name: "Daily rate",
          basis: "flat_daily",
          rules: { amount: "75.0000" },
          weeklyRule: { worked_days: 2, paid_days: 5 },
          currency: "USD",
          effectiveFrom: "2026-01-01",
          payComponentId: componentId,
        });
        await seedTime(org.orgId, partyId, projectId, "2026-09-08", "8.0000");
        await seedTime(
          org.orgId,
          partyId,
          await seedProject(org.orgId, "Second remote job"),
          "2026-09-08",
          "4.0000",
        );
        const entries = await computeForWeek(db, {
          orgId: org.orgId,
          actorId: adminId,
          employmentId,
          weekStart: "2026-09-07",
        });
        assert.equal(
          entries.length,
          2,
          "two project rows on one civil date count as one worked date, below the weekly threshold, so no top-up",
        );
        assert.deepEqual(entries.map((entry) => entry.amount).sort(), ["25.0000", "50.0000"]);
        assert.equal(
          sum(entries.map((entry) => entry.amount)),
          "75.0000",
          "one civil day earns one daily allowance, attributed by hours",
        );
        const approved = await approveEntry(db, {
          orgId: org.orgId,
          actorId: adminId,
          entryId: entries[0]!.id,
          kind: "per_diem",
        });
        assert.equal(approved.status, "approved");
        const seam = (
          await db.execute<{ status: string; amount: string }>(
            sql`
      select status, amount::text as amount from hrm_allowance_payroll_inputs
       where org_id = ${org.orgId} and entry_kind = 'per_diem' and entry_id = ${entries[0]!.id}::uuid
    `,
            "objects",
          )
        )[0];
        assert.equal(seam?.status, "pending");
        assert.equal(seam?.amount, entries[0]!.amount);
        // Consumed seam rows refuse voids by run name.
        await markSeamConsumed(
          db,
          org.orgId,
          (
            await db.execute<{ id: string }>(
              sql`
      select id::text as id from hrm_allowance_payroll_inputs
       where org_id = ${org.orgId} and entry_id = ${entries[0]!.id}::uuid
    `,
              "objects",
            )
          )[0]!.id,
          randomUUID(),
        );
        await assertConstructionRefusal(
          () =>
            voidEntry(db, {
              orgId: org.orgId,
              actorId: adminId,
              entryId: entries[0]!.id,
              kind: "per_diem",
              reason: "oops",
            }),
          /recalculate the run/,
        );
        // The other entry voids with a reason and stays voided.
        const voided = await voidEntry(db, {
          orgId: org.orgId,
          actorId: adminId,
          entryId: entries[1]!.id,
          kind: "per_diem",
          reason: "duplicate day",
        });
        assert.equal(voided.status, "voided");
        await assertConstructionRefusal(
          () =>
            computeForWeek(db, {
              orgId: org.orgId,
              actorId: adminId,
              employmentId,
              weekStart: "2026-09-07",
            }),
          /void it with a reason before recomputing/,
        );
      },
    );
  },
);

test("ratios breach the day and reprice apprentices at journey", { skip: !DB }, async () => {
  await withHarness(
    () => setupHarness(CONSTRUCTION_SPEC),
    async (h) => {
      const { org, adminId } = h;
      const journeyWorker = await seedNamedWorker(org.orgId, org.subsidiaryId, "Journey Worker");
      const apprenticeWorker = await seedNamedWorker(
        org.orgId,
        org.subsidiaryId,
        "Apprentice Worker",
      );
      const projectId = await seedProject(org.orgId, "Ratio Job");
      const journey = await createClassification(db, {
        orgId: org.orgId,
        actorId: adminId,
        code: "CARP-J",
        name: "Carpenter journey",
        trade: "Carpentry",
      });
      const apprentice = await createClassification(db, {
        orgId: org.orgId,
        actorId: adminId,
        code: "CARP-A",
        name: "Carpenter apprentice",
        trade: "Carpentry",
        isApprentice: true,
        journeyClassificationId: journey.id,
      });
      const schedule = await createSchedule(db, {
        orgId: org.orgId,
        actorId: adminId,
        kind: "prevailing_wage",
        name: "Ratio schedule",
        reciprocity: "jobsite_local",
        effectiveFrom: "2026-01-01",
      });
      await addScheduleLine(db, {
        orgId: org.orgId,
        actorId: adminId,
        scheduleId: schedule.id,
        classificationId: journey.id,
        baseRate: "55.0000",
        currency: "USD",
        effectiveFrom: "2026-01-01",
      });
      await addScheduleLine(db, {
        orgId: org.orgId,
        actorId: adminId,
        scheduleId: schedule.id,
        classificationId: apprentice.id,
        baseRate: "30.0000",
        currency: "USD",
        effectiveFrom: "2026-01-01",
      });
      await assignClassification(db, {
        orgId: org.orgId,
        actorId: adminId,
        employmentId: journeyWorker.employmentId,
        classificationId: journey.id,
        effectiveFrom: "2026-01-01",
      });
      await assignClassification(db, {
        orgId: org.orgId,
        actorId: adminId,
        employmentId: apprenticeWorker.employmentId,
        classificationId: apprentice.id,
        effectiveFrom: "2026-01-01",
      });
      await createRatioRule(db, {
        orgId: org.orgId,
        actorId: adminId,
        scheduleId: schedule.id,
        journeyClassificationId: journey.id,
        apprenticeClassificationId: apprentice.id,
        ratioJourney: 1,
        ratioApprentice: 1,
        measured: "daily",
        effectiveFrom: "2026-01-01",
      });
      // One journey hour against four apprentice hours breaches 1:1.
      await seedTime(org.orgId, journeyWorker.partyId, projectId, "2026-09-08", "1.0000");
      await seedTime(org.orgId, apprenticeWorker.partyId, projectId, "2026-09-08", "4.0000");
      const results = await checkDay(db, {
        orgId: org.orgId,
        actorId: adminId,
        projectId,
        workedOn: "2026-09-08",
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.breach, true);
      const apprenticePrice = await resolveWage(db, {
        orgId: org.orgId,
        actorId: adminId,
        employmentId: apprenticeWorker.employmentId,
        projectId,
        workedOn: "2026-09-08",
      });
      assert.equal(apprenticePrice.base, "55.0000");
      assert.equal(apprenticePrice.rateAtJourney, true);
      const findings = await listFindings(db, org.orgId, adminId, "open");
      const breach = findings.find((finding) => finding.kind === "ratio_breach");
      assert.ok(breach, "ratio breach flagged");
      const acked = await acknowledgeFinding(db, org.orgId, adminId, breach.id);
      assert.equal(acked.status, "acknowledged");
      const resolved = await resolveFinding(
        db,
        org.orgId,
        adminId,
        breach.id,
        "crew rebalanced next day",
      );
      assert.equal(resolved.status, "resolved");
    },
  );
});

test(
  "comp classes resolve by priority and refuse when nothing matches",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CONSTRUCTION_SPEC),
      async (h) => {
        const { org, adminId } = h;
        const { employmentId, partyId } = await seedNamedWorker(
          org.orgId,
          org.subsidiaryId,
          "Comp Worker",
        );
        const projectId = await seedProject(org.orgId, "Comp Job");
        const roofing = await createCompClass(db, {
          orgId: org.orgId,
          actorId: adminId,
          code: "ROOF-5551",
          name: "Roofing",
          ratePer100: "12.5000",
          effectiveFrom: "2026-01-01",
        });
        const office = await createCompClass(db, {
          orgId: org.orgId,
          actorId: adminId,
          code: "OFF-8810",
          name: "Clerical",
          effectiveFrom: "2026-01-01",
        });
        await createCompRule(db, {
          orgId: org.orgId,
          actorId: adminId,
          priority: 1,
          match: {},
          compClassId: office.id,
        }).then(
          () => assert.fail("empty match must refuse"),
          (error: unknown) =>
            assert.ok(error instanceof HrmConstructionError && /at least one/.test(error.message)),
        );
        await createCompRule(db, {
          orgId: org.orgId,
          actorId: adminId,
          priority: 1,
          match: { project_id: projectId },
          compClassId: office.id,
        });
        await createCompRule(db, {
          orgId: org.orgId,
          actorId: adminId,
          priority: 10,
          match: { project_id: projectId },
          compClassId: roofing.id,
        });
        const hit = await classify(db, {
          orgId: org.orgId,
          actorId: adminId,
          projectId,
          workedOn: "2026-09-08",
          employmentId,
        });
        assert.equal(hit.code, "ROOF-5551");
        await seedTime(org.orgId, partyId, projectId, "2026-09-08", "8.0000");
        const split = await dailySplit(db, {
          orgId: org.orgId,
          actorId: adminId,
          projectId,
          workedOn: "2026-09-08",
        });
        assert.equal(split.length, 1);
        assert.equal(split[0]!.compCode, "ROOF-5551");
        assert.equal(split[0]!.hours, "8.0000");
        // A fabricated project refuses as not-found, exactly like an
        // out-of-scope one — never as a rule miss.
        await assertConstructionRefusal(
          () =>
            classify(db, {
              orgId: org.orgId,
              actorId: adminId,
              projectId: randomUUID(),
              workedOn: "2026-09-08",
              employmentId,
            }),
          /does not exist in this organization/,
        );
        // A real project with no covering rule still reports the rule miss.
        const bareProjectId = await seedProject(org.orgId, "Bare Job");
        await assertConstructionRefusal(
          () =>
            classify(db, {
              orgId: org.orgId,
              actorId: adminId,
              projectId: bareProjectId,
              workedOn: "2026-09-08",
              employmentId,
            }),
          /No comp-class rule matches/,
        );
      },
    );
  },
);

test(
  "certified payroll offers the US pack's declared files and refuses an empty week by name",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CONSTRUCTION_SPEC),
      async (h) => {
        const { org, adminId } = h;
        const projectId = await seedProject(org.orgId, "Certified Job");
        await db.execute(
          sql`update projects set subsidiary_id = ${org.subsidiaryId} where org_id = ${org.orgId} and id = ${projectId}`,
        );
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
          () =>
            generate(db, {
              orgId: org.orgId,
              actorId: adminId,
              projectId,
              weekEnding: "2026-09-13",
              formatKey: "federal-weekly",
            }),
          /No posted pay run covers the week ending 2026-09-13/,
        );
        await db.execute(sql`update orgs set country = 'GB' where id = ${org.orgId}`);
        const gb = await listFormats(db, org.orgId, adminId);
        assert.deepEqual(gb.formats, []);
        await assertConstructionRefusal(
          () =>
            generate(db, {
              orgId: org.orgId,
              actorId: adminId,
              projectId,
              weekEnding: "2026-09-13",
              formatKey: "federal-weekly",
            }),
          /pack declares no labor-compliance files/,
        );
        await db.execute(sql`update orgs set country = 'US' where id = ${org.orgId}`);
      },
    );
  },
);

test(
  "certified payroll refuses a project without an authoritative legal entity",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CONSTRUCTION_SPEC),
      async (h) => {
        const projectId = await seedProject(h.org.orgId, "Unassigned certified project");
        await assertConstructionRefusal(
          () =>
            generate(db, {
              orgId: h.org.orgId,
              actorId: h.adminId,
              projectId,
              weekEnding: "2026-09-13",
              formatKey: "federal-weekly",
            }),
          /needs a legal entity before certified payroll/,
        );
        assert.equal(
          (
            await db.execute<{ count: string }>(
              sql`select count(*)::text as count from hrm_certified_payroll_runs where org_id = ${h.org.orgId}`,
              "objects",
            )
          )[0]?.count,
          "0",
        );
      },
    );
  },
);

test(
  "certified payroll refuses approved project time on a committed but unposted run",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CONSTRUCTION_SPEC),
      async (h) => {
        const { org, adminId } = h;
        const projectId = await seedProject(org.orgId, "Unposted certified job");
        await db.execute(
          sql`update projects set subsidiary_id = ${org.subsidiaryId} where org_id = ${org.orgId} and id = ${projectId}`,
        );
        const { partyId } = await seedNamedWorker(
          org.orgId,
          org.subsidiaryId,
          "Unpaid certified worker",
        );
        await seedTime(org.orgId, partyId, projectId, "2026-09-08", "8.0000");
        const scheduleId = randomUUID();
        await seedPayrollSchedule(org.orgId, scheduleId, adminId, {
          name: "Certified weekly",
          frequency: "weekly",
          periodsPerYear: 52,
          anchorPeriodEnd: "2026-09-13",
          payDateOffsetDays: 3,
          subsidiaryId: org.subsidiaryId,
        });
        const run = await createPayRun({
          orgId: org.orgId,
          actorId: adminId,
          payScheduleId: scheduleId,
          periodStart: "2026-09-07",
          periodEnd: "2026-09-13",
          payDate: "2026-09-16",
        });
        await seedCommittedBenefitRunWithoutStubs(org.orgId, run.documentId);
        await assertConstructionRefusal(
          () =>
            generate(db, {
              orgId: org.orgId,
              actorId: adminId,
              projectId,
              weekEnding: "2026-09-13",
              formatKey: "federal-weekly",
            }),
          /No posted pay run covers the week ending 2026-09-13/,
        );
      },
    );
  },
);

test(
  "certified payroll freezes posted native wages by dated classification without repeating nonproject pay",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CONSTRUCTION_SPEC),
      async ({ org, adminId, outsiderId }) => {
        const scope = { orgId: org.orgId, actorId: adminId };
        await grantPermissions(org.orgId, adminId, [
          "payroll.manage",
          "payroll.read",
          "payroll.run",
        ]);
        const weekEnding = "2026-07-19";
        // The shared currency registry may already contain USD; that conflict changes no tenant evidence.
        await db.execute(sql`
      insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2)
      on conflict (code) do nothing`);
        assert.equal(
          (
            await db.execute<{ minorUnits: number }>(
              sql`
      select minor_units as "minorUnits" from currencies where code = 'USD'`,
              "objects",
            )
          )[0]?.minorUnits,
          2,
        );
        assert.equal(
          (
            await db.execute(
              sql`update orgs set base_currency = 'USD'
      where id = ${org.orgId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update subsidiaries set base_currency = 'USD', country = 'US'
      where org_id = ${org.orgId} and id = ${org.subsidiaryId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const wageExpense = await seedPostingAccount(
          org.orgId,
          "6000",
          "Construction wages",
          "expense",
        );
        const burdenExpense = await seedPostingAccount(
          org.orgId,
          "6010",
          "Payroll burden",
          "expense",
        );
        const netPayable = await seedPostingAccount(
          org.orgId,
          "2300",
          "Wages payable",
          "liability_current",
        );
        const taxPayable = await seedPostingAccount(
          org.orgId,
          "2330",
          "Payroll taxes payable",
          "liability_current",
        );
        await seedPayrollAccountingConfiguration(org.orgId, {
          wageExpenseAccountId: wageExpense,
          burdenExpenseAccountId: burdenExpense,
          netPayAccountId: netPayable,
          wagesTo: "expense",
          countries: ["US"],
        });
        await seedPayrollComponents(org.orgId, adminId, "US");
        for (const slot of ["fit", "fica", "futa", "suta"]) {
          await setPackSlotAccount(org.orgId, adminId, "US", slot, taxPayable);
        }
        const einAccountId = await seedUsEinAccount(
          org.orgId,
          adminId,
          org.subsidiaryId,
          "12-3456789",
        );
        const filingAccountId = await seedUsSuiAccount(org.orgId, adminId, "TX", {
          federalAccountId: einAccountId,
          subsidiaryId: org.subsidiaryId,
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
          sourceReference: "TX original employer registration",
        });
        await upsertStatutoryRate({
          ...scope,
          rates: US_PACK_RATES,
          rateKey: "us_sui",
          region: "TX",
          filingAccountId,
          taxYear: 2026,
          values: { rate: "0.03", wageBase: "7000" },
          sourceCitation: "Employer unemployment rate notice",
          reason: "Declare the employer contribution rate",
        });
        await upsertStatutoryRate({
          ...scope,
          rates: US_PACK_RATES,
          rateKey: "us_futa",
          region: "TX",
          filingAccountId: null,
          taxYear: 2026,
          values: { rate: "0.006" },
          sourceCitation: "Employer federal unemployment credit determination",
          reason: "Declare the effective FUTA rate",
        });
        const scheduleId = randomUUID();
        await seedPayrollSchedule(org.orgId, scheduleId, adminId, {
          name: "Construction weekly",
          frequency: "weekly",
          periodsPerYear: 52,
          anchorPeriodEnd: weekEnding,
          payDateOffsetDays: 3,
          subsidiaryId: org.subsidiaryId,
        });
        const projectId = await seedProject(org.orgId, "Native certified job");
        assert.equal(
          (
            await db.execute(
              sql`update projects set subsidiary_id = ${org.subsidiaryId}
      where org_id = ${org.orgId} and id = ${projectId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const { partyId, employmentId } = await seedNamedWorker(
          org.orgId,
          org.subsidiaryId,
          "Native certified worker",
        );
        assert.equal(
          (
            await db.execute(
              sql`update parties set subsidiary_id = ${org.subsidiaryId}
      where org_id = ${org.orgId} and id = ${partyId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await seedPayrollEmployeeRole(org.orgId, partyId, {
          hiredOn: "2026-01-01",
          isActive: true,
        });
        await seedPayrollWage(org.orgId, partyId, adminId, {
          currency: "USD",
          rate: "30.01",
          basis: "hour",
          effectiveFrom: "2026-01-01",
        });
        await seedPayrollProfile(org.orgId, partyId, employmentId, scheduleId, adminId, {
          country: "US",
          province: "TX",
          filingStatus: "single",
          payBasis: "hourly",
          filingAccountId,
        });
        await db.execute(sql`insert into employee_tax_certificates
      (org_id, employee_party_id, country, certificate_key, answers, effective_from, created_by, updated_by)
      values (${org.orgId}, ${partyId}, 'US', 'us_w4_tax_residency',
        '{"alien_status":"us_person_or_resident_alien"}'::jsonb, '2026-01-01', ${adminId}, ${adminId})`);
        const firstClass = await createClassification(db, {
          ...scope,
          code: "CARP",
          name: "Carpenter",
          trade: "Carpentry",
        });
        const secondClass = await createClassification(db, {
          ...scope,
          code: "FORM",
          name: "Formworker",
          trade: "Carpentry",
        });
        const rateSchedule = await createSchedule(db, {
          ...scope,
          kind: "prevailing_wage",
          name: "Project wage determination",
          sourceRef: "WAGE-DETERMINATION",
          appliesTo: { project_ids: [projectId] },
          reciprocity: "jobsite_local",
          effectiveFrom: "2026-01-01",
        });
        for (const classification of [firstClass, secondClass]) {
          await addScheduleLine(db, {
            ...scope,
            scheduleId: rateSchedule.id,
            classificationId: classification.id,
            baseRate: "30.0100",
            fringeRate: "0.0000",
            currency: "USD",
            effectiveFrom: "2026-01-01",
          });
        }
        await assignClassification(db, {
          ...scope,
          employmentId,
          classificationId: firstClass.id,
          effectiveFrom: "2026-01-01",
        });
        await assignClassification(db, {
          ...scope,
          employmentId,
          classificationId: secondClass.id,
          effectiveFrom: "2026-07-14",
        });
        // Another active employment for the same person must not fan out this employer's paid time.
        const otherSubsidiaryId = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into subsidiaries
      (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${otherSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Other employer', 'USD', 'US',
        '{}'::jsonb, false, true, '{}'::jsonb) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const otherEmploymentId = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into worker_employments
      (id, org_id, worker_party_id, employer_subsidiary_id, revision)
      values (${otherEmploymentId}, ${org.orgId}, ${partyId}, ${otherSubsidiaryId}, 1) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`insert into worker_employment_versions
      (org_id, employment_id, version_no, status, effective_from, recorded_at)
      values (${org.orgId}, ${otherEmploymentId}, 1, 'active', '2026-01-01', now()) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        for (const [workedOn, timeProjectId] of [
          ["2026-07-13", projectId],
          ["2026-07-14", projectId],
          ["2026-07-15", null],
        ] as const) {
          await seedPayrollTime(org.orgId, partyId, adminId, {
            workedOn,
            projectId: timeProjectId,
            hours: "1.0000",
            status: "approved",
            costingBasis: "actual",
            billingStatus: "unbilled",
            isBillable: false,
          });
        }
        const run = await createPayRun({
          ...scope,
          payScheduleId: scheduleId,
          periodStart: "2026-07-13",
          periodEnd: weekEnding,
          payDate: "2026-07-22",
        });
        const runInput = { ...scope, documentId: run.documentId };
        assert.deepEqual((await calculatePayRun(runInput)).errors, []);
        assert.ok((await commitPayRun(runInput)).lines > 0);
        await postDocument(run.documentId, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        });
        const payment = await recordPayRunPayment({
          ...runInput,
          bankAccountId: org.accounts.bank,
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
        });
        const posted = (
          await db.execute<{
            status: string;
            runStatus: string;
            payDate: string;
            subsidiaryId: string;
            paidEntryId: string;
            postedEntryId: string;
          }>(
            sql`
      select d.status, r.run_status as "runStatus", r.pay_date::text as "payDate",
        d.subsidiary_id::text as "subsidiaryId", r.paid_entry_id::text as "paidEntryId",
        d.posted_entry_id::text as "postedEntryId"
      from pay_runs r join documents d on d.org_id = r.org_id and d.id = r.document_id
      where r.org_id = ${org.orgId} and r.document_id = ${run.documentId}`,
            "objects",
          )
        )[0]!;
        assert.equal(posted.status, "posted");
        assert.equal(posted.runStatus, "committed");
        assert.equal(posted.subsidiaryId, org.subsidiaryId);
        assert.equal(
          posted.payDate,
          "2026-07-22",
          "the wage filing follows worked days rather than the cash settlement week",
        );
        assert.equal(posted.paidEntryId, payment.entryId);
        assert.ok(posted.postedEntryId);
        const stubs = await db.execute<{
          employmentId: string;
          gross: string;
          deductions: string;
          net: string;
        }>(
          sql`
      select employment_id::text as "employmentId", gross::text as gross,
        (gross - net_pay)::text as deductions, net_pay::text as net from pay_stubs
      where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId} and employee_party_id = ${partyId}`,
          "objects",
        );
        assert.equal(stubs.length, 1);
        const stub = stubs[0]!;
        assert.equal(stub.employmentId, employmentId);
        assert.equal(stub.gross, "90.0300");
        assert.ok(toUnits(stub.deductions) > 0n);
        assert.equal(toUnits(payment.total), toUnits(stub.net));
        const claimed = await db.execute<{
          projectId: string | null;
          batch: string;
          hours: string;
        }>(
          sql`
      select project_id::text as "projectId", payroll_batch_ref as batch, hours::text as hours
      from time_entries where org_id = ${org.orgId} and employee_party_id = ${partyId} order by worked_on`,
          "objects",
        );
        assert.equal(claimed.length, 3);
        assert.ok(claimed.every((entry) => entry.batch === run.documentId));
        assert.equal(sum(claimed.map((entry) => entry.hours)), "3.0000");
        assert.equal(claimed[2]!.projectId, null);
        const input = { ...scope, projectId, weekEnding, formatKey: "federal-weekly" };
        const certified = await generate(db, input);
        assert.equal(certified.status, "generated");
        assert.ok(
          (await listRuns(db, org.orgId, adminId, projectId)).some(
            (row) => row.id === certified.id,
          ),
        );
        const stored = (
          await db.execute<{
            fileId: string;
            payload: {
              rows: LaborComplianceReportRow[];
              runDocumentIds: string[];
              weekStart: string;
            };
          }>(
            sql`
      select file_id::text as "fileId", payload from hrm_certified_payroll_runs
      where org_id = ${org.orgId} and id = ${certified.id}`,
            "objects",
          )
        )[0]!;
        assert.deepEqual(stored.payload.runDocumentIds, [run.documentId]);
        assert.equal(stored.payload.weekStart, "2026-07-13");
        const rows = stored.payload.rows;
        assert.equal(rows.length, 2);
        assert.deepEqual(
          rows.map((row) => [
            row.employmentId,
            row.classificationCode,
            row.day,
            row.hours,
            row.baseRate,
          ]),
          [
            [employmentId, "CARP", "2026-07-13", "1.0000", "30.0100"],
            [employmentId, "FORM", "2026-07-14", "1.0000", "30.0100"],
          ],
        );
        // Three equal paid buckets allocate the residual to the earliest bucket. The third belongs outside this project.
        for (const key of ["deductions", "net"] as const) {
          const total = toUnits(stub[key]);
          assert.notEqual(
            total % 3n,
            0n,
            "the posted amount exercises a real allocation remainder",
          );
          const ordinary = total / 3n;
          const first = total - ordinary * 2n;
          assert.equal(rows[0]![key], fromUnits(first));
          assert.equal(rows[1]![key], fromUnits(ordinary));
          assert.equal(sum([...rows.map((row) => row[key]), fromUnits(ordinary)]), stub[key]);
          assert.ok(
            toUnits(sum(rows.map((row) => row[key]))) < total,
            "nonproject pay remains outside the project filing",
          );
        }
        const downloaded = await downloadRun(db, org.orgId, adminId, certified.id);
        assert.equal(downloaded.contentType, "text/plain");
        assert.equal(
          downloaded.filename,
          `certified-payroll-native-certified-job-${weekEnding}.txt`,
        );
        assert.match(downloaded.body, /FEDERAL WEEKLY CERTIFIED PAYROLL/);
        assert.match(downloaded.body, /CARP Carpenter\|2026-07-13\|1\.0000\|30\.0100/);
        assert.match(downloaded.body, /FORM Formworker\|2026-07-14\|1\.0000\|30\.0100/);
        assert.doesNotMatch(downloaded.body, /2026-07-15/);
        const filed = (
          await db.execute<{ body: string }>(
            sql`select convert_from(b.bytes, 'UTF8') as body
      from files f join file_blobs b on b.version_id = f.current_version_id
      where f.org_id = ${org.orgId} and f.id = ${stored.fileId}`,
            "objects",
          )
        )[0];
        assert.equal(filed?.body, downloaded.body);
        await assert.rejects(
          () => downloadRun(db, org.orgId, outsiderId, certified.id),
          HrmAuthorizationError,
        );
        await assertConstructionRefusal(() => generate(db, input), /already exists/);
        const unpaidProjectId = await seedProject(org.orgId, "Unpaid certified job");
        assert.equal(
          (
            await db.execute(
              sql`update projects set subsidiary_id = ${org.subsidiaryId}
      where org_id = ${org.orgId} and id = ${unpaidProjectId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await seedTime(org.orgId, partyId, unpaidProjectId, "2026-07-16", "0.2500");
        await assertConstructionRefusal(
          () => generate(db, { ...input, projectId: unpaidProjectId }),
          /not covered by a posted pay stub/,
        );
        assert.equal(
          (
            await db.execute<{ count: number }>(
              sql`select count(*)::int as count
      from hrm_certified_payroll_runs where org_id = ${org.orgId}`,
              "objects",
            )
          )[0]?.count,
          1,
        );
        assert.deepEqual(
          await downloadRun(db, org.orgId, adminId, certified.id),
          downloaded,
          "new approved time and refused generation cannot reinterpret the frozen file",
        );
        const otherProjectId = await seedProject(org.orgId, "Other employer job");
        assert.equal(
          (
            await db.execute(
              sql`update projects set subsidiary_id = ${otherSubsidiaryId}
      where org_id = ${org.orgId} and id = ${otherProjectId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await seedTime(org.orgId, partyId, otherProjectId, "2026-07-13", "1.0000");
        await assertConstructionRefusal(
          () => generate(db, { ...input, projectId: otherProjectId }),
          /No posted pay run covers/,
        );
        assert.deepEqual(await listRuns(db, org.orgId, adminId, otherProjectId), []);
        assert.equal(
          (
            await db.execute<{ count: number }>(
              sql`select count(*)::int as count
      from files where org_id = ${org.orgId} and source_system = 'hrm-construction'`,
              "objects",
            )
          )[0]?.count,
          1,
          "duplicate and unpaid generation roll back their cabinet writes",
        );
      },
    );
  },
);

test(
  "certified payroll resolves one employment per day and refuses history fan-out",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CONSTRUCTION_SPEC),
      async (h) => {
        const { org, adminId } = h;
        const { employmentId: firstId, partyId } = await seedNamedWorker(
          org.orgId,
          org.subsidiaryId,
          "Certified Worker",
        );
        const resolve = (day: string) => resolveCertifiedEmployment(db, org.orgId, partyId, day);
        assert.equal(await resolve("2026-09-08"), firstId);
        // Retire v1 through the lawful 0184 closing transition: live version
        // rows are append-only (effective_to can never be rewritten), so the
        // close (recorded_until + superseded_by + evidence event, one
        // transaction) retires the first employment and its successor version
        // ends before the probed day.
        const v1 = (
          await db.execute<{ rowId: string; before: unknown }>(
            sql`
      select id::text as "rowId", to_jsonb(v) as "before" from worker_employment_versions v
       where v.org_id = ${org.orgId} and v.employment_id = ${firstId} and v.version_no = 1`,
            "objects",
          )
        )[0];
        assert.ok(v1, "seeded v1 must exist before the lawful close");
        const changeId = randomUUID();
        await withOrgTransaction(org.orgId, async () => {
          const at = (
            await db.execute<{ now: string }>(sql`select now()::text as now`, "objects")
          )[0]!.now;
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
        await db.execute(
          sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision) values (${secondId}, ${org.orgId}, ${partyId}, ${org.subsidiaryId}, 1)`,
        );
        await db.execute(
          sql`insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, recorded_at) values (${org.orgId}, ${secondId}, 1, 'active', '2026-01-01', now())`,
        );
        assert.equal(await resolve("2026-09-08"), secondId);
        const thirdId = randomUUID();
        await db.execute(
          sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision) values (${thirdId}, ${org.orgId}, ${partyId}, ${org.subsidiaryId}, 1)`,
        );
        await db.execute(
          sql`insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, recorded_at) values (${org.orgId}, ${thirdId}, 1, 'active', '2026-01-01', now())`,
        );
        await assertConstructionRefusal(
          () => resolve("2026-09-08"),
          /2 employments effective 2026-09-08/,
        );
      },
    );
  },
);

test(
  "labor-costing hook prices in-scope hours first and leaves the standard path alone",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CONSTRUCTION_SPEC),
      async (h) => {
        const { org, adminId } = h;
        const { employmentId, partyId } = await seedNamedWorker(
          org.orgId,
          org.subsidiaryId,
          "Hook Worker",
        );
        const projectId = await seedProject(org.orgId, "Hook Job");
        const journey = await createClassification(db, {
          orgId: org.orgId,
          actorId: adminId,
          code: "HOOK-J",
          name: "Hook journey",
          trade: "Hook",
        });
        const schedule = await createSchedule(db, {
          orgId: org.orgId,
          actorId: adminId,
          kind: "prevailing_wage",
          name: "Hook schedule",
          appliesTo: { project_ids: [projectId] },
          reciprocity: "jobsite_local",
          effectiveFrom: "2026-01-01",
        });
        await addScheduleLine(db, {
          orgId: org.orgId,
          actorId: adminId,
          scheduleId: schedule.id,
          classificationId: journey.id,
          baseRate: "77.0000",
          currency: "CAD",
          effectiveFrom: "2026-01-01",
        });
        await assignClassification(db, {
          orgId: org.orgId,
          actorId: adminId,
          employmentId,
          classificationId: journey.id,
          effectiveFrom: "2026-01-01",
        });
        await seedTime(org.orgId, partyId, projectId, "2026-09-08", "8.0000");
        const entryId = (
          await db.execute<{ id: string }>(
            sql`
      select id::text as id from time_entries
       where org_id = ${org.orgId} and employee_party_id = ${partyId} and worked_on = '2026-09-08'::date
    `,
            "objects",
          )
        )[0]!.id;
        // Scratch orgs settle in CAD: price the line in the org currency so
        // the snapshot converts nothing and the hook's own stamp is measured.
        setPrevailingWageEntryWage(prevailingWageForTimeEntry);
        try {
          const stamped = await snapshotLaborCostRates(org.orgId, [entryId], { actorId: adminId });
          assert.equal(stamped, 1);
          const stamped_row = (
            await db.execute<{ wage: string; rateId: string | null }>(
              sql`
        select wage_rate::text as wage, labor_cost_rate_id::text as "rateId"
          from time_entries where id = ${entryId}::uuid
      `,
              "objects",
            )
          )[0]!;
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
      },
    );
  },
);

test(
  "travel pay computes hourly and per-km; second org sees zero rows",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CONSTRUCTION_SPEC),
      async (h) => {
        const { org, adminId } = h;
        const { employmentId, partyId } = await seedNamedWorker(
          org.orgId,
          org.subsidiaryId,
          "Travel Worker",
        );
        const projectId = await seedProject(org.orgId, "Travel Job");
        const componentId = await seedComponent(org.orgId, { kind: "earning" });
        await createPolicy(db, {
          orgId: org.orgId,
          actorId: adminId,
          name: "Travel policy",
          basis: "hours_threshold",
          rules: { min_hours: 6, amount_for_hours: "20.0000", amount_per_km: "0.6700" },
          currency: "USD",
          effectiveFrom: "2026-01-01",
          payComponentId: componentId,
        });
        await seedTime(org.orgId, partyId, projectId, "2026-09-08", "8.0000");
        const hourly = await computeTravelForWeek(db, {
          orgId: org.orgId,
          actorId: adminId,
          employmentId,
          weekStart: "2026-09-07",
          mode: "hourly",
        });
        assert.equal(hourly.length, 1);
        assert.equal(hourly[0]!.amount, "160.0000");
        // Record the same finding twice: the second write returns the open row, never a duplicate.
        const first = await recordFinding(db, {
          orgId: org.orgId,
          actorId: adminId,
          kind: "registration_missing",
          projectId,
          workedOn: "2026-09-08",
          detail: {},
        });
        const second = await recordFinding(db, {
          orgId: org.orgId,
          actorId: adminId,
          kind: "registration_missing",
          projectId,
          workedOn: "2026-09-08",
          detail: {},
        });
        assert.equal(first.id, second.id);
        // Second org sees zero rows at the storage floor.
        const foreign = await createScratchOrg();
        try {
          const client = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
          await client.connect();
          try {
            await client.query("select set_config('app.current_org', $1, false)", [foreign.orgId]);
            const res = await client.query(
              "select count(*)::int as n from hrm_compliance_findings where id = $1",
              [first.id],
            );
            assert.equal(res.rows[0].n, 0, "a foreign org session sees zero rows");
          } finally {
            await client.end();
          }
        } finally {
          await dropScratchOrg(foreign.orgId);
        }
      },
    );
  },
);
