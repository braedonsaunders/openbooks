import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, sum } from "../money/money.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture } from "./filing-test-fixtures.ts";
import { setPackSlotAccount } from "./packs.ts";
import { createRuleWithInitialDraft, updateDraftVersion, replaceTargets, publishVersion } from "../allocations/index.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Department expense mapping: the same earning posts to different
 * expense accounts by worker department.
 *
 * Regular Wages defaults to 5110 with an Overhead → 8010 override. A run
 * with 1,000.00 of Field hours and 400.00 of Overhead hours posts
 * DR 5110 1,000.00 and DR 8010 400.00; the liability side and the
 * balancing total are unchanged.
 */
test(
  "department mappings override the component expense account per line",
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
      const wagesDefault = await account("5110", "Regular wages", "expense");
      const overheadExpense = await account("8010", "Overhead wages", "expense");
      const burdenExpense = await account("6010", "Payroll burden", "expense");
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      const ehtPayable = await account("2340", "EHT payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wagesDefault,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);

      await seedPayrollComponents(org.orgId, actorId, "CA");
      await seedOntarioEhtFixture(org.orgId, actorId, "0");
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);
      // Regular Wages defaults to 5110 at the component.
      const baseId = (await db.execute<{ id: string }>(sql`
        select id from pay_components
         where org_id = ${org.orgId} and code = 'BASE' and country is null
      `)).rows[0]!.id;
      await db.execute(sql`
        update pay_components set expense_account_id = ${wagesDefault}, updated_by = ${actorId}
         where org_id = ${org.orgId} and id = ${baseId}`);

      const department = async (code: string) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into departments (id, org_id, code, name, is_active)
          values (${id}, ${org.orgId}, ${code}, ${code}, true)`);
        return id;
      };
      const fieldId = await department("FIELD");
      const overheadId = await department("OVERHEAD");
      await db.execute(sql`
        insert into pay_component_department_expenses
               (org_id, pay_component_id, department_id, expense_account_id,
                effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${baseId}, ${overheadId}, ${overheadExpense},
                '2026-01-01', true, ${actorId}, ${actorId})`);

      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"allocations":true}'::jsonb) where id = ${org.orgId}`);
      const segmentId = randomUUID();
      const crewNorth = randomUUID();
      const crewSouth = randomUUID();
      await db.execute(sql`insert into segment_definitions (id, org_id, key, name, plural_name, source_kind) values (${segmentId}, ${org.orgId}, 'crew', 'Crew', 'Crews', 'custom')`);
      await db.execute(sql`insert into segment_values (id, org_id, segment_id, name) values (${crewNorth}, ${org.orgId}, ${segmentId}, 'North'), (${crewSouth}, ${org.orgId}, ${segmentId}, 'South')`);
      const allocation = await createRuleWithInitialDraft({ orgId: org.orgId, key: 'overhead-crew', name: 'Overhead crews', mode: 'post', effectiveFrom: '2026-01-01', payrollExpenses: true, allowedSubsidiaryIds: null }, { actorId });
      await updateDraftVersion(allocation.draft.version.id, { orgId: org.orgId, allowedSubsidiaryIds: null, documentKinds: ['pay_run'], dimensionFilters: { payrollExpensesOnly: true, payComponentIds: [baseId], departmentIds: [overheadId] }, basisKind: 'fixed_percent', impact: 'reclass' }, { actorId });
      await replaceTargets(allocation.draft.version.id, { orgId: org.orgId, allowedSubsidiaryIds: null, targets: [
        { sequence: 1, departmentId: fieldId, extraDims: { crew: crewNorth }, fixedPercent: '60' },
        { sequence: 2, departmentId: overheadId, extraDims: { crew: crewSouth }, fixedPercent: '40' },
      ] }, { actorId });
      await publishVersion(allocation.draft.version.id, { orgId: org.orgId, actorId, allowedSubsidiaryIds: null, reason: 'Allocate overhead wages to the crews receiving the work.' });

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Weekly', 'weekly', 52, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Dana Department', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into employee_roles (id, org_id, party_id)
        values (${randomUUID()}, ${org.orgId}, ${employeeId})`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '25', 'hour', '2026-01-01', true,
                ${actorId}, ${actorId})`);
      const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                               country, province, pay_basis, federal_claim_code,
                                               provincial_claim_code, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
                true, ${actorId}, ${actorId})`);
      const { seedVacationTerms } = await import("./filing-test-fixtures.ts");
      await seedVacationTerms(org.orgId, employmentId, actorId, "0", "accrue");
      // 40 Field hours (1,000.00) and 16 Overhead hours (400.00), no items.
      for (const [departmentId, hours] of [[fieldId, "40"], [overheadId, "16"]] as const) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, department_id, status,
                                    is_billable, billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, '2026-07-14', ${hours}, ${departmentId}, 'approved', false,
                  'unbilled', 'actual', ${actorId}, ${actorId})`);
      }

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-12", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.deepEqual(result.errors, []);

      // The stub carries one line per department, each stamped at calculate.
      const stubLines = (await db.execute<{
        amount: string; department_id: string | null;
        expense_account_id: string | null; expense_account_source: string | null;
      }>(sql`
        select l.amount, l.department_id, l.expense_account_id, l.expense_account_source
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
         where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
           and l.kind = 'earning'
      `));
      assert.equal(stubLines.rows.length, 2);
      const fieldLine = stubLines.rows.find((row) => row.department_id === fieldId)!;
      const overheadLine = stubLines.rows.find((row) => row.department_id === overheadId)!;
      assert.equal(fieldLine.amount, "1000.0000");
      assert.equal(fieldLine.expense_account_id, wagesDefault);
      assert.equal(fieldLine.expense_account_source, "component");
      assert.equal(overheadLine.amount, "400.0000");
      assert.equal(overheadLine.expense_account_id, overheadExpense);
      assert.equal(overheadLine.expense_account_source, "department");

      // The range exclusion is the backstop: an overlapping active window
      // for the same component and department refuses at the database,
      // even for writers around the setup validation hook.
      await assert.rejects(
        db.execute(sql`
          insert into pay_component_department_expenses
                 (org_id, pay_component_id, department_id, expense_account_id,
                  effective_from, is_active, created_by, updated_by)
          values (${org.orgId}, ${baseId}, ${overheadId}, ${wagesDefault},
                  '2026-06-01', true, ${actorId}, ${actorId})`),
        (error: unknown) => {
          const cause = (error as { cause?: { code?: string } })?.cause;
          assert.equal(cause?.code, "23P01");
          return true;
        },
      );

      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const glLines = (await db.execute<{ account_id: string; amount: string; custom: { payrollExpense?: boolean; payComponentId?: string | null } }>(sql`
        select account_id, amount, custom from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}
      `));
      assert.equal(cmp(sum(glLines.rows.map((row) => row.amount)), "0"), 0, "projection balances");
      assert.equal(
        sum(glLines.rows.filter((row) => row.account_id === wagesDefault).map((row) => row.amount)),
        "1000.0000",
      );
      assert.equal(
        sum(glLines.rows.filter((row) => row.account_id === overheadExpense).map((row) => row.amount)),
        "400.0000",
      );
      const wageLegs = glLines.rows.filter(row => row.account_id === wagesDefault || row.account_id === overheadExpense);
      assert.ok(wageLegs.every(row => row.custom.payrollExpense === true && row.custom.payComponentId === baseId));
      const liabilities = glLines.rows.filter(row => cmp(row.amount, '0') < 0);
      assert.ok(liabilities.every(row => row.custom.payrollExpense === false && row.custom.payComponentId === null));
      await db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${run.documentId}`);
      const entryId = await postDocument(run.documentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }, { audit: { actorId, source: "payroll" } });
      const posted = (await db.execute<{ account_id: string; amount: string; department_id: string | null; extra_dims: Record<string, string> }>(sql`select account_id, amount, department_id, extra_dims from journal_lines where org_id = ${org.orgId} and entry_id = ${entryId} order by line_number`)).rows;
      assert.equal(cmp(sum(posted.map(row => row.amount)), '0'), 0);
      assert.deepEqual(posted.filter(row => row.extra_dims.crew).map(row => [row.department_id, row.extra_dims.crew, row.amount]), [[fieldId, crewNorth, '240.0000'], [overheadId, crewSouth, '160.0000']]);
      for (const liability of liabilities) assert.equal(sum(posted.filter(row => row.account_id === liability.account_id).map(row => row.amount)), sum(liabilities.filter(row => row.account_id === liability.account_id).map(row => row.amount)));
      assert.equal((await db.execute<{ count: string }>(sql`select count(*)::text as count from allocation_lineage where org_id = ${org.orgId} and document_id = ${run.documentId} and version_id = ${allocation.draft.version.id}`)).rows[0]?.count, '3');
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
