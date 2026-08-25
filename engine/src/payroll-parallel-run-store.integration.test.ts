import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  ParallelRunStoreError,
  comparableSlots,
  deleteParallelTolerance,
  deletePriorRegister,
  loadOurSide,
  parallelComparisons,
  parallelTolerances,
  priorRegisters,
  recordUnmappedColumns,
  runParallelComparison,
  saveParallelTolerance,
  savePriorStub,
  upsertPriorRegister,
} from "./payroll-parallel-run-store.ts";
import { calculatePayRun, createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Every evidence mutation this store performs — a prior stub with its amounts
 * and audit row, an unmapped-column merge, a register deletion, a tolerance
 * change, a filed comparison with its findings — is one atomic unit. These
 * tests prove the boundary by failing each mutation MID-WRITE where that is
 * reachable (a numeric(19,4) overflow lands after earlier statements have
 * already written) and asserting nothing at all survived.
 */

interface ImportFixture {
  orgId: string;
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  actorId: string;
  registerId: string;
  slots: Awaited<ReturnType<typeof comparableSlots>>;
  salaryId: string;
  bonusId: string;
  employeePartyId: string;
}

async function seedEmployee(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)`);
  return id;
}

async function seedEarningComponent(orgId: string, code: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, basis, sequence, is_active)
    values (${id}, ${orgId}, ${code}, ${code}, 'earning', 'fixed_amount', 100, true)`);
  return id;
}

/** A register plus one employee and two mappable components. */
async function importFixture(): Promise<ImportFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const [salaryId, bonusId] = [
    await seedEarningComponent(org.orgId, "SALARY"),
    await seedEarningComponent(org.orgId, "BONUS"),
  ];
  const registerId = await upsertPriorRegister({
    orgId: org.orgId,
    actorId,
    name: "Prior provider — 2026-07",
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
    payDate: "2026-07-21",
  });
  return {
    orgId: org.orgId,
    org,
    actorId,
    registerId,
    slots: await comparableSlots(org.orgId),
    salaryId,
    bonusId,
    employeePartyId: await seedEmployee(org.orgId, "Robin Field"),
  };
}

async function priorEvidence(
  orgId: string,
  employeePartyId: string,
): Promise<{ stub: Record<string, unknown> | null; amounts: unknown[] }> {
  const stubs = (await db.execute<Record<string, unknown>>(sql`
    select employee_label, gross::text as gross, net_pay::text as net_pay
      from payroll_prior_stubs
     where org_id = ${orgId} and employee_party_id = ${employeePartyId}`));
  const amounts = (await db.execute(sql`
    select a.kind, a.slot, a.amount::text as amount
      from payroll_prior_amounts a
      join payroll_prior_stubs s on s.id = a.prior_stub_id and s.org_id = a.org_id
     where a.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
     order by a.kind, a.slot`));
  return { stub: stubs.rows[0] ?? null, amounts: amounts.rows };
}

async function tableCount(orgId: string, table: string, extraWhere = ""): Promise<number> {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`unsafe table name: ${table}`);
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from ${sql.raw(`public.${table}`)}
     where org_id = ${orgId}${extraWhere ? sql.raw(` and ${extraWhere}`) : sql.raw("")}`));
  return rows.rows[0]!.n;
}

test("a failed re-import leaves the original stub evidence exactly as it was", { skip: !DB }, async () => {
  const f = await importFixture();
  try {
    const first = await savePriorStub({
      orgId: f.orgId, actorId: f.actorId, registerId: f.registerId,
      row: {
        employeePartyId: f.employeePartyId,
        employeeLabel: "EMP-0001",
        gross: "3000", netPay: "2500", employerCost: null,
        amounts: [{ fieldKey: "SALARY", amount: "3000.00", sourceColumn: "Salary" }],
      },
    }, f.slots);
    assert.equal(first.created, true);

    const before = await priorEvidence(f.orgId, f.employeePartyId);
    const auditsBefore = await tableCount(f.orgId, "audit_log", "table_name = 'payroll_prior_stubs'");

    // 1e16 passes exact-decimal validation but overflows the numeric(19,4)
    // amount column — a failure that strikes AFTER the stub has been rewritten
    // and its previous amounts deleted. The whole write must roll back.
    await assert.rejects(
      savePriorStub({
        orgId: f.orgId, actorId: f.actorId, registerId: f.registerId,
        row: {
          employeePartyId: f.employeePartyId,
          employeeLabel: "EMP-0001-REWRITTEN",
          gross: null, netPay: null, employerCost: null,
          amounts: [{ fieldKey: "SALARY", amount: "10000000000000000", sourceColumn: null }],
        },
      }, f.slots),
    );

    assert.deepEqual(await priorEvidence(f.orgId, f.employeePartyId), before);
    assert.equal(
      await tableCount(f.orgId, "audit_log", "table_name = 'payroll_prior_stubs'"),
      auditsBefore,
      "a failed import must not leave an audit row for a rewrite that never happened",
    );
  } finally {
    await dropScratchOrgReporting(f.orgId);
  }
});

test("an amount nobody can map refuses before any write, leaving evidence intact", { skip: !DB }, async () => {
  const f = await importFixture();
  try {
    await savePriorStub({
      orgId: f.orgId, actorId: f.actorId, registerId: f.registerId,
      row: {
        employeePartyId: f.employeePartyId,
        employeeLabel: "EMP-0001",
        gross: "3000", netPay: "2500", employerCost: null,
        amounts: [{ fieldKey: "SALARY", amount: "3000.00", sourceColumn: "Salary" }],
      },
    }, f.slots);
    const before = await priorEvidence(f.orgId, f.employeePartyId);

    await assert.rejects(
      savePriorStub({
        orgId: f.orgId, actorId: f.actorId, registerId: f.registerId,
        row: {
          employeePartyId: f.employeePartyId,
          employeeLabel: "EMP-0001",
          gross: "3000", netPay: "2500", employerCost: null,
          amounts: [{ fieldKey: "GHOST", amount: "1", sourceColumn: null }],
        },
      }, f.slots),
      ParallelRunStoreError,
    );
    assert.deepEqual(await priorEvidence(f.orgId, f.employeePartyId), before);
  } finally {
    await dropScratchOrgReporting(f.orgId);
  }
});

test("a re-import replaces amounts wholesale, files one attributable audit row per write", { skip: !DB }, async () => {
  const f = await importFixture();
  try {
    const first = await savePriorStub({
      orgId: f.orgId, actorId: f.actorId, registerId: f.registerId,
      row: {
        employeePartyId: f.employeePartyId,
        employeeLabel: "EMP-0001",
        gross: "3000", netPay: "2500", employerCost: null,
        amounts: [{ fieldKey: "SALARY", amount: "3000.00", sourceColumn: "Salary" }],
      },
    }, f.slots);
    assert.equal(first.created, true);

    const second = await savePriorStub({
      orgId: f.orgId, actorId: f.actorId, registerId: f.registerId,
      row: {
        employeePartyId: f.employeePartyId,
        employeeLabel: "EMP-0001",
        gross: "3500", netPay: "2800", employerCost: "3900",
        amounts: [{ fieldKey: "BONUS", amount: "500", sourceColumn: "Bonus" }],
      },
    }, f.slots);
    assert.equal(second.created, false);

    const evidence = await priorEvidence(f.orgId, f.employeePartyId);
    assert.deepEqual(evidence.amounts, [{ kind: "earning", slot: "code:BONUS", amount: "500.0000" }]);
    assert.equal(evidence.stub!.gross, "3500.0000");

    // Two columns mapped onto one component: last one wins, one row stored.
    await savePriorStub({
      orgId: f.orgId, actorId: f.actorId, registerId: f.registerId,
      row: {
        employeePartyId: f.employeePartyId,
        employeeLabel: "EMP-0001",
        gross: "3700", netPay: "2900", employerCost: null,
        amounts: [
          { fieldKey: "SALARY", amount: "600", sourceColumn: "Salary A" },
          { fieldKey: "SALARY", amount: "700", sourceColumn: "Salary B" },
        ],
      },
    }, f.slots);
    const deduped = await priorEvidence(f.orgId, f.employeePartyId);
    assert.deepEqual(deduped.amounts, [{ kind: "earning", slot: "code:SALARY", amount: "700.0000" }]);

    const audits = (await db.execute<{ action: string }>(sql`
      select action from audit_log
       where org_id = ${f.orgId} and table_name = 'payroll_prior_stubs'
       order by at`));
    assert.deepEqual(audits.rows.map((row) => row.action), ["insert", "update", "update"]);
  } finally {
    await dropScratchOrgReporting(f.orgId);
  }
});

test("recording unmapped columns merges across passes and never loses a column", { skip: !DB }, async () => {
  const f = await importFixture();
  try {
    await recordUnmappedColumns(f.orgId, f.registerId, [
      { column: "Dept", valuedRows: 5 },
      { column: "Cost Centre", valuedRows: 2 },
    ]);
    await recordUnmappedColumns(f.orgId, f.registerId, [
      { column: "Union", valuedRows: 3 },
      { column: "Dept", valuedRows: 2 },
    ]);

    const registers = await priorRegisters(f.orgId);
    const register = registers.find((r) => r.id === f.registerId)!;
    assert.deepEqual(register.unmappedColumns, [
      { column: "Cost Centre", valuedRows: 2 },
      { column: "Dept", valuedRows: 5 },
      { column: "Union", valuedRows: 3 },
    ]);
  } finally {
    await dropScratchOrgReporting(f.orgId);
  }
});

test("discarding a register removes every trace in one motion and audits the deletion", { skip: !DB }, async () => {
  const f = await importFixture();
  try {
    await savePriorStub({
      orgId: f.orgId, actorId: f.actorId, registerId: f.registerId,
      row: {
        employeePartyId: f.employeePartyId,
        employeeLabel: "EMP-0001",
        gross: "3000", netPay: "2500", employerCost: null,
        amounts: [{ fieldKey: "SALARY", amount: "3000.00", sourceColumn: "Salary" }],
      },
    }, f.slots);

    await deletePriorRegister(f.orgId, f.registerId, f.actorId);

    assert.equal(await tableCount(f.orgId, "payroll_prior_registers"), 0);
    assert.equal(await tableCount(f.orgId, "payroll_prior_stubs"), 0);
    assert.equal(await tableCount(f.orgId, "payroll_prior_amounts"), 0);

    const deletions = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${f.orgId} and table_name = 'payroll_prior_registers'
         and row_id = ${f.registerId} and action = 'delete'`));
    assert.equal(deletions.rows[0]!.n, 1);

    // The deletion is audited; the history of what WAS there stays.
    const stubHistory = await tableCount(f.orgId, "audit_log", "table_name = 'payroll_prior_stubs'");
    assert.ok(stubHistory >= 1, "prior-stub audit history must survive the register's deletion");
  } finally {
    await dropScratchOrgReporting(f.orgId);
  }
});

test("tolerance changes never land without their audit row beside them", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;

    await saveParallelTolerance({
      orgId: org.orgId, actorId, kind: "earning", slot: "base_pay",
      tolerance: "25", reason: "provider rounding on hourly conversions",
    });
    assert.equal((await parallelTolerances(org.orgId)).length, 1);
    assert.equal(await tableCount(org.orgId, "audit_log", "table_name = 'payroll_parallel_tolerances'"), 1);

    // Zero is the default, so saving it removes the allowance instead — and
    // that removal is audited too.
    await saveParallelTolerance({
      orgId: org.orgId, actorId, kind: "earning", slot: "base_pay",
      tolerance: "0", reason: "compares exactly again",
    });
    assert.equal((await parallelTolerances(org.orgId)).length, 0);
    assert.equal(await tableCount(org.orgId, "audit_log", "table_name = 'payroll_parallel_tolerances'"), 2);

    // Removing an absent tolerance writes nothing at all.
    await deleteParallelTolerance(org.orgId, "earning", "base_pay", actorId);
    assert.equal(await tableCount(org.orgId, "audit_log", "table_name = 'payroll_parallel_tolerances'"), 2);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

/**
 * One real calculated CA pay run; the prior register mirrors whatever the run
 * actually paid, so the filing must come out clean with every cell matched.
 */
async function cleanComparisonFixture() {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const account = async (number: string, name: string) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                            reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${org.orgId}, ${number}, ${name}, 'expense', false, true, false, false,
              '[]'::jsonb, '{}'::jsonb, true)`);
    return id;
  };
  const wageExpense = await account("6000", "Wages expense");
  const burdenExpense = await account("6010", "Payroll burden");
  const netPayable = await account("2300", "Wages payable");
  const craPayable = await account("2310", "CRA remittances payable");
  const vacationPayable = await account("2320", "Vacation payable");
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

  const projectId = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-A', 'Job A', 'active', true, '{}'::jsonb)`);

  const employeePartyId = await seedEmployee(org.orgId, "Robin Field");
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                  effective_from, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeePartyId}, 'CAD', '30', 'hour', '2025-06-01', true,
            ${actorId}, ${actorId})`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-01-18', 3, true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           vacation_percent, vacation_method, is_active,
                                           created_by, updated_by)
    values (${org.orgId}, ${employeePartyId}, ${scheduleId}, 'ON', 'hourly', 1, 1,
            '4', 'accrue', true, ${actorId}, ${actorId})`);

  for (const day of ["2026-07-06", "2026-07-13"]) {
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id,
                                status, is_billable, billing_status, costing_basis,
                                created_by, updated_by)
      values (${org.orgId}, ${employeePartyId}, ${day}, 40, ${projectId}, 'approved',
              false, 'unbilled', 'actual', ${actorId}, ${actorId})`);
  }

  const run = await createPayRun({
    orgId: org.orgId, actorId, payScheduleId: scheduleId,
    periodStart: "2026-07-05", periodEnd: "2026-07-18", payDate: "2026-07-21",
  });
  const calculated = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
  assert.deepEqual(calculated.errors, [], "the fixture run must calculate cleanly");
  assert.equal(calculated.gross, "2400.0000", "80 h × $30.00");
  return { org, actorId, run, employeePartyId };
}

test("a filed comparison stores its header, its findings and its audit row together", { skip: !DB }, async () => {
  const fixture = await cleanComparisonFixture();
  const { org, actorId, run, employeePartyId } = fixture;
  try {
    // The mirror register states exactly what our run paid, slot by slot.
    const slots = await comparableSlots(org.orgId);
    const fieldKeyByCell = new Map(
      slots.filter((slot) => slot.kind !== "total").map((slot) => [`${slot.kind}/${slot.slot}`, slot.fieldKey]),
    );
    const ours = await loadOurSide(org.orgId, run.documentId);
    assert.equal(ours.employees.length, 1);
    const mirror = ours.employees[0]!;
    const amounts = mirror.amounts.map((amount) => {
      const fieldKey = fieldKeyByCell.get(`${amount.kind}/${amount.slot}`);
      if (!fieldKey) throw new Error(`our side carries a slot no component claims: ${amount.kind}/${amount.slot}`);
      return { fieldKey, amount: amount.amount, sourceColumn: fieldKey };
    });
    assert.ok(amounts.length > 0, "the fixture run must have produced component lines");

    const registerId = await upsertPriorRegister({
      orgId: org.orgId, actorId,
      name: "Mirror register — 2026-07-18",
      periodStart: "2026-07-05", periodEnd: "2026-07-18", payDate: "2026-07-21",
    });
    await savePriorStub({
      orgId: org.orgId, actorId, registerId,
      row: {
        employeePartyId,
        employeeLabel: "EMP-0001",
        gross: mirror.gross, netPay: mirror.netPay, employerCost: mirror.employerCost,
        amounts,
      },
    }, slots);

    const filed = await runParallelComparison({
      orgId: org.orgId, actorId, registerId, payRunDocumentId: run.documentId,
    });
    assert.equal(filed.comparison.status, "clean");
    assert.equal(filed.comparison.counts.difference, 0);
    assert.ok(filed.comparison.findings.length > 0, "a clean result still compared real cells");

    const headers = (await db.execute<{ status: string; compared: number; difference_count: number }>(sql`
      select status, compared_employee_count as compared, difference_count
        from payroll_parallel_comparisons
       where org_id = ${org.orgId} and id = ${filed.comparisonId}`));
    assert.equal(headers.rows.length, 1);
    assert.deepEqual(headers.rows[0], { status: "clean", compared: 1, difference_count: 0 });

    const findings = await tableCount(org.orgId, "payroll_parallel_findings",
      `comparison_id = '${filed.comparisonId}'`);
    assert.equal(findings, filed.comparison.findings.length);

    const audits = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${org.orgId} and table_name = 'payroll_parallel_comparisons'
         and row_id = ${filed.comparisonId} and action = 'insert'`));
    assert.equal(audits.rows[0]!.n, 1);

    const summaries = await parallelComparisons(org.orgId);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.status, "clean");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a comparison whose findings cannot be stored files nothing at all", { skip: !DB }, async () => {
  const f = await importFixture();
  try {
    // Two employees whose per-cell differences need sixteen integer digits —
    // more than any numeric(19,4) finding column can hold — chosen so the
    // POPULATION sums cancel: the header's totals and unattributed figures
    // all fit, and only the finding rows overflow. The filing must therefore
    // die between the header insert and the findings insert.
    const huge = "900000000000000.0000";
    const otherPartyId = await seedEmployee(f.orgId, "Casey Lin");
    for (const [employeePartyId, sign] of [
      [f.employeePartyId, ""],
      [otherPartyId, "-"],
    ] as const) {
      await savePriorStub({
        orgId: f.orgId, actorId: f.actorId, registerId: f.registerId,
        row: {
          employeePartyId,
          employeeLabel: employeePartyId === f.employeePartyId ? "EMP-0001" : "EMP-0002",
          gross: sign + huge, netPay: null, employerCost: null,
          amounts: [{ fieldKey: "SALARY", amount: sign + huge, sourceColumn: "Salary" }],
        },
      }, f.slots);
    }

    // Our side, seeded directly so stubs can carry the mirrored negatives:
    // Robin pays -huge where the register says +huge, and Casey pays +huge
    // where it says -huge.
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year,
                                 anchor_period_end, pay_date_offset_days, is_active,
                                 created_by, updated_by)
      values (${scheduleId}, ${f.orgId}, 'Biweekly', 'biweekly', 26, '2026-01-18', 3, true,
              ${f.actorId}, ${f.actorId})`);
    const documentId = randomUUID();
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, status)
      values (${documentId}, ${f.orgId}, 'pay_run', 'PR-PARALLEL-1', '2026-07-21', 'CAD', 'draft')`);
    await db.execute(sql`
      insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                            pay_date, tax_year, run_status, employee_count)
      values (${documentId}, ${f.orgId}, ${scheduleId},
              '2026-07-05', '2026-07-18', '2026-07-21', 2026, 'calculated', 2)`);
    for (const [employeePartyId, sign] of [
      [f.employeePartyId, "-"],
      [otherPartyId, ""],
    ] as const) {
      const stubId = randomUUID();
      await db.execute(sql`
        insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                               periods_per_year, pay_date, tax_year, currency_code,
                               gross, net_pay, employer_cost)
        values (${stubId}, ${f.orgId}, ${documentId}, ${employeePartyId}, 'ON', 26,
                '2026-07-21', 2026, 'CAD', ${sign + huge}, '0', '0')`);
      await db.execute(sql`
        insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount)
        values (${f.orgId}, ${stubId}, ${f.salaryId}, 'earning', 'Salary', ${sign + huge})`);
    }

    await assert.rejects(
      runParallelComparison({
        orgId: f.orgId, actorId: f.actorId,
        registerId: f.registerId, payRunDocumentId: documentId,
      }),
    );

    // Nothing survived: not the header, not a fragment of the findings, and
    // no audit row claiming a comparison happened.
    assert.equal(await tableCount(f.orgId, "payroll_parallel_comparisons"), 0);
    assert.equal(await tableCount(f.orgId, "payroll_parallel_findings"), 0);
    assert.equal(
      await tableCount(f.orgId, "audit_log", "table_name = 'payroll_parallel_comparisons'"),
      0,
    );
    assert.equal((await parallelComparisons(f.orgId)).length, 0);
  } finally {
    await dropScratchOrgReporting(f.orgId);
  }
});
