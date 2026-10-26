import { seedCanadianPostingAccounts } from "../testing/payroll-posting-fixture.ts";
import {
  seedPayrollSchedule,
  seedPayrollEmployeeRole,
  seedPayrollPerson,
  seedPayrollProfile,
  seedPayrollWage,
  seedPayrollDocument,
  seedPayrollStub,
  seedPayrollLine,
  seedPayrollComponent,
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  seedWorkerEmployment,
} from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withBypassContext, withOrgContext } from "../platform/db.ts";
import pg from "pg";
import { rl1Slips } from "./canada/quebec/rl1.ts";
import { setPackSlotAccount } from "./packs.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedCanadianPayrollComponentsForTest as seedPayrollComponents } from "./filing-test-fixtures.ts";
import { t4Slips, w2Slips, form941Worksheet } from "./yearend.ts";
import { seedAdoption as seedRetainedHistory, seedUsEinAccount } from "./filing-test-fixtures.ts";
import { validateUsFilingAccountLineage } from "./us/filing-account-lineage.ts";
import { upsertPayrollEmployerFact } from "./employer-fact-store.ts";
interface AdoptionFixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  scheduleId: string;
  employeeId: string;
  employeeName: string;
}

async function seedEmployee(
  fx: { orgId: string; actorId: string; scheduleId: string; subsidiaryId: string },
  options: { name: string; hiredOn?: string } = { name: "Terry Worker" },
): Promise<string> {
  const employeeId = randomUUID();
  await seedPayrollPerson(fx.orgId, employeeId, options.name);
  await seedPayrollEmployeeRole(fx.orgId, employeeId, {
    hiredOn: options.hiredOn ?? "2020-01-06",
    isActive: true,
    createdBy: fx.actorId,
    updatedBy: fx.actorId,
  });
  await seedPayrollWage(fx.orgId, employeeId, fx.actorId, {
    currency: "CAD",
    rate: "30",
    basis: "hour",
    effectiveFrom: "2020-01-01",
  });
  // Stub calculation refuses employees without an HRM employment (NOT NULL since 0374), so the hire carries one.
  await seedPayrollProfile(
    fx.orgId,
    employeeId,
    await seedWorkerEmployment(fx.orgId, employeeId, fx.subsidiaryId),
    fx.scheduleId,
    fx.actorId,
    {
      province: "ON",
      payBasis: "hourly",
      country: "CA",
      federalClaimCode: 1,
      provincialClaimCode: 1,
      wcbExempt: true,
      wcbExemptReason: "historical fixture: workers-compensation coverage out of scope",
    },
    { percentFloor: "4", method: "accrue" },
  );

  return employeeId;
}

/** A Canadian org with payroll accounts, components, a schedule and one hire. */
async function seedAdoption(options: { hiredOn?: string } = {}): Promise<AdoptionFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;

  const { craPayable } = await seedCanadianPostingAccounts(org.orgId, {
    liabilityType: "liability_current_other",
    enablePayroll: false,
  });
  await seedPayrollComponents(org.orgId, actorId);
  // Québec legs need their classifications (HSF sector, CNT exemption class,
  // CNT liability slot): an unclassified Québec employer refuses by name.
  await db.execute(sql`
    insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                         rate_values, created_by, updated_by)
    values (${org.orgId}, 'CA', 'ca_hsf', 'QC', 2026, '{"sectorOther": "true"}',
            ${actorId}, ${actorId})`);
  await upsertPayrollEmployerFact({
    orgId: org.orgId,
    actorId,
    subsidiaryId: org.subsidiaryId,
    country: "CA",
    factKey: "cnt_exemption",
    effectiveFrom: "2026-01-01",
    value: "none",
    changeReason: "test employer subject to CNT",
  });
  await setPackSlotAccount(org.orgId, actorId, "CA", "cnt", craPayable);
  await db.execute(sql`
    update pay_components set liability_account_id = ${craPayable}
     where org_id = ${org.orgId} and system_key = 'hsf'`);

  const scheduleId = randomUUID();
  await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
    name: "Biweekly",
    frequency: "biweekly",
    periodsPerYear: 26,
    anchorPeriodEnd: "2026-07-18",
    payDateOffsetDays: 3,
  });

  const employeeName = "Terry Worker";
  const employeeId = await seedEmployee(
    { orgId: org.orgId, actorId, scheduleId, subsidiaryId: org.subsidiaryId },
    { name: employeeName, hiredOn: options.hiredOn },
  );

  return {
    orgId: org.orgId,
    actorId,
    subsidiaryId: org.subsidiaryId,
    scheduleId,
    employeeId,
    employeeName,
  };
}

async function calculatedRun(fx: AdoptionFixture) {
  const entry = (
    await db.execute<{ id: string }>(
      sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
      is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${fx.orgId}, ${fx.employeeId}, '2026-07-14', 8, 'approved', false,
      'unbilled', 'actual', ${fx.actorId}, ${fx.actorId}) returning id
  `,
      "objects",
    )
  )[0]!;
  const run = await createPayRun({
    orgId: fx.orgId,
    actorId: fx.actorId,
    payScheduleId: fx.scheduleId,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
  });
  const input = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
  assert.deepEqual((await calculatePayRun(input)).errors, []);
  return { input, entryId: entry.id };
}

function historicalPolicyError(error: unknown) {
  const e = error as { constraint?: string; cause?: { constraint?: string } };
  assert.equal(e.cause?.constraint ?? e.constraint, "pay_component_historical_policy");
  return true;
}

for (const operation of ["edit", "delete"] as const) {
  test(
    `committed payroll taxable income is stable after a component ${operation}`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const fx = await seedAdoption();
      try {
        const { input } = await calculatedRun(fx);
        await commitPayRun(input);
        const before = await t4Slips(fx.orgId, 2026);
        assert.equal(before[0]?.box14EmploymentIncome, "240.0000");
        await assert.rejects(
          db.execute(
            operation === "edit"
              ? sql`update pay_components set taxable = false, updated_at = now()
              where org_id = ${fx.orgId} and system_key = 'base_pay'`
              : sql`delete from pay_components where org_id = ${fx.orgId} and system_key = 'base_pay'`,
          ),
          historicalPolicyError,
        );
        assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}

test(
  "historical report classification is fixed while snapshotted calculation inputs remain editable",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      const before = await t4Slips(fx.orgId, 2026);
      for (const [column, value] of Object.entries({
        taxable: false,
        tax_treatment: "union_dues",
        country: "US",
        system_key: "renamed_base",
        kind: "deduction",
      })) {
        await assert.rejects(
          db.execute(sql`update pay_components
          set ${sql.identifier(column)} = ${value}
          where org_id = ${fx.orgId} and system_key = 'base_pay'`),
          historicalPolicyError,
        );
      }
      await db.execute(sql`update pay_components set name = 'Renamed earning', value = '50',
        is_active = false, pensionable = false, insurable = false, non_periodic = true
        where org_id = ${fx.orgId} and system_key = 'base_pay'`);
      assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
      // A new identity can carry changed treatment for future assignments.
      const next = (
        await db.execute<{ id: string }>(
          sql`insert into pay_components
        (org_id, code, name, kind, taxable) values (${fx.orgId}, 'FUTURE', 'Future earning', 'earning', false)
        returning id`,
          "objects",
        )
      )[0]!;
      await db.execute(
        sql`update pay_components set taxable = true where org_id = ${fx.orgId} and id = ${next.id}`,
      );
      await db.execute(
        sql`delete from pay_components where org_id = ${fx.orgId} and id = ${next.id}`,
      );
      assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "voided payroll retains component classification and reference evidence",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      await db.execute(sql`update pay_runs set run_status = 'voided'
        where org_id = ${fx.orgId} and document_id = ${input.documentId}`);
      await assert.rejects(
        db.execute(sql`update pay_components set taxable = false
        where org_id = ${fx.orgId} and system_key = 'base_pay'`),
        historicalPolicyError,
      );
      await assert.rejects(
        db.execute(sql`delete from pay_components
        where org_id = ${fx.orgId} and system_key = 'base_pay'`),
        historicalPolicyError,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/**
 * Race scaffolding runs on raw pg clients that skip the pool's RLS-GUC
 * wrapper, so under the constrained runtime role their locking reads see
 * zero rows and the lock barrier never forms. Explicit session bypass
 * restores full visibility on these throwaway connections (closed at test
 * end); the fencing assertions run through the product path unchanged.
 */
async function scopeRaceClient(client: pg.Client, orgId: string): Promise<void> {
  await client.query(
    "select set_config('app.current_org', $1, false), set_config('app.bypass_rls', 'on', false)",
    [orgId],
  );
}

async function waitForBlock(client: pg.Client, blockerPid: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await client.query("select pg_stat_clear_snapshot()");
    const row = (
      await client.query<{ blocked: boolean }>(
        "select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as blocked",
        [blockerPid],
      )
    ).rows[0]!;
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("expected the competing writer to reach the row lock");
}

for (const operation of ["edit", "delete"] as const) {
  test(
    `payroll commit fences a component ${operation} until history exists`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const fx = await seedAdoption();
      const holder = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
      const editor = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
      await holder.connect();
      await editor.connect();
      await scopeRaceClient(holder, fx.orgId);
      await scopeRaceClient(editor, fx.orgId);
      let committing: Promise<unknown> | undefined;
      let editing: Promise<unknown> | undefined;
      try {
        const { input, entryId } = await calculatedRun(fx);
        await holder.query("begin");
        await holder.query("select id from time_entries where org_id=$1 and id=$2 for update", [
          fx.orgId,
          entryId,
        ]);
        const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
          .rows[0]!.pid;
        committing = commitPayRun(input);
        void committing.catch(() => {});
        await waitForBlock(holder, holderPid);
        const commitPid = (
          await holder.query<{ pid: number }>(
            "select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))",
            [holderPid],
          )
        ).rows[0]!.pid;
        editing = editor.query(
          operation === "edit"
            ? "update pay_components set taxable=false where org_id=$1 and system_key='base_pay'"
            : "delete from pay_components where org_id=$1 and system_key='base_pay'",
          [fx.orgId],
        );
        void editing.catch(() => {});
        await waitForBlock(holder, commitPid);
        await holder.query("commit");
        await committing;
        await assert.rejects(editing, historicalPolicyError);
        assert.equal((await t4Slips(fx.orgId, 2026))[0]?.box14EmploymentIncome, "240.0000");
      } finally {
        await holder.query("rollback").catch(() => {});
        await committing?.catch(() => {});
        await editing?.catch(() => {});
        await holder.end();
        await editor.end();
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}

test(
  "a raw component policy edit invalidates an already calculated run",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await db.execute(sql`update pay_components set taxable=false
        where org_id=${fx.orgId} and system_key='base_pay'`);
      await assert.rejects(commitPayRun(input), /recalculate|changed|stale/i);
      assert.equal(
        (
          await db.execute(
            sql`select run_status from pay_runs
        where org_id=${fx.orgId} and document_id=${input.documentId}`,
            "objects",
          )
        )[0]?.run_status,
        "calculated",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "commit waits for an earlier component editor and then refuses its stale calculation",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    const editor = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    await editor.connect();
    await scopeRaceClient(editor, fx.orgId);
    let committing: Promise<unknown> | undefined;
    try {
      const { input } = await calculatedRun(fx);
      await editor.query("begin");
      await editor.query(
        "update pay_components set taxable=false where org_id=$1 and system_key='base_pay'",
        [fx.orgId],
      );
      const pid = (await editor.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!
        .pid;
      committing = commitPayRun(input);
      void committing.catch(() => {});
      await waitForBlock(editor, pid);
      await editor.query("commit");
      await assert.rejects(committing, /recalculate|changed|stale/i);
      assert.equal(
        (
          await db.execute(
            sql`select run_status from pay_runs
        where org_id=${fx.orgId} and document_id=${input.documentId}`,
            "objects",
          )
        )[0]?.run_status,
        "calculated",
      );
    } finally {
      await editor.query("rollback").catch(() => {});
      await committing?.catch(() => {});
      await editor.end();
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

for (const change of ["relocate", "delete-profile"] as const) {
  test(
    `committed payroll country survives employee profile ${change}`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const fx = await seedAdoption();
      try {
        const { input } = await calculatedRun(fx);
        await commitPayRun(input);
        const before = await t4Slips(fx.orgId, 2026);
        assert.equal(before[0]?.box14EmploymentIncome, "240.0000");
        if (change === "relocate") {
          await db.execute(sql`update employee_payroll_profiles set country='US',province='TX'
            where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
        } else {
          await db.execute(sql`delete from employee_payroll_profiles
            where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
        }
        assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
        assert.deepEqual(
          await w2Slips(fx.orgId, 2026),
          [],
          "a Canadian stub cannot become US wages",
        );
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}

test(
  "country snapshots capture calculation provenance and cannot be overwritten",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      const stub = (
        await db.execute(
          sql`select id,country,country_source from pay_stubs
        where org_id=${fx.orgId} and pay_run_document_id=${input.documentId}`,
          "objects",
        )
      )[0]!;
      assert.equal(stub.country, "CA");
      assert.equal(stub.country_source, "calculation");
      for (const phase of ["calculated", "committed"]) {
        if (phase === "committed") await commitPayRun(input);
        await assert.rejects(
          db.execute(sql`update pay_stubs set country='US'
          where org_id=${fx.orgId} and id=${stub.id}`),
          (error: unknown) => {
            assert.equal(
              (error as { cause?: { constraint?: string } }).cause?.constraint,
              "pay_stub_historical_country",
            );
            return true;
          },
        );
      }
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "payroll country has no region-inference function",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    assert.equal(
      (
        await db.execute(
          sql`select to_regprocedure('public.payroll_legacy_region_country(text)')::text as signature`,
          "objects",
        )
      )[0]?.signature,
      null,
    );
  },
);

for (const province of ["ON", "UNKNOWN"]) {
  test(
    `a ${province} region cannot supply missing payroll country evidence`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const fx = await seedAdoption();
      try {
        const { input } = await calculatedRun(fx);
        const saved = (
          await db.execute<{ row: Record<string, unknown> }>(
            sql`select to_jsonb(s) as row from pay_stubs s
          where org_id=${fx.orgId} and pay_run_document_id=${input.documentId}`,
            "objects",
          )
        )[0]!.row;
        await db.execute(sql`delete from pay_stubs where org_id=${fx.orgId} and id=${saved.id}`);
        const replacement = { ...saved, province, country: null, country_source: "unknown" };
        await db.execute(
          sql`insert into pay_stubs select (jsonb_populate_record(null::pay_stubs,${JSON.stringify(replacement)}::jsonb)).*`,
        );
        const row = (
          await db.execute(
            sql`select country,country_source from pay_stubs where org_id=${fx.orgId} and id=${saved.id}`,
            "objects",
          )
        )[0]!;
        assert.deepEqual(row, { country: null, country_source: "unknown" });
        await db.execute(
          sql`update pay_runs set run_status='committed' where org_id=${fx.orgId} and document_id=${input.documentId}`,
        );
        for (const read of [t4Slips, w2Slips, form941Worksheet, rl1Slips]) {
          await assert.rejects(read(fx.orgId, 2026), /unknown historical country/);
        }
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}

test(
  "regional Canadian year-end slips survive a later country change",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      await db.execute(sql`update employee_payroll_profiles set province='QC'
        where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      const before = await rl1Slips(fx.orgId, 2026);
      assert.equal(before.length, 1);
      await db.execute(sql`update employee_payroll_profiles set country='US',province='TX'
        where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
      assert.deepEqual(await rl1Slips(fx.orgId, 2026), before);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a dated vacation-base policy edit invalidates an already calculated run",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await db.execute(sql`update pay_component_statutory_treatments treatment set vacationable=false
        from pay_components component where treatment.org_id=${fx.orgId} and treatment.pay_component_id=component.id
          and component.org_id=treatment.org_id and component.system_key='base_pay'`);
      await assert.rejects(commitPayRun(input), /recalculate|changed|stale/i);
      assert.equal(
        (
          await db.execute(
            sql`select run_status from pay_runs
        where org_id=${fx.orgId} and document_id=${input.documentId}`,
            "objects",
          )
        )[0]?.run_status,
        "calculated",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "W-2 and Form 941 retain original employer and date across a real party transfer and dated state-registration succession",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await withBypassContext(() => seedRetainedHistory());
    try {
      await withOrgContext(f.orgId, async () => {
        assert.equal(
          (
            await db.execute(
              sql`update subsidiaries set country='US',base_currency='USD'
        where org_id=${f.orgId} and id=${f.subsidiaryId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const employerB = randomUUID(),
          state = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${employerB},${f.orgId},${f.subsidiaryId},'Successor US legal employer','USD','US') returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const employmentB = await seedWorkerEmployment(f.orgId, f.employeeId, employerB);
        const einA = await seedUsEinAccount(f.orgId, f.actorId, f.subsidiaryId, "12-3456789");
        const einB = await seedUsEinAccount(f.orgId, f.actorId, employerB, "98-7654321");
        // The organization-owned registration has two attested, nonoverlapping employer periods.
        assert.equal(
          (
            await db.execute(
              sql`insert into payroll_filing_accounts
        (id,org_id,country,program_type,account_number,name,subsidiary_id,state_code,is_active,created_by,updated_by)
        values(${state},${f.orgId},'US','us_state_sui','NJ-ORIGINAL','Retained state registration',null,'NJ',true,${f.actorId},${f.actorId}) returning id`,
              "objects",
            )
          ).length,
          1,
        );
        for (const interval of [
          {
            subsidiaryId: f.subsidiaryId,
            federalAccountId: einA,
            effectiveFrom: "2026-01-01",
            effectiveTo: "2026-06-14",
          },
          {
            subsidiaryId: employerB,
            federalAccountId: einB,
            effectiveFrom: "2026-06-15",
            effectiveTo: null,
          },
        ]) {
          const input = {
            filingAccountId: state,
            ...interval,
            sourceReference: "Original registration transfer effective on 15 June 2026",
            changeReason: "Retain the source-confirmed payer for each inclusive payroll date",
          };
          await db.transaction(async (tx) => {
            await validateUsFilingAccountLineage(tx, f.orgId, input);
            assert.equal(
              (
                await tx.execute(
                  sql`insert into payroll_us_filing_account_employer_lineage
            (org_id,filing_account_id,federal_account_id,subsidiary_id,effective_from,effective_to,source_reference,change_reason,created_by,updated_by)
            values(${f.orgId},${state},${input.federalAccountId},${input.subsidiaryId},${input.effectiveFrom},${input.effectiveTo},
              ${input.sourceReference},${input.changeReason},${f.actorId},${f.actorId}) returning id`,
                  "objects",
                )
              ).length,
              1,
            );
          });
        }
        const components = new Map<string, string>();
        for (const component of [
          {
            code: "RETAINED_WAGE",
            systemKey: null,
            name: "Retained taxable wage",
            kind: "earning" as const,
            taxable: true,
          },
          ...["fit", "ss", "medicare", "state_income_tax", "local_income_tax"].map((systemKey) => ({
            code: `RETAINED_${systemKey.toUpperCase()}`,
            systemKey,
            name: systemKey,
            kind: "deduction" as const,
            taxable: false,
          })),
          {
            code: "RETAINED_SS_EMPLOYER",
            systemKey: "ss",
            name: "Retained employer Social Security",
            kind: "employer_contribution" as const,
            taxable: false,
          },
          {
            code: "RETAINED_MED_EMPLOYER",
            systemKey: "medicare",
            name: "Retained employer Medicare",
            kind: "employer_contribution" as const,
            taxable: false,
          },
          {
            code: "RETAINED_PLAN",
            systemKey: null,
            name: "Retained pension deferral",
            kind: "deduction" as const,
            taxable: false,
          },
        ]) {
          const id = randomUUID();
          await seedPayrollComponent(f.orgId, id, {
            ...component,
            country: "US",
            taxTreatment: component.code === "RETAINED_PLAN" ? "pension_f" : "none",
            pensionable: component.kind === "earning",
            insurable: component.kind === "earning",
            vacationable: false,
            createdBy: f.actorId,
            updatedBy: f.actorId,
          });
          components.set(
            component.kind === "employer_contribution"
              ? component.code
              : (component.systemKey ?? component.code),
            id,
          );
        }
        const sources = [
          {
            subsidiaryId: f.subsidiaryId,
            employmentId: f.employmentId,
            date: "2026-06-10",
            wage: "1000",
            deferral: "50",
            fit: "100",
            ss: "62",
            med: "14.50",
            stateTax: "35",
            local: "10",
            net: "728.50",
          },
          {
            subsidiaryId: employerB,
            employmentId: employmentB,
            date: "2026-06-20",
            wage: "2000",
            deferral: "100",
            fit: "200",
            ss: "124",
            med: "29",
            stateTax: "70",
            local: "20",
            net: "1457",
          },
        ];
        const retained: { stubId: string; documentId: string }[] = [];
        for (const source of sources) {
          assert.equal(
            (
              await db.execute(
                sql`update parties set subsidiary_id=${source.subsidiaryId}
          where org_id=${f.orgId} and id=${f.employeeId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
          assert.equal(
            (
              await db.execute(
                sql`update employee_payroll_profiles set country='US',province='NJ',
          employment_id=${source.employmentId},filing_account_id=${state}
          where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
                "objects",
              )
            ).length,
            1,
          );
          const documentId = randomUUID(),
            stubId = randomUUID();
          await seedPayrollDocument(f.orgId, documentId, {
            kind: "pay_run",
            documentNumber: `PAY-RETAINED-${source.date}`,
            subsidiaryId: source.subsidiaryId,
            documentDate: source.date,
            currency: "USD",
            status: "draft",
            createdBy: f.actorId,
            updatedBy: f.actorId,
          });
          assert.equal(
            (
              await db.execute(
                sql`insert into pay_runs
          (document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,created_by,updated_by)
          values(${documentId},${f.orgId},${f.scheduleId},${source.date},${source.date},${source.date},2026,'committed',${f.actorId},${f.actorId})
          returning document_id`,
                "objects",
              )
            ).length,
            1,
          );
          await seedPayrollStub(f.orgId, documentId, f.employeeId, source.employmentId, {
            id: stubId,
            country: "US",
            countrySource: "calculation",
            province: "NJ",
            filingAccountId: state,
            filingAccountSource: "insertion",
            periodsPerYear: 26,
            payDate: source.date,
            taxYear: 2026,
            currency: "USD",
            gross: source.wage,
            netPay: source.net,
            pensionableEarnings: source.wage,
            insurableEarnings: source.wage,
            factors: { SS_TAXABLE: source.wage, MED2_TAXABLE: "0", W2_LOCAL_WAGES_60: source.wage },
            createdBy: f.actorId,
            updatedBy: f.actorId,
          });
          const lines = [
            {
              component: "RETAINED_WAGE",
              kind: "earning" as const,
              amount: source.wage,
              sequence: 10,
            },
            { component: "fit", kind: "deduction" as const, amount: source.fit, sequence: 20 },
            { component: "ss", kind: "deduction" as const, amount: source.ss, sequence: 30 },
            {
              component: "RETAINED_SS_EMPLOYER",
              kind: "employer_contribution" as const,
              amount: source.ss,
              sequence: 31,
            },
            { component: "medicare", kind: "deduction" as const, amount: source.med, sequence: 40 },
            {
              component: "RETAINED_MED_EMPLOYER",
              kind: "employer_contribution" as const,
              amount: source.med,
              sequence: 41,
            },
            {
              component: "state_income_tax",
              kind: "deduction" as const,
              amount: source.stateTax,
              sequence: 50,
            },
            {
              component: "local_income_tax",
              kind: "deduction" as const,
              amount: source.local,
              sequence: 60,
            },
            {
              component: "RETAINED_PLAN",
              kind: "deduction" as const,
              amount: source.deferral,
              sequence: 70,
            },
          ];
          for (const line of lines) {
            const componentId = components.get(line.component);
            assert.ok(componentId);
            await seedPayrollLine(f.orgId, stubId, componentId, {
              kind: line.kind,
              amount: line.amount,
              description:
                line.component === "local_income_tax"
                  ? "Original municipal income tax"
                  : line.component,
              sequence: line.sequence,
              ...(line.component === "RETAINED_PLAN"
                ? {
                    statutoryReportingCode: {
                      formCode: "US_W2",
                      boxCode: "12",
                      code: "D",
                      label: "401(k) elective deferrals",
                    },
                  }
                : {}),
            });
          }
          retained.push({ stubId, documentId });
        }
        const beforeW2 = await w2Slips(f.orgId, 2026),
          before941 = await form941Worksheet(f.orgId, 2026);
        assert.equal(beforeW2.length, 2);
        assert.equal(before941.length, 2);
        for (const [ein, wages, fit, ssWages, ssTax, medTax, stateTax, localTax, deferral] of [
          [
            einA,
            "950.0000",
            "100.0000",
            "1000.0000",
            "62.0000",
            "14.5000",
            "35.0000",
            "10.0000",
            "50.0000",
          ],
          [
            einB,
            "1900.0000",
            "200.0000",
            "2000.0000",
            "124.0000",
            "29.0000",
            "70.0000",
            "20.0000",
            "100.0000",
          ],
        ]) {
          const slip = beforeW2.find((row) => row.filingAccountId === ein);
          assert.ok(slip);
          assert.equal(slip.box1Wages, wages);
          assert.equal(slip.box2FederalIncomeTax, fit);
          assert.equal(slip.box3SsWages, ssWages);
          assert.equal(slip.box4SsTax, ssTax);
          assert.equal(slip.box5MedicareWages, ssWages);
          assert.equal(slip.box6MedicareTax, medTax);
          assert.deepEqual(slip.box12Lines, [
            { boxCode: "12", code: "D", label: "401(k) elective deferrals", value: deferral },
          ]);
          assert.equal(slip.stateLines.length, 1);
          assert.equal(slip.stateLines[0]!.employerStateId, "NJ-ORIGINAL");
          assert.equal(slip.stateLines[0]!.box16StateWages, wages);
          assert.equal(slip.stateLines[0]!.box17StateIncomeTax, stateTax);
          assert.deepEqual(slip.stateLines[0]!.localLines, [
            {
              locality: "Original municipal income tax",
              box18LocalWages: ssWages,
              box19LocalIncomeTax: localTax,
            },
          ]);
          const quarter = before941.find((row) => row.filingAccountId === ein);
          assert.ok(quarter);
          assert.equal(quarter.quarter, 2);
          assert.equal(quarter.wages, slip.box1Wages);
          assert.equal(quarter.federalIncomeTax, slip.box2FederalIncomeTax);
          assert.equal(quarter.ssWages, slip.box3SsWages);
          assert.equal(quarter.medicareWages, slip.box5MedicareWages);
          assert.equal(quarter.ssTax, ein === einA ? "124.0000" : "248.0000");
          assert.equal(quarter.medicareTax, ein === einA ? "29.0000" : "58.0000");
        }
        assert.equal(
          (
            await db.execute(
              sql`update payroll_filing_accounts set is_active=false
        where org_id=${f.orgId} and id=${einA} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        // Move the actual party again after both original sources exist; neither reader may use today's map.
        assert.equal(
          (
            await db.execute(
              sql`update parties set subsidiary_id=${f.subsidiaryId}
        where org_id=${f.orgId} and id=${f.employeeId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set country='CA',province='ON',
        employment_id=${f.employmentId},filing_account_id=null
        where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.deepEqual(await w2Slips(f.orgId, 2026), beforeW2);
        assert.deepEqual(await form941Worksheet(f.orgId, 2026), before941);
        assert.deepEqual(await t4Slips(f.orgId, 2026), []);
        const retainedSources = await db.execute<{ id: string; employer: string; date: string }>(
          sql`
        select s.id,d.subsidiary_id as employer,s.pay_date::text as date from pay_stubs s
        join documents d on d.org_id=s.org_id and d.id=s.pay_run_document_id
        where s.org_id=${f.orgId} order by s.pay_date`,
          "objects",
        );
        assert.deepEqual(
          retainedSources,
          retained.map((row, index) => ({
            id: row.stubId,
            employer: sources[index]!.subsidiaryId,
            date: sources[index]!.date,
          })),
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
