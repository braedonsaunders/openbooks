/**
 * SG IR8A population tie-out — database-owned.
 *
 * Two employees across two committed monthly runs (plus a draft run that
 * must not appear): the population aggregates per employee, every figure
 * ties to an independent sum over committed stubs to the cent, every
 * emitted row id round-trips through the declaration's own grammar, and
 * the refusal paths name the problem instead of printing an empty slip.
 *
 * Monthly figures follow the CPF Board's own worked examples (see
 * engine/src/payroll/sg/cpf.test.ts): $4,500 OW prices $900 employee /
 * $765 employer; $3,000 OW prices $600 employee / $510 employer.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { add } from "../../money/money.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../../testing/fixtures.ts";
import { SG_PAYROLL_PACK } from "./pack.ts";
import { ir8aSlips } from "./filings.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function ir8a() {
  const filing = SG_PAYROLL_PACK.filings().yearEnd.find((candidate) => candidate.key === "ir8a");
  assert.ok(filing, "the SG pack declares an IR8A filing");
  return filing;
}

interface Ir8aFixture {
  orgId: string;
  actorId: string;
  employeeA: string;
  employeeB: string;
}

/** Two SG employees, two committed 2026 runs, one draft run, direct-seeded stubs. */
async function seedIr8aYear(): Promise<Ir8aFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;

  const employee = async (name: string): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
      values (${id}, ${org.orgId}, 'person', ${name}, true, ${org.subsidiaryId}, '{}'::jsonb)`);
    return id;
  };
  const employeeA = await employee("Amena Tan");
  const employeeB = await employee("Bala Raj");

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Monthly', 'monthly', 12, '2026-01-31', 5, true,
            ${actorId}, ${actorId})`);

  const component = async (
    code: string, name: string, kind: string, systemKey: string, taxable: boolean,
  ): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      insert into pay_components (id, org_id, code, name, kind, system_key, country, taxable,
                                  created_by, updated_by)
      values (${id}, ${org.orgId}, ${code}, ${name}, ${kind}, ${systemKey}, 'SG', ${taxable},
              ${actorId}, ${actorId})`);
    return id;
  };
  const salaryId = await component("SAL", "Salary", "earning", "salary", true);
  const cpfEeId = await component("CPF_EE", "CPF — employee share", "deduction", "cpf_ee", false);
  const cpfErId = await component("CPF_ER", "CPF — employer share", "employer_contribution", "cpf_er", false);
  const sdlId = await component("SDL", "Skills Development Levy", "employer_contribution", "sdl", false);

  const run = async (periodEnd: string, payDate: string, status: "committed" | "draft"): Promise<string> => {
    const documentId = randomUUID();
    await db.execute(sql`
      insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                             currency, status, created_by, updated_by)
      values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
              ${org.subsidiaryId}, ${payDate}, 'SGD', 'draft', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                            tax_year, run_status, calculated_at, created_by, updated_by)
      values (${documentId}, ${org.orgId}, ${scheduleId}, ${`${payDate.slice(0, 8)}01`}, ${periodEnd},
              ${payDate}, 2026, ${status}, now(), ${actorId}, ${actorId})`);
    return documentId;
  };

  const stub = async (
    documentId: string, employeeId: string, payDate: string,
    gross: string, cpfEe: string, cpfEr: string, sdl: string,
  ): Promise<void> => {
    const stubId = randomUUID();
    await db.execute(sql`
      insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                             periods_per_year, pay_date, tax_year, currency_code, gross, net_pay,
                             pensionable_earnings, insurable_earnings, factors,
                             country, country_source, created_by, updated_by)
      values (${stubId}, ${org.orgId}, ${documentId}, ${employeeId}, 'SG',
              12, ${payDate}, 2026, 'SGD', ${gross}, ${gross},
              ${gross}, ${gross}, '{}'::jsonb,
              'SG', 'calculation', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount,
                                  created_by, updated_by)
      values (${org.orgId}, ${stubId}, ${salaryId}, 'earning', 'Salary', ${gross},
              ${actorId}, ${actorId}),
             (${org.orgId}, ${stubId}, ${cpfEeId}, 'deduction', 'CPF — employee share', ${cpfEe},
              ${actorId}, ${actorId}),
             (${org.orgId}, ${stubId}, ${cpfErId}, 'employer_contribution', 'CPF — employer share',
              ${cpfEr}, ${actorId}, ${actorId}),
             (${org.orgId}, ${stubId}, ${sdlId}, 'employer_contribution', 'Skills Development Levy',
              ${sdl}, ${actorId}, ${actorId})`);
  };

  // January + February committed for both employees; March draft for A only.
  const jan = await run("2026-01-31", "2026-02-05", "committed");
  const feb = await run("2026-02-28", "2026-03-05", "committed");
  const mar = await run("2026-03-31", "2026-04-05", "draft");
  await stub(jan, employeeA, "2026-02-05", "4500.00", "900.00", "765.00", "11.25");
  await stub(jan, employeeB, "2026-02-05", "3000.00", "600.00", "510.00", "7.50");
  await stub(feb, employeeA, "2026-03-05", "4500.00", "900.00", "765.00", "11.25");
  await stub(feb, employeeB, "2026-03-05", "3000.00", "600.00", "510.00", "7.50");
  await stub(mar, employeeA, "2026-04-05", "4500.00", "900.00", "765.00", "11.25");

  return { orgId: org.orgId, actorId, employeeA, employeeB };
}

test(
  "the IR8A population aggregates two employees over two committed runs and excludes the draft",
  { skip: !DB },
  async () => {
    const fx = await seedIr8aYear();
    try {
      const filing = ir8a();
      const data = await filing.population(fx.orgId, 2026);
      assert.equal(data.rows.length, 2);

      // Independent ground truth, straight from committed stubs.
      const truth = await db.execute<{ employee_party_id: string; income: string; ee: string; er: string }>(sql`
        select s.employee_party_id,
               sum(case when l.kind = 'earning' then l.amount else 0 end)::text as income,
               sum(case when pc.system_key = 'cpf_ee' then l.amount else 0 end)::text as ee,
               sum(case when pc.system_key = 'cpf_er' then l.amount else 0 end)::text as er
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
                           and r.run_status = 'committed'
          join pay_stub_lines l on l.stub_id = s.id and l.org_id = s.org_id
          join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
         where s.org_id = ${fx.orgId} and s.tax_year = 2026 and s.country = 'SG'
         group by s.employee_party_id`);
      assert.equal(truth.rows.length, 2);
      for (const row of data.rows) {
        const expected = truth.rows.find(
          (candidate) => candidate.employee_party_id === row.rowId,
        );
        assert.ok(expected, `population row ${row.rowId} ties to a committed-stub employee`);
        assert.equal(row.employmentIncome, expected.income);
        assert.equal(row.employeeCpf, expected.ee);
        assert.equal(row.employerCpf, expected.er);
      }

      // Named figures: A earned 2 × $4,500 with $1,800 / $1,530 CPF;
      // B earned 2 × $3,000 with $1,200 / $1,020 CPF. March draft excluded.
      const byId = new Map(data.rows.map((row) => [row.rowId as string, row]));
      assert.equal(byId.get(fx.employeeA)?.employmentIncome, "9000.00");
      assert.equal(byId.get(fx.employeeA)?.employeeCpf, "1800.00");
      assert.equal(byId.get(fx.employeeA)?.employerCpf, "1530.00");
      assert.equal(byId.get(fx.employeeB)?.employmentIncome, "6000.00");
      assert.equal(byId.get(fx.employeeB)?.employeeCpf, "1200.00");
      assert.equal(byId.get(fx.employeeB)?.employerCpf, "1020.00");

      // Totals tie to the same committed-stub sums, to the cent.
      const total = (pick: (row: { income: string; ee: string; er: string }) => string) =>
        truth.rows.reduce((acc, row) => add(acc, pick(row) ?? "0"), "0");
      const totals = new Map((data.totals ?? []).map((entry) => [entry.label, entry.value]));
      assert.equal(totals.get("Employment income"), total((row) => row.income));
      assert.equal(totals.get("Employee CPF"), total((row) => row.ee));
      assert.equal(totals.get("Employer CPF"), total((row) => row.er));

      // Every emitted row id round-trips through the declared grammar, and
      // a foreign id parses to null.
      for (const row of data.rows) {
        const scope = filing.parseRowId(String(row.rowId));
        assert.deepEqual(scope, { employees: [row.rowId], accounts: [] });
      }
      assert.equal(filing.parseRowId("t4:ON:whatever"), null);

      // The slip carries the same tied figures, box for box.
      const slip = await filing.slip!.build(fx.orgId, 2026, fx.employeeA);
      const boxes = new Map(slip.boxes.map((box) => [box.code, box.value]));
      assert.equal(boxes.get("a–d"), "9000.00");
      assert.equal(boxes.get("Ded(I)"), "1800.00");
      assert.equal(boxes.get("ER-CPF"), "1530.00");

      // The builder agrees with the declaration: same rows, same figures.
      const slips = await ir8aSlips(fx.orgId, 2026);
      assert.equal(slips.length, 2);
      assert.equal(
        slips.find((candidate) => candidate.employeePartyId === fx.employeeA)?.employmentIncome,
        "9000.00",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a year with no committed runs refuses by name instead of printing an empty IR8A",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await assert.rejects(() => ir8a().population(org.orgId, 2026), /no committed SG pay runs/);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a year the pack has not transcribed refuses by name instead of printing an empty IR8A",
  { skip: !DB },
  async () => {
    const fx = await seedIr8aYear();
    try {
      await assert.rejects(() => ir8a().population(fx.orgId, 2025), /2025/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
