import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env } from "./db.ts";
import pg from "pg";
import { rl1Slips } from "./payroll-rl1.ts";
import { PAYROLL_COUNTRY_PACKS } from "./payroll/packs.ts";
import { calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { t4Slips, w2Slips, form941Worksheet } from "./payroll-yearend.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";
interface AdoptionFixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  scheduleId: string;
  employeeId: string;
  employeeName: string;
}

async function seedEmployee(
  fx: { orgId: string; actorId: string; scheduleId: string },
  options: { name: string; hiredOn?: string } = { name: "Terry Worker" },
): Promise<string> {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${fx.orgId}, 'person', ${options.name}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${options.hiredOn ?? "2020-01-06"}, true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2020-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, country, federal_claim_code,
                                           provincial_claim_code, vacation_percent, vacation_method,
                                           is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${fx.scheduleId}, 'ON', 'hourly', 'CA', 1, 1,
            '4', 'accrue', true, ${fx.actorId}, ${fx.actorId})`);
  return employeeId;
}

/** A Canadian org with payroll accounts, components, a schedule and one hire. */
async function seedAdoption(options: { hiredOn?: string } = {}): Promise<AdoptionFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;

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
  const netPayable = await account("2300", "Wages payable", "liability_current_other");
  const craPayable = await account("2310", "CRA remittances payable", "liability_current_other");
  const vacationPayable = await account("2320", "Vacation payable", "liability_current_other");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        cppPayableAccountId: craPayable,
        eiPayableAccountId: craPayable,
        taxPayableAccountId: craPayable,
        vacationPayableAccountId: vacationPayable,
        wagesTo: "expense",
      },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "CA");

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);

  const employeeName = "Terry Worker";
  const employeeId = await seedEmployee(
    { orgId: org.orgId, actorId, scheduleId },
    { name: employeeName, hiredOn: options.hiredOn },
  );

  return {
    orgId: org.orgId, actorId, subsidiaryId: org.subsidiaryId, scheduleId, employeeId, employeeName,
  };
}

async function calculatedRun(fx: AdoptionFixture) {
  const entry = (await db.execute<{id: string}>(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
      is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${fx.orgId}, ${fx.employeeId}, '2026-07-14', 8, 'approved', false,
      'unbilled', 'actual', ${fx.actorId}, ${fx.actorId}) returning id
  `)).rows[0]!;
  const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId,
    payScheduleId: fx.scheduleId, periodStart: "2026-07-05", periodEnd: "2026-07-18" });
  const input = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
  assert.deepEqual((await calculatePayRun(input)).errors, []);
  return { input, entryId: entry.id };
}

function historicalPolicyError(error: unknown) {
  const e = error as {constraint?: string; cause?: {constraint?: string}};
  assert.equal(e.cause?.constraint ?? e.constraint, "pay_component_historical_policy");
  return true;
}

for (const operation of ["edit", "delete"] as const) {
  test(`committed payroll taxable income is stable after a component ${operation}`,
    { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const fx = await seedAdoption();
      try {
        const {input} = await calculatedRun(fx);
        await commitPayRun(input);
        const before = await t4Slips(fx.orgId, 2026);
        assert.equal(before[0]?.box14EmploymentIncome, "240.0000");
        await assert.rejects(db.execute(operation === "edit"
          ? sql`update pay_components set taxable = false, updated_at = now()
              where org_id = ${fx.orgId} and system_key = 'base_pay'`
          : sql`delete from pay_components where org_id = ${fx.orgId} and system_key = 'base_pay'`),
        historicalPolicyError);
        assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
      } finally { await dropScratchOrgReporting(fx.orgId); }
    });
}

test("historical report classification is fixed while snapshotted calculation inputs remain editable",
  { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    try {
      const {input} = await calculatedRun(fx);
      await commitPayRun(input);
      const before = await t4Slips(fx.orgId, 2026);
      for (const [column, value] of Object.entries({
        taxable: false, tax_treatment: "union_dues", country: "US", system_key: "renamed_base",
        kind: "deduction",
      })) {
        await assert.rejects(db.execute(sql`update pay_components
          set ${sql.identifier(column)} = ${value}
          where org_id = ${fx.orgId} and system_key = 'base_pay'`), historicalPolicyError);
      }
      await db.execute(sql`update pay_components set name = 'Renamed earning', value = '50',
        is_active = false, pensionable = false, insurable = false, vacationable = false, non_periodic = true
        where org_id = ${fx.orgId} and system_key = 'base_pay'`);
      assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
      // A new identity can carry changed treatment for future assignments.
      const next = (await db.execute<{id: string}>(sql`insert into pay_components
        (org_id, code, name, kind, taxable) values (${fx.orgId}, 'FUTURE', 'Future earning', 'earning', false)
        returning id`)).rows[0]!;
      await db.execute(sql`update pay_components set taxable = true where org_id = ${fx.orgId} and id = ${next.id}`);
      await db.execute(sql`delete from pay_components where org_id = ${fx.orgId} and id = ${next.id}`);
      assert.deepEqual(await t4Slips(fx.orgId, 2026), before);
    } finally { await dropScratchOrgReporting(fx.orgId); }
  });

test("voided payroll retains component classification and reference evidence",
  { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    try {
      const {input} = await calculatedRun(fx); await commitPayRun(input);
      await db.execute(sql`update pay_runs set run_status = 'voided'
        where org_id = ${fx.orgId} and document_id = ${input.documentId}`);
      await assert.rejects(db.execute(sql`update pay_components set taxable = false
        where org_id = ${fx.orgId} and system_key = 'base_pay'`), historicalPolicyError);
      await assert.rejects(db.execute(sql`delete from pay_components
        where org_id = ${fx.orgId} and system_key = 'base_pay'`), historicalPolicyError);
    } finally { await dropScratchOrgReporting(fx.orgId); }
  });

async function waitForBlock(client: pg.Client, blockerPid: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await client.query("select pg_stat_clear_snapshot()");
    const row = (await client.query<{blocked: boolean}>(
      "select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as blocked",
      [blockerPid])).rows[0]!;
    if (row.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("expected the competing writer to reach the row lock");
}

for (const operation of ["edit", "delete"] as const) {
  test(`payroll commit fences a component ${operation} until history exists`,
    { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const fx = await seedAdoption();
      const holder = new pg.Client({connectionString: env.OPENBOOKS_DB_URL});
      const editor = new pg.Client({connectionString: env.OPENBOOKS_DB_URL});
      let committing: Promise<unknown> | undefined;
      let editing: Promise<unknown> | undefined;
      try {
        const {input, entryId} = await calculatedRun(fx);
        await holder.connect(); await editor.connect();
        await holder.query("begin");
        await holder.query("select id from time_entries where org_id=$1 and id=$2 for update", [fx.orgId, entryId]);
        const holderPid = (await holder.query<{pid: number}>("select pg_backend_pid() as pid")).rows[0]!.pid;
        committing = commitPayRun(input); void committing.catch(() => {});
        await waitForBlock(holder, holderPid);
        const commitPid = (await holder.query<{pid: number}>(
          "select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))", [holderPid])).rows[0]!.pid;
        editing = editor.query(operation === "edit"
          ? "update pay_components set taxable=false where org_id=$1 and system_key='base_pay'"
          : "delete from pay_components where org_id=$1 and system_key='base_pay'", [fx.orgId]);
        void editing.catch(() => {});
        await waitForBlock(holder, commitPid);
        await holder.query("commit"); await committing;
        await assert.rejects(editing, historicalPolicyError);
        assert.equal((await t4Slips(fx.orgId, 2026))[0]?.box14EmploymentIncome, "240.0000");
      } finally {
        await holder.query("rollback").catch(() => {});
        await committing?.catch(() => {}); await editing?.catch(() => {});
        await holder.end(); await editor.end(); await dropScratchOrgReporting(fx.orgId);
      }
    });
}

test("a raw component policy edit invalidates an already calculated run",
  { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    try {
      const {input} = await calculatedRun(fx);
      await db.execute(sql`update pay_components set taxable=false
        where org_id=${fx.orgId} and system_key='base_pay'`);
      await assert.rejects(commitPayRun(input), /recalculate|changed|stale/i);
      assert.equal((await db.execute(sql`select run_status from pay_runs
        where org_id=${fx.orgId} and document_id=${input.documentId}`)).rows[0]?.run_status, 'calculated');
    } finally { await dropScratchOrgReporting(fx.orgId); }
  });

test("commit waits for an earlier component editor and then refuses its stale calculation",
  { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    const editor = new pg.Client({connectionString: env.OPENBOOKS_DB_URL});
    let committing: Promise<unknown> | undefined;
    try {
      const {input} = await calculatedRun(fx);
      await editor.connect(); await editor.query("begin");
      await editor.query("update pay_components set taxable=false where org_id=$1 and system_key='base_pay'", [fx.orgId]);
      const pid = (await editor.query<{pid: number}>("select pg_backend_pid() as pid")).rows[0]!.pid;
      committing = commitPayRun(input); void committing.catch(() => {});
      await waitForBlock(editor, pid);
      await editor.query("commit");
      await assert.rejects(committing, /recalculate|changed|stale/i);
      assert.equal((await db.execute(sql`select run_status from pay_runs
        where org_id=${fx.orgId} and document_id=${input.documentId}`)).rows[0]?.run_status, 'calculated');
    } finally {
      await editor.query("rollback").catch(() => {}); await committing?.catch(() => {});
      await editor.end(); await dropScratchOrgReporting(fx.orgId);
    }
  });

for (const change of ["relocate", "delete-profile"] as const) {
  test(`committed payroll country survives employee profile ${change}`,
    { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const fx = await seedAdoption();
      try {
        const {input} = await calculatedRun(fx); await commitPayRun(input);
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
        assert.deepEqual(await w2Slips(fx.orgId, 2026), [], "a Canadian stub cannot become US wages");
      } finally {await dropScratchOrgReporting(fx.orgId);}
    });
}

test("country snapshots capture calculation provenance and cannot be overwritten",
  {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const fx=await seedAdoption();
    try {
      const {input}=await calculatedRun(fx);
      const stub=(await db.execute(sql`select id,country,country_source from pay_stubs
        where org_id=${fx.orgId} and pay_run_document_id=${input.documentId}`)).rows[0]!;
      assert.equal(stub.country,'CA');assert.equal(stub.country_source,'calculation');
      for (const phase of ['calculated','committed']) {
        if (phase==='committed') await commitPayRun(input);
        await assert.rejects(db.execute(sql`update pay_stubs set country='US'
          where org_id=${fx.orgId} and id=${stub.id}`),(error:unknown)=>{
          assert.equal((error as {cause?:{constraint?:string}}).cause?.constraint,'pay_stub_historical_country');return true;
        });
      }
    } finally {await dropScratchOrgReporting(fx.orgId);}
  });

test("legacy province/state snapshots identify supported countries without consulting live profiles",
  {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const seen=new Set<string>();
    for (const country of ['CA','US']) {
      for (const region of PAYROLL_COUNTRY_PACKS[country]!.regions.known) {
        assert.ok(!seen.has(region),'legacy region sets must remain disjoint');seen.add(region);
        assert.equal((await db.execute(sql`select payroll_legacy_region_country(${region}) as country`)).rows[0]?.country,country);
      }
    }
    assert.equal((await db.execute(sql`select payroll_legacy_region_country('UNKNOWN') as country`)).rows[0]?.country,null);
  });

for (const province of ['ON','UNKNOWN']) {
  test(`legacy stub insertion preserves ${province==='ON'?'known':'unknown'} attribution explicitly`,
    {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
      const fx=await seedAdoption();
      try {
        const {input}=await calculatedRun(fx);
        const saved=(await db.execute<{row:Record<string,unknown>}>(sql`select to_jsonb(s) as row from pay_stubs s
          where org_id=${fx.orgId} and pay_run_document_id=${input.documentId}`)).rows[0]!.row;
        await db.execute(sql`delete from pay_stubs where org_id=${fx.orgId} and id=${saved.id}`);
        const replacement={...saved,province,country:null,country_source:'unknown'};
        await db.execute(sql`insert into pay_stubs select (jsonb_populate_record(null::pay_stubs,${JSON.stringify(replacement)}::jsonb)).*`);
        const row=(await db.execute(sql`select country,country_source from pay_stubs where org_id=${fx.orgId} and id=${saved.id}`)).rows[0]!;
        assert.deepEqual(row,province==='ON'?{country:'CA',country_source:'legacy_region'}:{country:null,country_source:'unknown'});
        if (province==='UNKNOWN') {
          await db.execute(sql`update pay_runs set run_status='committed' where org_id=${fx.orgId} and document_id=${input.documentId}`);
          for (const read of [t4Slips,w2Slips,form941Worksheet,rl1Slips]) {
            await assert.rejects(read(fx.orgId,2026),/unknown historical country/);
          }
        }
      } finally {await dropScratchOrgReporting(fx.orgId);}
    });
}

test("regional Canadian year-end slips survive a later country change",
  {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const fx=await seedAdoption();
    try {
      await db.execute(sql`update employee_payroll_profiles set province='QC'
        where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{payroll,qcTaxPayableAccountId}',settings#>'{payroll,taxPayableAccountId}') where id=${fx.orgId}`);
      const {input}=await calculatedRun(fx);await commitPayRun(input);
      const before=await rl1Slips(fx.orgId,2026);assert.equal(before.length,1);
      await db.execute(sql`update employee_payroll_profiles set country='US',province='TX'
        where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
      assert.deepEqual(await rl1Slips(fx.orgId,2026),before);
    } finally {await dropScratchOrgReporting(fx.orgId);}
  });

test("a raw prospective vacation flag edit invalidates an already calculated run",
  { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    try {
      const {input} = await calculatedRun(fx);
      await db.execute(sql`update pay_components set vacationable=false
        where org_id=${fx.orgId} and system_key='base_pay'`);
      await assert.rejects(commitPayRun(input), /recalculate|changed|stale/i);
      assert.equal((await db.execute(sql`select run_status from pay_runs
        where org_id=${fx.orgId} and document_id=${input.documentId}`)).rows[0]?.run_status, 'calculated');
    } finally { await dropScratchOrgReporting(fx.orgId); }
  });
