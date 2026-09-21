import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { add, cmp } from "../../money/money.ts";
import { yearEndFiling } from "../filing-registry.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { seedPayrollComponents } from "../run-setup.ts";
import { upsertStatutoryRate } from "../statutory-rates.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../../testing/fixtures.ts";
import { BR_PACK_RATES } from "./rates.ts";
import { brInformeRows } from "./informe.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The BR informe de rendimentos, end to end through the real engine.
 *
 * Two monthly-CLT employees across the 2025 mid-year IRRF change: Ana at
 * R$ 3.000/month (the within-year proof — 13.20 under the January–April
 * table, 0.00 under the May–December table) and Bruno at R$ 6.000/month
 * with two dependants (471.09 then 458.36). April + May committed, June
 * calculated but never committed: the slip must carry two months, never
 * three, and tie to the committed subledger to the cent.
 */

interface Fixture {
  orgId: string;
  actorId: string;
  scheduleId: string;
  anaId: string;
  brunoId: string;
}

async function brPayrollOrg(): Promise<Fixture> {
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
  const netPayable = await account("2300", "Wages payable", "liability_current");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        countries: ["BR"],
      },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "BR");

  const subsidiaryId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                              is_elimination, is_active, custom)
    values (${subsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'BR Entity', 'BRL', 'BR',
            '{}'::jsonb, false, true, '{}'::jsonb)`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, subsidiary_id, is_active,
                               created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Monthly BR', 'monthly', 12, '2025-04-30', 0,
            ${subsidiaryId}, true, ${actorId}, ${actorId})`);

  const filingAccountId = randomUUID();
  await db.execute(sql`
    insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name,
                                         state_code, is_default)
    values (${filingAccountId}, ${org.orgId}, 'BR', 'br_cnpj_esocial', '12.345.678/0001-95',
            'Matriz', null, true)`);
  // The establishment's own rates: CNAE risk 2%, neutral FAP, 5.8% terceiros.
  await upsertStatutoryRate({
    orgId: org.orgId, actorId, rates: BR_PACK_RATES, rateKey: "br_rat",
    region: "BR", filingAccountId, taxYear: 2025, values: { aliquota: "2" },
  });
  await upsertStatutoryRate({
    orgId: org.orgId, actorId, rates: BR_PACK_RATES, rateKey: "br_fap",
    region: "BR", filingAccountId, taxYear: 2025, values: { fator: "1" },
  });
  await upsertStatutoryRate({
    orgId: org.orgId, actorId, rates: BR_PACK_RATES, rateKey: "br_terceiros",
    region: "BR", filingAccountId, taxYear: 2025, values: { aliquota: "5.8" },
  });

  const employee = async (name: string, annualSalary: string, dependentes: number) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${id}, ${org.orgId}, 'person', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id)
      values (${randomUUID()}, ${org.orgId}, ${id})`);
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                    effective_from, is_active, created_by, updated_by)
      values (${org.orgId}, ${id}, 'BRL', ${annualSalary}, 'year', 2080, '2025-01-01', true,
              ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                             province, pay_basis, filing_account_id, br_dependentes,
                                             is_active, created_by, updated_by)
      values (${org.orgId}, ${id}, ${scheduleId}, 'BR', 'BR',
              'salary', ${filingAccountId}, ${dependentes}, true, ${actorId}, ${actorId})`);
    return id;
  };
  const anaId = await employee("Ana Souza", "36000", 0);
  const brunoId = await employee("Bruno Lima", "72000", 2);
  return { orgId: org.orgId, actorId, scheduleId, anaId, brunoId };
}

async function runMonth(
  fx: Fixture,
  periodStart: string,
  periodEnd: string,
  commit: boolean,
): Promise<void> {
  const run = await createPayRun({
    orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
    periodStart, periodEnd,
  });
  assert.deepEqual((await calculatePayRun({
    orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
  })).errors, []);
  if (commit) {
    await commitPayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
  }
}

/** Cent-exact money equality, whatever 2dp/4dp shape either side carries. */
function moneyEqual(actual: string, expected: string, what: string): void {
  assert.equal(
    cmp(actual, expected), 0,
    `${what}: expected ${expected}, got ${actual}`,
  );
}

test(
  "the informe aggregates two committed runs across the mid-year table change",
  { skip: !DB },
  async () => {
    const fx = await brPayrollOrg();
    try {
      await runMonth(fx, "2025-04-01", "2025-04-30", true);
      await runMonth(fx, "2025-05-01", "2025-05-31", true);
      // Calculated but never committed: a draft must not appear on a
      // statutory filing, so June's third salary stays off every slip.
      await runMonth(fx, "2025-06-01", "2025-06-30", false);

      const filing = yearEndFiling("BR", "informe");
      const data = await filing.population(fx.orgId, 2025);
      assert.equal(data.rows.length, 2);
      const byEmployee = new Map(data.rows.map((row) => [row.employee, row]));

      // Ana at R$ 3.000: the same salary prices 13.20 in April (Lei
      // 14.848/2024 item XI) and 0.00 in May (Lei 15.191/2025 item XII) —
      // the annual figure is a sum across two tables, selected by pay month.
      const ana = byEmployee.get("Ana Souza")!;
      moneyEqual(String(ana.rendimentos), "6000", "Ana rendimentos");
      moneyEqual(String(ana.inss), "506.80", "Ana INSS");
      moneyEqual(String(ana.irrf), "13.20", "Ana IRRF");
      assert.equal(ana.dependentes, 0);
      // Bruno at R$ 6.000 with two dependants: 471.09 + 458.36.
      const bruno = byEmployee.get("Bruno Lima")!;
      moneyEqual(String(bruno.rendimentos), "12000", "Bruno rendimentos");
      moneyEqual(String(bruno.inss), "1299.16", "Bruno INSS");
      moneyEqual(String(bruno.irrf), "929.45", "Bruno IRRF");
      assert.equal(bruno.dependentes, 2);

      // The tie-out, by an independent query: the population must equal the
      // committed subledger's own sums, to the cent.
      const ledger = (await db.execute<{
        name: string; rendimentos: string; inss: string; irrf: string;
      }>(sql`
        select p.display_name as name,
               sum(case when l.kind = 'earning' then l.amount else 0 end) as rendimentos,
               sum(case when l.kind = 'deduction' and pc.system_key = 'inss'
                        then l.amount else 0 end) as inss,
               sum(case when l.kind = 'deduction' and pc.system_key = 'irrf'
                        then l.amount else 0 end) as irrf
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          join pay_runs r on r.document_id = s.pay_run_document_id
                          and r.org_id = s.org_id and r.run_status = 'committed'
          join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
          join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
         where s.org_id = ${fx.orgId} and s.tax_year = 2025 and s.country = 'BR'
         group by p.display_name
      `));
      assert.equal(ledger.rows.length, 2);
      for (const leg of ledger.rows) {
        const row = byEmployee.get(leg.name)!;
        moneyEqual(String(row.rendimentos), String(leg.rendimentos), `${leg.name} tie-out rendimentos`);
        moneyEqual(String(row.inss), String(leg.inss), `${leg.name} tie-out INSS`);
        moneyEqual(String(row.irrf), String(leg.irrf), `${leg.name} tie-out IRRF`);
      }
      // The population totals tie to the same ledger.
      const total = (key: string) =>
        data.rows.reduce((acc, row) => add(acc, String(row[key])), "0");
      const ledgerTotal = (key: "rendimentos" | "inss" | "irrf") =>
        ledger.rows.reduce((acc, leg) => add(acc, String(leg[key])), "0");
      for (const key of ["rendimentos", "inss", "irrf"] as const) {
        moneyEqual(total(key), ledgerTotal(key), `total ${key}`);
      }

      // parseRowId round-trips every emitted row id, and refuses a foreign one.
      for (const row of data.rows) {
        const parsed = filing.parseRowId(String(row.rowId));
        assert.ok(parsed, `row id must parse: ${row.rowId}`);
        assert.equal(parsed.employees.length, 1);
      }
      assert.equal(filing.parseRowId("not-a-row"), null);
      assert.equal(filing.parseRowId(`${fx.anaId}:BR:${fx.brunoId}`), null);

      // The slip carries the same figures, box for box.
      const slip = (await filing.slip!.build(fx.orgId, 2025, String(ana.rowId)))!;
      assert.equal(slip.formNumber, "IN RFB nº 2.060/2021 · Anexo I");
      const box = (code: string) => slip.boxes.find((b) => b.code === code)!.value;
      assert.equal(box("Q3-1"), String(ana.rendimentos));
      assert.equal(box("Q3-2"), String(ana.inss));
      assert.equal(box("Q3-5"), String(ana.irrf));
      assert.ok(
        slip.headerFields.some((h) => h.value.includes("0 × R$ 189.59")),
        "the dependent count rides on the slip with its statutory value",
      );
      assert.ok(
        slip.notes!.some((n) => n.includes("extinta") && n.includes("EFD-Reinf")),
        "the 2025 slip names the DIRF sunset channel",
      );
      assert.ok(
        slip.notes!.some((n) => n.includes("Quadro 5") && n.includes("not produced")),
        "amounts the engine does not price are refused, never zeroed",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "refusal paths: an empty year and an uncovered year refuse by name",
  { skip: !DB },
  async () => {
    const fx = await brPayrollOrg();
    try {
      await runMonth(fx, "2025-04-01", "2025-04-30", true);
      const filing = yearEndFiling("BR", "informe");
      // 2024 is transcribed but this org paid nothing in it: no empty slip.
      await assert.rejects(
        filing.population(fx.orgId, 2024),
        /no committed BR pay runs for 2024/,
      );
      // 2023 has no transcribed tables at all: refuse before reading a byte.
      await assert.rejects(
        brInformeRows(fx.orgId, 2023),
        /2023.*has not been transcribed/,
      );
      // No row exists for this id.
      await assert.rejects(
        filing.slip!.build(fx.orgId, 2025, `${randomUUID()}:`),
        /no 2025 Comprovante de Rendimentos matches/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
