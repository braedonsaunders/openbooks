import {
  seedCanadianFilingAccountForTest,
  qualifyCanadianOpeningForTest,
} from "./filing-test-fixtures.ts";
import { seedPayrollAccountingConfiguration } from "../testing/fixtures.ts";
import { assessedCanadianWages } from "../testing/payroll-canadian-wages.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, neg, sum } from "../money/money.ts";
import { calculateT4127 } from "./canada/t4127.ts";
import { saveOpeningBalances } from "./opening-balances.ts";
import { setPackSlotAccount } from "./packs.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture, seedVacationTerms } from "./filing-test-fixtures.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  seedWorkerEmployment,
  grantScratchPermissions,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Lean WCB-only harness: one hourly ON employee at the given rate, three jobs. */
async function seedWcbHarness(
  orgId: string,
  actorId: string,
  subsidiaryId: string,
  hourlyRate: string,
  ehtExemption = "1000000",
): Promise<{
  scheduleId: string;
  employeeId: string;
  filingAccountId: string;
  jobA: string;
  jobB: string;
  jobC: string;
  postHours: (workedOn: string, hours: string, projectId: string | null) => Promise<void>;
}> {
  await grantScratchPermissions(orgId, actorId, ["payroll.run", "payroll.read"]);
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
  const wcbPayable = await account("2330", "WSIB payable", "liability_current");
  await seedPayrollAccountingConfiguration(orgId, {
    wageExpenseAccountId: wageExpense,
    burdenExpenseAccountId: burdenExpense,
    netPayAccountId: netPayable,
    wagesTo: "expense",
    slotAccounts: {
      CA: { cpp: craPayable, ei: craPayable, qpip: craPayable, income_tax: craPayable },
    },
  });

  await seedPayrollComponents(orgId, actorId, "CA");
  await seedOntarioEhtFixture(orgId, actorId, ehtExemption);
  await setPackSlotAccount(orgId, actorId, "CA", "wcb", wcbPayable);

  const wcbGroupId = randomUUID();
  await db.execute(sql`
    insert into worker_comp_groups (id, org_id, code, name, rate_percent, max_assessable, is_active)
    values (${wcbGroupId}, ${orgId}, 'CLASS-A', 'Construction class A', '2', '2000', true)`);

  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${orgId}, 'person', 'Robin Rounding', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, worker_comp_group_id)
    values (${randomUUID()}, ${orgId}, ${employeeId}, ${wcbGroupId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${orgId}, ${employeeId}, 'CAD', ${hourlyRate}, 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);
  // Stub calculation refuses employees without an HRM employment, so the hire
  // carries one and the profile points at it.
  const filingAccountId = await seedCanadianFilingAccountForTest(orgId, actorId, {
    subsidiaryId,
    accountNumber: "123456789RP0001",
    name: "CRA payroll registration",
    effectiveFrom: "2026-01-01",
    eiEmployerMultiplier: "1.4",
  });
  const employmentId = await seedWorkerEmployment(orgId, employeeId, subsidiaryId);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                           country, province, pay_basis, federal_claim_code,
                                           provincial_claim_code, is_active, created_by, updated_by)
    values (${orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
            true, ${actorId}, ${actorId})`);
  await db.execute(sql`update employee_payroll_profiles set filing_account_id=${filingAccountId}
    where org_id=${orgId} and employee_party_id=${employeeId}`);
  await seedVacationTerms(orgId, employmentId, actorId, "0", "accrue");
  const jobs = { jobA: randomUUID(), jobB: randomUUID(), jobC: randomUUID() };
  for (const [id, name] of [
    [jobs.jobA, "Job A"],
    [jobs.jobB, "Job B"],
    [jobs.jobC, "Job C"],
  ] as const) {
    await db.execute(sql`
      insert into projects (id, org_id, name, code, is_active, custom)
      values (${id}, ${orgId}, ${name}, ${name}, true, '{}'::jsonb)`);
  }
  const postHours = async (workedOn: string, hours: string, projectId: string | null) => {
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, status,
                                is_billable, billing_status, costing_basis, created_by, updated_by)
      values (${orgId}, ${employeeId}, ${workedOn}, ${hours}, ${projectId}, 'approved', false,
              'unbilled', 'actual', ${actorId}, ${actorId})`);
  };
  return { scheduleId, employeeId, filingAccountId, ...jobs, postHours };
}

test(
  "employer taxes: WCB splits by project under the assessable cap, EHT past the exemption",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const account = async (number: string, name: string, type: string) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                                reconcilable, required_dimensions, custom, subsidiary_include_children)
          values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
                  '[]'::jsonb, '{}'::jsonb, true)`);
        return id;
      };
      const wageExpense = await account("6000", "Wages expense", "expense");
      const burdenExpense = await account("6010", "Payroll burden", "expense");
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      const wcbPayable = await account("2330", "WSIB payable", "liability_current");
      const ehtPayable = await account("2340", "EHT payable", "liability_current");
      await seedPayrollAccountingConfiguration(org.orgId, {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        slotAccounts: {
          CA: { cpp: craPayable, ei: craPayable, qpip: craPayable, income_tax: craPayable },
        },
      });

      await seedPayrollComponents(org.orgId, actorId, "CA");
      await seedOntarioEhtFixture(org.orgId, actorId, "1000");
      await setPackSlotAccount(org.orgId, actorId, "CA", "wcb", wcbPayable);
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);

      // Worker-comp class: 2% of assessable earnings, capped at $2,000/yr so
      // the cap binds inside this single $2,400 run.
      const wcbGroupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, max_assessable, is_active)
        values (${wcbGroupId}, ${org.orgId}, 'CLASS-A', 'Construction class A', '2', '2000', true)`);

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Casey Siteworker', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into employee_roles (id, org_id, party_id, worker_comp_group_id)
        values (${randomUUID()}, ${org.orgId}, ${employeeId}, ${wcbGroupId})`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                               country, province, pay_basis, federal_claim_code,
                                               provincial_claim_code, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
                true, ${actorId}, ${actorId})`);
      await seedVacationTerms(org.orgId, employmentId, actorId, "0", "accrue");

      // 40h on each of two jobs → $1,200 per job, $2,400 gross.
      const jobA = randomUUID();
      const jobB = randomUUID();
      for (const [id, name] of [
        [jobA, "Job A"],
        [jobB, "Job B"],
      ] as const) {
        await db.execute(sql`
          insert into projects (id, org_id, name, code, is_active, custom)
          values (${id}, ${org.orgId}, ${name}, ${name}, true, '{}'::jsonb)`);
      }
      for (const [workedOn, projectId] of [
        ["2026-07-06", jobA],
        ["2026-07-08", jobA],
        ["2026-07-10", jobB],
        ["2026-07-14", jobB],
      ] as const) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, status,
                                    is_billable, billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${workedOn}, 20, ${projectId}, 'approved', false,
                  'unbilled', 'actual', ${actorId}, ${actorId})`);
      }

      const run = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      assert.equal(result.employees, 1);
      assert.deepEqual(result.errors, []);

      const stub = (
        await db.execute<{ id: string; factors: Record<string, string> }>(
          sql`
        select id, factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `,
          "objects",
        )
      )[0]!;

      // WCB: cap binds → assessable 2000 of 2400 gross, premium 2% = 40.00.
      assert.equal(stub.factors.WCB_EARN, "2000.0000");
      assert.equal(stub.factors.WCB, "40.0000");
      // EHT: (2400 − 1000 exemption) × 1.95% = 27.30 on full ON remuneration.
      assert.equal(stub.factors.EHT_EARN, "2400.0000");
      assert.equal(stub.factors.EHT, "27.3000");

      const wcbLines = await db.execute<{ amount: string; project_id: string | null }>(
        sql`
        select amount, project_id from pay_stub_lines
         where org_id = ${org.orgId} and stub_id = ${stub.id} and description = 'WCB/WSIB'
         order by project_id`,
        "objects",
      );
      // Proportional to earnings: each job carried half the gross → 20.00 each.
      assert.equal(wcbLines.length, 2);
      assert.ok(wcbLines.every((l) => l.project_id !== null));
      assert.deepEqual(wcbLines.map((l) => l.amount).sort(), ["20.0000", "20.0000"]);
      assert.equal(sum(wcbLines.map((l) => l.amount)), "40.0000");

      const ehtLines = await db.execute<{ amount: string }>(
        sql`
        select amount from pay_stub_lines
         where org_id = ${org.orgId} and stub_id = ${stub.id} and description = 'Employer Health Tax'
      `,
        "objects",
      );
      assert.equal(ehtLines.length, 1);
      assert.equal(ehtLines[0]!.amount, "27.3000");

      // An ON stub carries no Québec line and keeps the federal labels and
      // canonical display order: income tax, CPP/CPP2, EI, then employer
      // shares, WCB, and EHT.
      const onLines = await db.execute<{
        system_key: string | null;
        kind: string;
        description: string;
        sequence: number;
      }>(
        sql`
        select c.system_key, l.kind, l.description, l.sequence
          from pay_stub_lines l
          join pay_components c on c.id = l.component_id
         where l.org_id = ${org.orgId} and l.stub_id = ${stub.id} and l.sequence >= 100
         order by l.sequence`,
        "objects",
      );
      assert.deepEqual(
        onLines.map((row) => [row.sequence, row.system_key, row.kind]),
        [
          [110, "income_tax", "deduction"],
          [120, "cpp", "deduction"],
          [140, "ei", "deduction"],
          [210, "cpp", "employer_contribution"],
          [220, "ei", "employer_contribution"],
          [260, "wcb", "employer_contribution"],
          [260, "wcb", "employer_contribution"],
          [270, "eht", "employer_contribution"],
        ],
      );
      const onLine = (systemKey: string, kind: string) =>
        onLines.find((row) => row.system_key === systemKey && row.kind === kind);
      assert.equal(onLine("cpp", "deduction")!.description, "CPP");
      assert.equal(onLine("cpp", "employer_contribution")!.description, "CPP (employer)");
      assert.ok(
        !onLines.some((row) => row.system_key === "qc_income_tax"),
        "no Québec income tax outside QC",
      );

      // Commit: balanced projection, WCB/EHT credit their slot accounts.
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const lines = await db.execute<{
        account_id: string;
        amount: string;
        project_id: string | null;
      }>(
        sql`
        select account_id, amount, project_id from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}
      `,
        "objects",
      );
      assert.equal(cmp(sum(lines.map((l) => l.amount)), "0"), 0, "GL projection balances");
      const wcbLeg = lines.filter((l) => l.account_id === wcbPayable);
      assert.equal(sum(wcbLeg.map((l) => l.amount)), neg("40.0000"));
      const ehtLeg = lines.filter((l) => l.account_id === ehtPayable);
      assert.equal(sum(ehtLeg.map((l) => l.amount)), neg("27.3000"));
      // The employer-side burden debits carry the job tags.
      const jobDebits = lines.filter((l) => l.project_id !== null && cmp(l.amount, "0") > 0);
      assert.ok(jobDebits.length >= 2, "job-tagged burden debits exist");

      // A second run consumes the remaining WCB room: only $0 of cap is left
      // (2000 already assessed), so no WCB accrues; EHT keeps accruing with
      // the exemption fully consumed.
      await db.execute(sql`
        insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, status,
                                  is_billable, billing_status, costing_basis, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, '2026-07-22', 20, ${jobA}, 'approved', false,
                'unbilled', 'actual', ${actorId}, ${actorId})`);
      const run2 = await createPayRun({ orgId: org.orgId, actorId, payScheduleId: scheduleId });
      await calculatePayRun({ orgId: org.orgId, documentId: run2.documentId, actorId });
      const stub2 = (
        await db.execute<{ factors: Record<string, string> }>(
          sql`
        select factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run2.documentId}
      `,
          "objects",
        )
      )[0]!;
      assert.equal(stub2.factors.WCB ?? "0", "0");
      // 600 × 1.95% — exemption already used by the committed run.
      assert.equal(stub2.factors.EHT, "11.7000");
      assert.equal(stub2.factors.EHT_EARN, "600.0000");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "employer levies: a pre-adoption EHT carry-in consumes the exemption first",
  { skip: !DB },
  async () => {
    // A mid-year adopter's prior provider already paid $600 of Ontario
    // remuneration this year. The $1,000 exemption has $400 left when the
    // first OpenBooks stub prices, so $2,400 of earnings is taxable on
    // $2,000: 2,000 × 1.95% = 39.00. Without the carry-in the same stub
    // would pay 27.30 (the first test pins that).
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const harness = await seedWcbHarness(org.orgId, actorId, org.subsidiaryId, "30", "1000");
      const ehtPayable = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                              reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${ehtPayable}, ${org.orgId}, '2340', 'EHT payable', 'liability_current', false, true,
                false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);
      await saveOpeningBalances({
        orgId: org.orgId,
        actorId,
        taxYear: 2026,
        rows: [{ employeePartyId: harness.employeeId, amounts: { ehtRemunerationYtd: "600" } }],
      });
      await qualifyCanadianOpeningForTest({
        orgId: org.orgId,
        actorId,
        subsidiaryId: org.subsidiaryId,
        employeePartyId: harness.employeeId,
        taxYear: 2026,
        filingAccountId: harness.filingAccountId,
        province: "ON",
        coverageStart: "2026-01-01",
        coverageEnd: "2026-06-30",
        amounts: { ehtRemunerationYtd: "600" },
        reportableBases: { cpp: "0", ei: "0", qpip: "0" },
        levyAllocations: [
          ...["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"].map(
            (region) => ({ programKey: "ca_wcb", region, federalAccountId: null, amount: "0" }),
          ),
          ...["BC", "MB", "NL", "ON"].map((region) => ({
            programKey: "ca_eht",
            region,
            federalAccountId: null,
            amount: region === "ON" ? "600" : "0",
          })),
          { programKey: "ca_cnt", region: "QC", federalAccountId: null, amount: "0" },
        ],
      });

      await harness.postHours("2026-07-06", "20", harness.jobA);
      await harness.postHours("2026-07-08", "20", harness.jobA);
      await harness.postHours("2026-07-10", "20", harness.jobB);
      await harness.postHours("2026-07-14", "20", harness.jobB);
      const run = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: harness.scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      assert.deepEqual(result.errors, []);
      const stub = (
        await db.execute<{ factors: Record<string, string> }>(
          sql`
        select factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `,
          "objects",
        )
      )[0]!;
      assert.equal(stub.factors.EHT_EARN, "2400.0000");
      assert.equal(stub.factors.EHT, "39.0000");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "employer levies: a positive WCB remainder posts as its own untagged line",
  { skip: !DB },
  async () => {
    // Rounding leaves remainder = premium − allocated; when untagged earnings
    // exist (not allTagged) a positive remainder must post as its own
    // untagged allocation — never folded into the last project split, and
    // never thrown as a mismatch.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const harness = await seedWcbHarness(org.orgId, actorId, org.subsidiaryId, "30");
      // $600 on the job, $600 untagged → $1,200 gross, premium 2% = $24.00;
      // the single tagged split takes exactly half, leaving +$12.00.
      await harness.postHours("2026-07-06", "20", harness.jobA);
      await harness.postHours("2026-07-08", "20", null);
      const run = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: harness.scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      assert.deepEqual(result.errors, []);
      const stub = (
        await db.execute<{ id: string; factors: Record<string, string> }>(
          sql`
        select id, factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `,
          "objects",
        )
      )[0]!;
      assert.equal(cmp(stub.factors.WCB_EARN ?? "0", "1200"), 0);
      assert.equal(cmp(stub.factors.WCB ?? "0", "24"), 0);
      const wcbLines = await db.execute<{ amount: string; project_id: string | null }>(
        sql`
        select amount, project_id from pay_stub_lines
         where org_id = ${org.orgId} and stub_id = ${stub.id} and description = 'WCB/WSIB'
         order by project_id nulls last`,
        "objects",
      );
      assert.equal(wcbLines.length, 2, "tagged split plus the untagged remainder");
      assert.equal(wcbLines[0]!.project_id, harness.jobA);
      assert.equal(cmp(wcbLines[0]!.amount, "12"), 0);
      assert.equal(wcbLines[1]!.project_id, null);
      assert.equal(cmp(wcbLines[1]!.amount, "12"), 0);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "employer levies: a negative WCB remainder folds into the last project split",
  { skip: !DB },
  async () => {
    // Three tagged splits each round up a fraction of a cent, so the
    // allocated total exceeds the premium by $0.01; the negative remainder
    // must fold into the LAST split only.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const harness = await seedWcbHarness(org.orgId, actorId, org.subsidiaryId, "100");
      await harness.postHours("2026-07-06", "3.3333", harness.jobA);
      await harness.postHours("2026-07-08", "3.3333", harness.jobB);
      await harness.postHours("2026-07-10", "3.3334", harness.jobC);
      await harness.postHours("2026-07-14", "0.0001", null);
      const run = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: harness.scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      assert.deepEqual(result.errors, []);
      const stub = (
        await db.execute<{ id: string; factors: Record<string, string> }>(
          sql`
        select id, factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `,
          "objects",
        )
      )[0]!;
      assert.equal(cmp(stub.factors.WCB_EARN ?? "0", "1000.01"), 0);
      assert.equal(cmp(stub.factors.WCB ?? "0", "20"), 0);
      const wcbLines = await db.execute<{ amount: string; project_id: string | null }>(
        sql`
        select amount, project_id from pay_stub_lines
         where org_id = ${org.orgId} and stub_id = ${stub.id} and description = 'WCB/WSIB'`,
        "objects",
      );
      const byProject = new Map(wcbLines.map((l) => [l.project_id, l.amount] as const));
      assert.equal(cmp(byProject.get(harness.jobA) ?? "?", "6.67"), 0);
      assert.equal(cmp(byProject.get(harness.jobB) ?? "?", "6.67"), 0);
      assert.equal(
        cmp(byProject.get(harness.jobC) ?? "?", "6.66"),
        0,
        "the negative penny folds into the last split",
      );
      assert.equal(sum(wcbLines.map((l) => l.amount)), "20.0000");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "employer levies: retained zero bases admit the next period without zero premium lines",
  { skip: !DB },
  async () => {
    // A committed zero-money period must remain readable statutory history.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const harness = await seedWcbHarness(org.orgId, actorId, org.subsidiaryId, "30", "1000");
      const ehtPayable = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                              reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${ehtPayable}, ${org.orgId}, '2340', 'EHT payable', 'liability_current', false, true,
                false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);

      const run = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: harness.scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      assert.deepEqual(result.errors, []);
      const stubs = await db.execute<{ factors: Record<string, string> }>(
        sql`
        select factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `,
        "objects",
      );
      assert.equal(stubs.length, 1);
      for (const key of ["WCB", "EHT", "HSF", "CNT"]) {
        assert.ok(!(key in stubs[0]!.factors), `no ${key} factor on zero earnings`);
      }
      for (const key of ["WCB_EARN", "EHT_EARN", "HSF_EARN", "CNT_EARN"]) {
        assert.equal(cmp(stubs[0]!.factors[key]!, "0"), 0, `${key} retains an assessed zero`);
      }
      const zeroPremiums = await db.execute(
        sql`
        select l.id from pay_stub_lines l
        join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
        join pay_components c on c.org_id=l.org_id and c.id=l.component_id
        where l.org_id=${org.orgId} and s.pay_run_document_id=${run.documentId}
          and c.system_key in ('wcb','eht','hsf','cnt')
      `,
        "objects",
      );
      assert.deepEqual(zeroPremiums, [], "retaining a basis does not create a zero levy line");
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      await harness.postHours("2026-07-20", "40", null);
      const next = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: harness.scheduleId,
        periodStart: "2026-07-19",
        periodEnd: "2026-08-01",
      });
      const nextResult = await calculatePayRun({
        orgId: org.orgId,
        documentId: next.documentId,
        actorId,
      });
      assert.deepEqual(
        nextResult.errors,
        [],
        "explicit zero history satisfies the native history guard",
      );
      const nextFactors = (
        await db.execute<{ factors: Record<string, string> }>(
          sql`
        select factors from pay_stubs where org_id=${org.orgId} and pay_run_document_id=${next.documentId}
      `,
          "objects",
        )
      )[0]!.factors;
      assert.equal(nextFactors.WCB_EARN, "1200.0000");
      assert.equal(nextFactors.WCB, "24.0000");
      assert.equal(nextFactors.EHT_EARN, "1200.0000");
      assert.equal(
        nextFactors.EHT,
        "3.9000",
        "the zero period consumes none of the 1000 exemption",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "an ON stub over the first CPP ceiling keeps the CPP2 line in canonical order",
  { skip: !DB },
  async () => {
    // A $74,000 pensionable carry-in puts this $1,200 period over the 2026
    // YMPE, so a CPP2 line posts at sequence 130 between CPP and EI with the
    // T4127 amount.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const harness = await seedWcbHarness(org.orgId, actorId, org.subsidiaryId, "30");
      await saveOpeningBalances({
        orgId: org.orgId,
        actorId,
        taxYear: 2026,
        rows: [
          {
            employeePartyId: harness.employeeId,
            amounts: { pensionableYtd: "74000", insurableYtd: "0" },
          },
        ],
      });
      await qualifyCanadianOpeningForTest({
        orgId: org.orgId,
        actorId,
        subsidiaryId: org.subsidiaryId,
        employeePartyId: harness.employeeId,
        taxYear: 2026,
        filingAccountId: harness.filingAccountId,
        province: "ON",
        coverageStart: "2026-01-01",
        coverageEnd: "2026-06-30",
        amounts: { pensionableYtd: "74000", insurableYtd: "0" },
        reportableBases: { cpp: "74000", ei: "0", qpip: "0" },
        levyAllocations: [
          ...["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"].map(
            (region) => ({ programKey: "ca_wcb", region, federalAccountId: null, amount: "0" }),
          ),
          ...["BC", "MB", "NL", "ON"].map((region) => ({
            programKey: "ca_eht",
            region,
            federalAccountId: null,
            amount: region === "ON" ? "0" : "0",
          })),
          { programKey: "ca_cnt", region: "QC", federalAccountId: null, amount: "0" },
        ],
      });
      await harness.postHours("2026-07-06", "20", harness.jobA);
      await harness.postHours("2026-07-08", "20", harness.jobA);
      const run = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: harness.scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      assert.deepEqual(result.errors, []);
      const stub = (
        await db.execute<{ id: string }>(
          sql`
        select id from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `,
          "objects",
        )
      )[0]!;
      const lines = await db.execute<{
        system_key: string | null;
        kind: string;
        description: string;
        amount: string;
        sequence: number;
      }>(
        sql`
        select c.system_key, l.kind, l.description, l.amount, l.sequence
          from pay_stub_lines l
          join pay_components c on c.id = l.component_id
         where l.org_id = ${org.orgId} and l.stub_id = ${stub.id} and l.sequence >= 100
         order by l.sequence`,
        "objects",
      );
      assert.deepEqual(
        lines.map((row) => [row.sequence, row.system_key, row.kind]),
        [
          [110, "income_tax", "deduction"],
          [120, "cpp", "deduction"],
          [130, "cpp2", "deduction"],
          [140, "ei", "deduction"],
          [210, "cpp", "employer_contribution"],
          [215, "cpp2", "employer_contribution"],
          [220, "ei", "employer_contribution"],
          [260, "wcb", "employer_contribution"],
        ],
      );
      const expected = calculateT4127(
        assessedCanadianWages({
          payDate: "2026-07-21",
          province: "ON",
          periodsPerYear: 26,
          income: "1200.00",
          federalClaimCode: 1,
          ytd: { pensionable: "74000.00" },
        }),
      );
      const cpp2 = lines.find((row) => row.system_key === "cpp2");
      assert.ok(cpp2 && cmp(cpp2.amount, "0") > 0, "second-tier CPP posts a positive line");
      assert.equal(cpp2!.amount, expected.cpp2);
      assert.equal(cpp2!.description, "CPP2");
      const cpp2Employer = lines.find((row) => row.sequence === 215);
      assert.ok(
        cpp2Employer && cmp(cpp2Employer.amount, "0") > 0,
        "employer second-tier CPP posts as its own line",
      );
      assert.equal(cpp2Employer!.system_key, "cpp2");
      assert.equal(cpp2Employer!.amount, expected.cpp2);
      assert.equal(cpp2Employer!.description, "CPP2 (employer)");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "employer levies: an uncommitted draft consumes no per-employee WCB cap",
  { skip: !DB },
  async () => {
    // The CPP/EI doctrine (proven in payroll-controls.test.ts) is that
    // calculated runs are drafts that may be abandoned, so only committed
    // stubs consume annual room. The WCB accumulator read
    // calculated-OR-committed stubs instead: calculate run 1 as a draft, and
    // run 2's premium is computed against money nobody has been paid — and
    // recalculating run 1 afterwards moves its own premium, because each
    // draft sees the other's. Recalculating an uncommitted run must be safe.
    //
    // The per-employee cap is what makes committed-only safe here: any race
    // that consumes this employee's room shares the employee, so the ytd
    // staleness arm forces a recalculation before the second commit. The
    // employer-level EHT exemption deliberately keeps seeing drafts (its
    // consumers share no employee for that arm to fire on) — pinned by the D6
    // test in payroll-multi-employee.integration.test.ts, not changed here.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const account = async (number: string, name: string, type: string) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                                reconcilable, required_dimensions, custom, subsidiary_include_children)
          values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
                  '[]'::jsonb, '{}'::jsonb, true)`);
        return id;
      };
      const wageExpense = await account("6000", "Wages expense", "expense");
      const burdenExpense = await account("6010", "Payroll burden", "expense");
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      const wcbPayable = await account("2330", "WSIB payable", "liability_current");
      await seedPayrollAccountingConfiguration(org.orgId, {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        slotAccounts: {
          CA: { cpp: craPayable, ei: craPayable, qpip: craPayable, income_tax: craPayable },
        },
      });

      await seedPayrollComponents(org.orgId, actorId, "CA");
      await seedOntarioEhtFixture(org.orgId, actorId);
      await setPackSlotAccount(org.orgId, actorId, "CA", "wcb", wcbPayable);

      const wcbGroupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, max_assessable, is_active)
        values (${wcbGroupId}, ${org.orgId}, 'CLASS-A', 'Construction class A', '2', '2000', true)`);

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Dana Draft', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into employee_roles (id, org_id, party_id, worker_comp_group_id)
        values (${randomUUID()}, ${org.orgId}, ${employeeId}, ${wcbGroupId})`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                               country, province, pay_basis, federal_claim_code,
                                               provincial_claim_code, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
                true, ${actorId}, ${actorId})`);
      await seedVacationTerms(org.orgId, employmentId, actorId, "0", "accrue");
      const jobA = randomUUID();
      await db.execute(sql`
        insert into projects (id, org_id, name, code, is_active, custom)
        values (${jobA}, ${org.orgId}, 'Job A', 'Job A', true, '{}'::jsonb)`);
      const hours = async (workedOn: string, amount: number) => {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, status,
                                    is_billable, billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${workedOn}, ${amount}, ${jobA}, 'approved', false,
                  'unbilled', 'actual', ${actorId}, ${actorId})`);
      };
      // Run 1: $2,400 gross — calculated and LEFT as a draft, never committed.
      await hours("2026-07-06", 40);
      await hours("2026-07-08", 40);
      const run1 = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
      });
      const calc1 = await calculatePayRun({
        orgId: org.orgId,
        documentId: run1.documentId,
        actorId,
      });
      assert.deepEqual(calc1.errors, []);
      const stub1 = (
        await db.execute<{ factors: Record<string, string> }>(
          sql`
        select factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run1.documentId}
      `,
          "objects",
        )
      )[0]!;
      assert.equal(stub1.factors.WCB_EARN, "2000.0000");

      // Run 2: $600 gross in the next period. Nothing is committed, so the
      // whole $2,000 of cap room is still available to it.
      await hours("2026-07-22", 20);
      const run2 = await createPayRun({ orgId: org.orgId, actorId, payScheduleId: scheduleId });
      const calc2 = await calculatePayRun({
        orgId: org.orgId,
        documentId: run2.documentId,
        actorId,
      });
      assert.deepEqual(calc2.errors, []);
      const stub2 = (
        await db.execute<{ factors: Record<string, string> }>(
          sql`
        select factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run2.documentId}
      `,
          "objects",
        )
      )[0]!;
      assert.equal(
        stub2.factors.WCB_EARN,
        "600.0000",
        "a draft run's assessable earnings must not consume the WCB cap",
      );
      assert.equal(stub2.factors.WCB, "12.0000");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
