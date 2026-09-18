import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { cmp } from "./money.ts";
import { payRunStaleness } from "./payroll-readiness.ts";
import { PAYROLL_COUNTRY_PACKS } from "./payroll/packs.ts";
import type { PayrollEmployerAggregateLevy } from "./payroll/packs.ts";
import { assessStubAggregateLevies } from "./payroll/employer-aggregate-priors.ts";
import { saveEmployerLevyOpening, saveOpeningBalances } from "./payroll-opening-balances.ts";
import { setPackSlotAccount } from "./payroll/packs.ts";
import {
  calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents,
} from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

/**
 * Employer-aggregate levies, run-wiring half.
 *
 * The pure arithmetic is pinned without a database beside the assessor;
 * these tests prove the WIRING end to end with synthetic CA-pack
 * declarations only — no pack content changes, the mutation is confined to
 * each test and restored in `finally` (the ZZ-pack precedent). A failure
 * here is about priors resolution, factor merge, fences, or staleness, and
 * never about a jurisdiction's figures.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Threshold shape: 10% past a 1,000 allowance, org-wide, on the EHT slot. */
function thresholdLevy(overrides: Partial<PayrollEmployerAggregateLevy> = {}): PayrollEmployerAggregateLevy {
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
    ...overrides,
  };
}

function caPack() {
  const pack = PAYROLL_COUNTRY_PACKS.CA;
  assert.ok(pack, "CA pack registered");
  return pack;
}

async function withDeclarations<T>(
  levies: PayrollEmployerAggregateLevy[] | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const pack = caPack();
  const had = Object.hasOwn(pack, "employerAggregateLevies");
  const before = pack.employerAggregateLevies;
  if (levies === undefined) {
    delete pack.employerAggregateLevies;
  } else {
    pack.employerAggregateLevies = () => levies;
  }
  try {
    return await fn();
  } finally {
    if (had) pack.employerAggregateLevies = before;
    else delete pack.employerAggregateLevies;
  }
}

async function seedHarness(orgId: string, actorId: string): Promise<{ ehtPayable: string }> {
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
  return { ehtPayable };
}

async function makeSchedule(orgId: string, actorId: string, name = "Biweekly"): Promise<string> {
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${orgId}, ${name}, 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);
  return scheduleId;
}

async function makeEmployee(
  orgId: string, actorId: string, scheduleId: string, name: string, hourlyRate: string,
): Promise<string> {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${orgId}, ${employeeId}, 'CAD', ${hourlyRate}, 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           is_active, created_by, updated_by)
    values (${orgId}, ${employeeId}, ${scheduleId}, 'ON', 'hourly', 1, 1,
            true, ${actorId}, ${actorId})`);
  return employeeId;
}

async function postHours(
  orgId: string, actorId: string, employeeId: string, workedOn: string, hours: string,
): Promise<void> {
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, status,
                              is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${orgId}, ${employeeId}, ${workedOn}, ${hours}, null, 'approved', false,
            'unbilled', 'actual', ${actorId}, ${actorId})`);
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
  "aggregate threshold levy sequences across stubs and reconciles across runs",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await seedHarness(org.orgId, actorId);
      const scheduleId = await makeSchedule(org.orgId, actorId);
      const empA = await makeEmployee(org.orgId, actorId, scheduleId, "Amy Aggregate", "50");
      const empB = await makeEmployee(org.orgId, actorId, scheduleId, "Bob Base", "50");
      // $1,000 each: the first stub prices nothing (allowance 1,000), the
      // second prices the 1,000 above it at 10%.
      await postHours(org.orgId, actorId, empA, "2026-07-06", "20");
      await postHours(org.orgId, actorId, empB, "2026-07-06", "20");
      const employees = (await db.execute<{ id: string; display_name: string }>(sql`
        select id, display_name from parties where org_id = ${org.orgId} and kind = 'person'
      `));
      await withDeclarations([thresholdLevy()], async () => {
        const run = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: "2026-07-05", periodEnd: "2026-07-18",
        });
        const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        assert.deepEqual(result.errors, []);
        const factors = await stubFactors(org.orgId, run.documentId);
        const amounts = [factors["Amy Aggregate"]!["SYNTH"] ?? "0", factors["Bob Base"]!["SYNTH"] ?? "0"]
          .sort((a, b) => Number(a) - Number(b));
        // One stub prices the whole excess; the other prices nothing but
        // still stamps its base (its SYNTH_EARN is what sequences the room).
        assert.equal(cmp(amounts[0]!, "0"), 0);
        assert.equal(cmp(amounts[1]!, "100"), 0);
        const earns = [factors["Amy Aggregate"]!["SYNTH_EARN"] ?? "0", factors["Bob Base"]!["SYNTH_EARN"] ?? "0"];
        assert.ok(earns.every((e) => cmp(e, "1000") === 0), "both stubs stamp the full base");
        await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

        // A later run prices from the committed total: 2,000 of base used,
        // so $500 prices 500 at 10%.
        const amy = employees.rows.find((e) => e.display_name === "Amy Aggregate")!;
        await postHours(org.orgId, actorId, amy.id, "2026-07-22", "10");
        const run2 = await createPayRun({ orgId: org.orgId, actorId, payScheduleId: scheduleId });
        await calculatePayRun({ orgId: org.orgId, documentId: run2.documentId, actorId });
        const factors2 = await stubFactors(org.orgId, run2.documentId);
        assert.equal(cmp(factors2["Amy Aggregate"]!["SYNTH"] ?? "?", "50"), 0);
        await commitPayRun({ orgId: org.orgId, documentId: run2.documentId, actorId });

        // The year reconciles: 10% of (2,500 − 1,000).
        const total = (await db.execute<{ total: string }>(sql`
          select coalesce(sum((s.factors->>'SYNTH')::numeric), 0)::text as total
            from pay_stubs s
            join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
           where s.org_id = ${org.orgId} and s.tax_year = 2026 and r.run_status = 'committed'
        `));
        assert.equal(cmp(total.rows[0]!.total, "150"), 0);
      });
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a disjoint-roster commit refuses on employer room, then commits after recalculation",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await seedHarness(org.orgId, actorId);
      const scheduleA = await makeSchedule(org.orgId, actorId, "Biweekly A");
      const scheduleB = await makeSchedule(org.orgId, actorId, "Biweekly B");
      const empA = await makeEmployee(org.orgId, actorId, scheduleA, "Amy Aggregate", "40");
      const empB = await makeEmployee(org.orgId, actorId, scheduleB, "Bob Base", "40");
      await postHours(org.orgId, actorId, empA, "2026-07-06", "20");
      await postHours(org.orgId, actorId, empB, "2026-07-06", "20");
      await withDeclarations([thresholdLevy()], async () => {
        const runA = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleA,
          periodStart: "2026-07-05", periodEnd: "2026-07-18",
        });
        const runB = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleB,
          periodStart: "2026-07-05", periodEnd: "2026-07-18",
        });
        // Both calculate against empty room: $800 each prices nothing.
        for (const run of [runA, runB]) {
          const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
          assert.deepEqual(result.errors, []);
        }
        await commitPayRun({ orgId: org.orgId, documentId: runA.documentId, actorId });
        // The rosters share no employee, so the `ytd` arm stays silent — but
        // run B's calculation predates run A's consumption of the room.
        const staleness = await payRunStaleness(org.orgId, runB.documentId);
        assert.ok(staleness.reasons.includes("employerLevyYtd"), `got ${staleness.reasons.join(",")}`);
        assert.ok(!staleness.reasons.includes("ytd"), "no shared employee, no ytd reason");
        await assert.rejects(
          commitPayRun({ orgId: org.orgId, documentId: runB.documentId, actorId }),
          /recalculate before committing/,
        );
        // Recalculated, B prices from A's committed base: (800 + 800 − 1000)
        // at 10% is 60, and the year reconciles exactly.
        await calculatePayRun({ orgId: org.orgId, documentId: runB.documentId, actorId });
        const factors = await stubFactors(org.orgId, runB.documentId);
        assert.equal(cmp(factors["Bob Base"]!["SYNTH"] ?? "?", "60"), 0);
        await commitPayRun({ orgId: org.orgId, documentId: runB.documentId, actorId });
        const total = (await db.execute<{ total: string }>(sql`
          select coalesce(sum((s.factors->>'SYNTH')::numeric), 0)::text as total
            from pay_stubs s
            join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
           where s.org_id = ${org.orgId} and s.tax_year = 2026 and r.run_status = 'committed'
        `));
        assert.equal(cmp(total.rows[0]!.total, "60"), 0);
      });
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "employer carry-in seeds room, deletes at zero, and locks after commit",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await seedHarness(org.orgId, actorId);
      const scheduleId = await makeSchedule(org.orgId, actorId);
      const empA = await makeEmployee(org.orgId, actorId, scheduleId, "Amy Aggregate", "50");
      await postHours(org.orgId, actorId, empA, "2026-07-06", "10");
      await withDeclarations([thresholdLevy()], async () => {
        // A carry-in for a levy nobody declares is refused, not shelved.
        await assert.rejects(
          saveEmployerLevyOpening({
            orgId: org.orgId, actorId, taxYear: 2026,
            rows: [{ country: "CA", levyKey: "nope", region: null, baseYtd: "100" }],
          }),
          /not declared by the CA pack/,
        );
        const saved = await saveEmployerLevyOpening({
          orgId: org.orgId, actorId, taxYear: 2026,
          rows: [{ country: "CA", levyKey: "synth_threshold", region: null, baseYtd: "1500" }],
        });
        assert.deepEqual([saved.created, saved.updated, saved.deleted], [1, 0, 0]);
        // A zero row deletes the carry-in instead of storing zeros.
        const cleared = await saveEmployerLevyOpening({
          orgId: org.orgId, actorId, taxYear: 2026,
          rows: [{ country: "CA", levyKey: "synth_threshold", region: null, baseYtd: "0" }],
        });
        assert.deepEqual([cleared.created, cleared.updated, cleared.deleted], [0, 0, 1]);
        await saveEmployerLevyOpening({
          orgId: org.orgId, actorId, taxYear: 2026,
          rows: [{ country: "CA", levyKey: "synth_threshold", region: null, baseYtd: "1500" }],
        });

        // The stub prices from the carry-in: (1,500 + 500 − 1,000) at 10%.
        const run = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: "2026-07-05", periodEnd: "2026-07-18",
        });
        await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        const factors = await stubFactors(org.orgId, run.documentId);
        assert.equal(cmp(factors["Amy Aggregate"]!["SYNTH"] ?? "?", "50"), 0);
        await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

        // Committed room locks the carry-in: void the run to change it.
        await assert.rejects(
          saveEmployerLevyOpening({
            orgId: org.orgId, actorId, taxYear: 2026,
            rows: [{ country: "CA", levyKey: "synth_threshold", region: null, baseYtd: "999" }],
          }),
          /void that run/,
        );
      });
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "per-employee cap carries through stub factors and the opening field",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await seedHarness(org.orgId, actorId);
      const scheduleId = await makeSchedule(org.orgId, actorId);
      const empA = await makeEmployee(org.orgId, actorId, scheduleId, "Amy Aggregate", "50");
      await postHours(org.orgId, actorId, empA, "2026-07-06", "20");
      const capLevy = thresholdLevy({
        key: "synth_cap",
        description: "Synthetic cap levy",
        rate: { kind: "flat_percent", percent: "10" },
        allowance: { kind: "per_employee_cap", amount: "2000" },
        employeeOpeningFieldKey: "wcbAssessableYtd",
        factorKey: "SYNCAP",
      });
      await withDeclarations([capLevy], async () => {
        // 1,500 carried in: the first 1,000 prices 500 of headroom at 10%.
        await saveOpeningBalances({
          orgId: org.orgId, actorId, taxYear: 2026,
          rows: [{ employeePartyId: empA, amounts: { wcbAssessableYtd: "1500" } }],
        });
        const run = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: "2026-07-05", periodEnd: "2026-07-18",
        });
        await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        const factors = await stubFactors(org.orgId, run.documentId);
        assert.equal(cmp(factors["Amy Aggregate"]!["SYNCAP"] ?? "?", "50"), 0);
        await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

        // The cap is exhausted (1,500 + 500 of 2,000): a later run accrues
        // nothing and stamps nothing.
        await postHours(org.orgId, actorId, empA, "2026-07-22", "20");
        const run2 = await createPayRun({ orgId: org.orgId, actorId, payScheduleId: scheduleId });
        await calculatePayRun({ orgId: org.orgId, documentId: run2.documentId, actorId });
        const factors2 = await stubFactors(org.orgId, run2.documentId);
        assert.ok(!("SYNCAP" in (factors2["Amy Aggregate"] ?? {})), "no cap factor past the cap");
      });
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "wiring refuses a colliding factor key, a wrongly-assessed component, and an unknown opening field",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await seedHarness(org.orgId, actorId);
      const scheduleId = await makeSchedule(org.orgId, actorId);
      const empA = await makeEmployee(org.orgId, actorId, scheduleId, "Amy Aggregate", "50");
      await postHours(org.orgId, actorId, empA, "2026-07-06", "20");
      await postHours(org.orgId, actorId, empA, "2026-07-20", "20");
      await postHours(org.orgId, actorId, empA, "2026-08-03", "20");
      // One window per sub-case: overlapping runs on a schedule are refused.
      const windows = [
        { periodStart: "2026-07-05", periodEnd: "2026-07-18" },
        { periodStart: "2026-07-19", periodEnd: "2026-08-01" },
        { periodStart: "2026-08-02", periodEnd: "2026-08-15" },
      ];
      let window = 0;
      const freshRun = async () => createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        ...windows[window++ % windows.length]!,
      });

      // "B" is the pack's non-periodic factor: reusing it would accumulate
      // two levies into one year-to-date. The wiring refusal surfaces as a
      // stub error (which blocks the commit below), not a thrown rejection.
      await withDeclarations([thresholdLevy({
        key: "colliding", factorKey: "B", allowance: { kind: "none" },
      })], async () => {
        const run = await freshRun();
        const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        assert.equal(result.errors.length, 1);
        assert.match(
          result.errors[0]!.message,
          /collides with the CA pack's statutory factors/,
        );
        // The errored stub never materializes, so the commit finds no
        // calculated stubs and refuses: the colliding figures move nowhere.
        await assert.rejects(
          commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId }),
          /pay run has no calculated stubs/,
        );
      });

      // A levy pointed at a deduction-sensitive component would drift across
      // the fixpoint: refused at wiring, by levy name. Proven by calling the
      // same assessor `calculate` calls: going through a full run would trip
      // the seeder (and then the table CHECK) on the unseedable fake
      // component before the guard is even reached.
      const slots = caPack().statutorySlots;
      const taxedSlot = {
        key: "synth_tax_slot",
        components: [{
          code: "SYNTH-TAX", name: "Synthetic", systemKey: "synth_tax",
          kind: "employer_contribution", sequence: 999,
          assessedOn: "taxable_income", remittance: "external",
        }],
      } as const;
      (caPack() as { statutorySlots: readonly unknown[] }).statutorySlots = [
        ...slots, taxedSlot,
      ];
      try {
        await withDeclarations([thresholdLevy({
          key: "mispointed", systemKey: "synth_tax", factorKey: "MIS",
          allowance: { kind: "none" },
        })], async () => {
          await db.transaction(async (tx) => {
            await assert.rejects(
              assessStubAggregateLevies({
                tx, orgId: org.orgId, documentId: randomUUID(), employeePartyId: empA,
                taxYear: 2026, country: "CA", region: "ON",
                gross: "1000", taxableGross: "1000", lines: [],
                pushStatutory: () => {},
              }),
              /must ride an earnings-assessed/,
            );
          });
        });
      } finally {
        caPack().statutorySlots = slots;
      }

      // An opening key the pack never declared is a refusal, not a query
      // against a column that does not exist.
      await withDeclarations([thresholdLevy({
        key: "badopening", factorKey: "BAD",
        allowance: { kind: "per_employee_cap", amount: "2000" },
        employeeOpeningFieldKey: "nope",
      })], async () => {
        const run = await freshRun();
        const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        assert.equal(result.errors.length, 1);
        assert.match(result.errors[0]!.message, /declares no such year-to-date field/);
      });
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "annual-timing levies accrue nothing on a real run",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await seedHarness(org.orgId, actorId);
      const scheduleId = await makeSchedule(org.orgId, actorId);
      const empA = await makeEmployee(org.orgId, actorId, scheduleId, "Amy Aggregate", "50");
      await postHours(org.orgId, actorId, empA, "2026-07-06", "20");
      await withDeclarations([thresholdLevy({
        key: "synth_annual",
        description: "Synthetic annual levy",
        timing: "annual",
        factorKey: "ANN",
        offset: { kind: "tenant_spend", slotKey: "spend", amountField: "amount" },
      })], async () => {
        const run = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: "2026-07-05", periodEnd: "2026-07-18",
        });
        const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        assert.deepEqual(result.errors, []);
        const factors = await stubFactors(org.orgId, run.documentId);
        assert.ok(!("ANN" in (factors["Amy Aggregate"] ?? {})), "no annual factor on the stub");
        const lines = (await db.execute<{ description: string }>(sql`
          select l.description from pay_stub_lines l
            join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
           where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
        `));
        assert.ok(
          lines.rows.every((l) => l.description !== "Synthetic annual levy"),
          "no annual levy line on the stub",
        );
        await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      });
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
