import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

// Dynamic, after the hooks: a static import would resolve 'server-only'
// before the hooks run and throw. Same pattern as the data-io
// payroll-opening-balances suite.
const { payrollEmployerLevyOpeningsResource } = (await import(
  "./payroll-employer-levy-openings-resource.ts"
)) as typeof import("./payroll-employer-levy-openings-resource.ts");
hooks.deregister();

const { sql } = await import("drizzle-orm");
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { cmp } = await import("@openbooks/engine/src/money/money.ts");
const { PAYROLL_COUNTRY_PACKS } = await import("@openbooks/engine/src/payroll/packs.ts");
const { setPackSlotAccount } = await import("@openbooks/engine/src/payroll/packs.ts");
const { seedPayrollComponents } = await import("@openbooks/engine/src/payroll/run-setup.ts");
const { calculatePayRun } = await import("@openbooks/engine/src/payroll/run-calculation.ts");
const { createPayRun } = await import("@openbooks/engine/src/payroll/run-lifecycle.ts");
const {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} = await import("@openbooks/engine/src/testing/fixtures.ts");

/**
 * The employer carry-in's missing arm: `saveEmployerLevyOpening` existed and
 * was tested, but no route, UI section or import resource called it, so a
 * mid-year adopter's employer levies silently restarted at zero.
 *
 * These tests prove the import arm end to end with synthetic CA-pack
 * declarations only — no pack content changes, the mutation is confined to
 * each test and restored in `finally` (the ZZ-pack precedent). A levy the
 * file names but nothing declares is refused, not shelved.
 *
 * DB partition: scratch org, synthetic data only, no DDL.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

function thresholdLevy() {
  return {
    key: "synth_threshold",
    label: "Synthetic threshold levy",
    systemKey: "eht",
    description: "Synthetic threshold levy",
    sequence: 271,
    base: { source: "gross", scope: "org" },
    timing: "per_run",
    rate: { kind: "flat_percent", percent: "10" },
    allowance: { kind: "employer_allowance", amount: "1000" },
    factorKey: "SYNTH",
  };
}

async function withDeclarations<T>(levies: unknown[], fn: () => Promise<T>): Promise<T> {
  const pack = PAYROLL_COUNTRY_PACKS.CA;
  assert.ok(pack, "CA pack registered");
  const had = Object.hasOwn(pack, "employerAggregateLevies");
  const before = pack.employerAggregateLevies;
  pack.employerAggregateLevies = () => levies as never;
  try {
    return await fn();
  } finally {
    if (had) pack.employerAggregateLevies = before;
    else delete pack.employerAggregateLevies;
  }
}

async function seedHarness(orgId: string, actorId: string): Promise<void> {
  const account = async (number: string, name: string, type: string) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                            reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false,
              '[]'::jsonb, '{}'::jsonb, true)`);
    return id;
  };
  const wageExpense = await account("6000", "Wages expense", "expense");
  const burdenExpense = await account("6010", "Payroll burden", "expense");
  const netPayable = await account("2300", "Wages payable", "liability_current");
  const craPayable = await account("2310", "CRA remittances payable", "liability_current");
  const ehtPayable = await account("2340", "EHT payable", "liability_current");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        cppPayableAccountId: craPayable,
        eiPayableAccountId: craPayable,
        taxPayableAccountId: craPayable,
        wagesTo: "expense",
      },
    })}::jsonb where id = ${orgId}`);
  await seedPayrollComponents(orgId, actorId, "CA");
  await setPackSlotAccount(orgId, actorId, "CA", "eht", ehtPayable);
}

async function seedWorkforce(orgId: string, actorId: string, scheduleId: string): Promise<string> {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${orgId}, 'person', 'Amy Aggregate', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${orgId}, ${employeeId}, 'CAD', '50', 'hour', '2026-01-01', true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           is_active, created_by, updated_by)
    values (${orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
            true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, status,
                              is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${orgId}, ${employeeId}, '2026-07-06', '10', null, 'approved', false,
            'unbilled', 'actual', ${actorId}, ${actorId})`);
  return employeeId;
}

async function stubFactors(orgId: string, documentId: string): Promise<Record<string, Record<string, string>>> {
  const rows = (await db.execute<{ employee: string; factors: Record<string, string> }>(sql`
    select p.display_name as employee, s.factors
      from pay_stubs s
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
  `));
  return Object.fromEntries(rows.rows.map((row) => [row.employee, row.factors]));
}

test(
  "an imported employer carry-in prices the first run's levy against the threshold",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    const scheduleId = randomUUID();
    try {
      await withBypassContext(async () => {
        await seedHarness(org.orgId, actorId);
        await db.execute(sql`
          insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                     pay_date_offset_days, is_active, created_by, updated_by)
          values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                  ${actorId}, ${actorId})`);
        await seedWorkforce(org.orgId, actorId, scheduleId);
      });
      await withDeclarations([thresholdLevy()], async () => {
        const resource = payrollEmployerLevyOpeningsResource(org.orgId);
        const ctx = { orgId: org.orgId, actorId, dryRun: false, allowedSubsidiaryIds: null };
        const outcome = await resource.write(
          [{ country: "CA", levy: "synth_threshold", region: "", taxYear: 2026, baseYtd: "1500" }],
          "insert",
          ctx,
        );
        assert.equal(outcome.failed, 0);
        assert.equal(outcome.created, 1);

        // The stub prices from the imported carry-in: (1,500 + 500 − 1,000) at 10%.
        const run = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: "2026-07-05", periodEnd: "2026-07-18",
        });
        const calculated = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        assert.deepEqual(calculated.errors, []);
        const factors = await stubFactors(org.orgId, run.documentId);
        assert.equal(cmp(factors["Amy Aggregate"]!["SYNTH"] ?? "?", "50"), 0);

        // The export reads the imported row back with its levy label.
        const exported = await resource.read();
        assert.equal(exported.rows.length, 1);
        assert.equal(exported.rows[0]!.country, "CA");
        assert.equal(exported.rows[0]!.baseYtd, "1500.0000");
      });
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "an import row naming a levy nothing declares is refused, not shelved",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    try {
      await withDeclarations([thresholdLevy()], async () => {
        const resource = payrollEmployerLevyOpeningsResource(org.orgId);
        const ctx = { orgId: org.orgId, actorId, dryRun: false, allowedSubsidiaryIds: null };
        const outcome = await resource.write(
          [{ country: "CA", levy: "nope", region: "", taxYear: 2026, baseYtd: "100" }],
          "insert",
          ctx,
        );
        assert.equal(outcome.failed, 1);
        assert.equal(outcome.created, 0);
        assert.equal(outcome.errors.length, 1);
        assert.match(outcome.errors[0]!.message, /not declared by the CA pack/);
        const count = (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from payroll_employer_levy_opening where org_id = ${org.orgId}`));
        assert.equal(count.rows[0]!.n, 0);
      });
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
