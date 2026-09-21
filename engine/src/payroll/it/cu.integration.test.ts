import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { add, cmp } from "../../money/money.ts";
import { IT_PACK_FILINGS } from "./filings.ts";
import { CU_SUPPORTED_TAX_YEAR, parseCuRowId } from "./cu.ts";
import { IT_PACK_RATES } from "./rates.ts";
import { upsertStatutoryRate } from "../statutory-rates.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { seedPayrollComponents } from "../run-setup.ts";
import { createScratchOrg, seedFlowActors } from "../../testing/fixtures.ts";
import "../../testing/database-bypass.ts";

/**
 * The IT Certificazione Unica population, proved against committed runs.
 *
 * Fixture: two employees (A indeterminato, B determinato) paid monthly in
 * 2025 across two committed runs, plus a third run left calculated-but-
 * uncommitted. The tie-out re-sums the committed stub lines with an
 * independent query and requires the population to match to the cent, while
 * the draft run's nonzero lines prove the exclusion is real rather than
 * vacuous.
 *
 * DB-owned: skipped without OPENBOOKS_DB_URL ("written to the standard, not
 * executed" on the Mac; the gate runs this file on the other machine).
 */

const DB = !!process.env.OPENBOOKS_DB_URL;
const TAX_YEAR = CU_SUPPORTED_TAX_YEAR; // 2025, the CU 2026 layout year.
const REGION = "12"; // Lazio.
const COMUNE = "H501"; // Roma.

async function seedOrg(): Promise<{ orgId: string; actorId: string; scheduleId: string }> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const account = async (number: string, name: string, type: string) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_active, is_summary, created_by, updated_by)
      values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, true, false, ${actorId}, ${actorId})`);
    return id;
  };
  const wageId = await account("6000", "Wages & Salaries", "expense");
  const netId = await account("2300", "Employee Payable", "liability_current_other");
  const deductionsId = await account("2110", "Payroll Deductions", "liability_current_other");
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         jsonb_set(
           jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', '{"payroll": true}'::jsonb),
           '{payroll}',
           ${JSON.stringify({ wageExpenseAccountId: wageId, netPayAccountId: netId, countries: ["IT"] })}::jsonb
         ),
         '{controlAccounts}',
         ${JSON.stringify({ payrollDeductions: deductionsId })}::jsonb
       )
     where id = ${org.orgId}`);
  await db.execute(sql`
    update subsidiaries set base_currency = 'EUR', country = 'IT', name = 'Roma HQ'
     where org_id = ${org.orgId} and id = ${org.subsidiaryId}`);
  await seedPayrollComponents(org.orgId, actorId, "IT");
  // Tenant-deliberated surtax rates: synthetic, not any comune's real figure.
  await upsertStatutoryRate({
    orgId: org.orgId, actorId, rates: IT_PACK_RATES,
    rateKey: "it_addizionale_regionale", region: REGION, filingAccountId: null,
    taxYear: TAX_YEAR, values: { rate: "1.5" },
  });
  await upsertStatutoryRate({
    orgId: org.orgId, actorId, rates: IT_PACK_RATES,
    rateKey: "it_addizionale_comunale", region: REGION, subRegion: COMUNE,
    filingAccountId: null, taxYear: TAX_YEAR, values: { rate: "0.8" },
  });
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end, pay_date_offset_days,
       subsidiary_id, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'IT monthly', 'monthly', 12, '2025-01-31', 3,
            ${org.subsidiaryId}, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, scheduleId };
}

async function makeEmployee(
  orgId: string, subsidiaryId: string, actorId: string, scheduleId: string,
  name: string, annualRate: string, answers: Record<string, string>,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${orgId}, 'person', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${orgId}, ${id})`);
  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis, is_active,
       created_by, updated_by)
    values (${orgId}, ${id}, ${scheduleId}, 'IT', ${REGION}, 'salary', true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates
      (org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from, is_active,
       created_by, updated_by)
    values (${orgId}, ${id}, 'EUR', ${annualRate}, 'year', '2080', '2025-01-01', true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_tax_certificates
      (org_id, employee_party_id, country, certificate_key, region, sub_region,
       answers, effective_from, created_by, updated_by)
    values (${orgId}, ${id}, 'IT', 'it_detrazioni', null, null,
            ${JSON.stringify(answers)}::jsonb, '2025-01-01'::date, ${actorId}, ${actorId})`);
  return id;
}

async function payAndCommit(
  orgId: string, actorId: string, scheduleId: string,
  periodStart: string, periodEnd: string, payDate: string,
): Promise<string> {
  const run = await createPayRun({
    orgId, actorId, payScheduleId: scheduleId, periodStart, periodEnd, payDate,
  });
  const calc = await calculatePayRun({ orgId, actorId, documentId: run.documentId });
  assert.deepEqual(calc.errors, []);
  await commitPayRun({ orgId, documentId: run.documentId, actorId });
  return run.documentId;
}

export interface CuTieOutExpectation {
  redditi: string;
  irpef: string;
  addreg: string;
  inps: string;
  ti: string;
  imponibile: string;
}

/** Every committed IT stub line in the year, keyed for the tie-out. */
async function committedLineSums(orgId: string): Promise<Map<string, CuTieOutExpectation>> {
  const rows = (await db.execute<{
    employee_party_id: string; kind: string; system_key: string | null; taxable: boolean | null;
    amount: string; pensionable: string;
  }>(sql`
    select s.employee_party_id, l.kind, pc.system_key, pc.taxable,
           l.amount::text as amount, s.pensionable_earnings::text as pensionable
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
                     and r.run_status = 'committed'
      join pay_stub_lines l on l.org_id = ${orgId} and l.stub_id = s.id
      join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
     where s.org_id = ${orgId} and s.tax_year = ${TAX_YEAR} and s.country = 'IT'
  `)).rows;
  const byEmployee = new Map<string, {
    redditi: string; irpef: string; addreg: string; inps: string; ti: string;
    imponibile: string; seenPensionable: Set<string>;
  }>();
  const entry = (id: string) => {
    let found = byEmployee.get(id);
    if (!found) {
      found = {
        redditi: "0", irpef: "0", addreg: "0", inps: "0", ti: "0",
        imponibile: "0", seenPensionable: new Set<string>(),
      };
      byEmployee.set(id, found);
    }
    return found;
  };
  for (const row of rows) {
    const acc = entry(String(row.employee_party_id));
    if (row.kind === "earning" && (row.taxable ?? true)) {
      acc.redditi = add(acc.redditi, String(row.amount));
    }
    if (row.kind === "deduction" && row.system_key === "income_tax") {
      acc.irpef = add(acc.irpef, String(row.amount));
    }
    if (row.kind === "deduction" && row.system_key === "regional_surtax") {
      acc.addreg = add(acc.addreg, String(row.amount));
    }
    if (row.kind === "deduction" && row.system_key === "inps") {
      acc.inps = add(acc.inps, String(row.amount));
    }
    if (row.system_key === "ti_payout") {
      acc.ti = add(acc.ti, String(row.amount));
    }
  }
  const pensionable = (await db.execute<{ employee_party_id: string; pensionable: string }>(sql`
    select s.employee_party_id, sum(s.pensionable_earnings)::text as pensionable
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
                     and r.run_status = 'committed'
     where s.org_id = ${orgId} and s.tax_year = ${TAX_YEAR} and s.country = 'IT'
     group by s.employee_party_id
  `)).rows;
  for (const row of pensionable) {
    entry(String(row.employee_party_id)).imponibile = String(row.pensionable ?? "0");
  }
  return new Map([...byEmployee.entries()].map(([id, acc]) => [id, {
    redditi: acc.redditi, irpef: acc.irpef, addreg: acc.addreg,
    inps: acc.inps, ti: acc.ti, imponibile: acc.imponibile,
  }]));
}

function cuFiling() {
  const filing = IT_PACK_FILINGS.yearEnd.find((entry) => entry.key === "cu");
  assert.ok(filing, "IT pack declares the cu filing");
  return filing;
}

test(
  "CU population ties to committed runs to the cent and excludes drafts",
  { skip: !DB },
  async () => {
    const { orgId, actorId, scheduleId } = await seedOrg();
    const sub = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgId} and parent_id is null`)).rows[0]!.id;
    const empA = await makeEmployee(orgId, sub, actorId, scheduleId, "Alba Indeterminata", "36000", {
      domicilio_comune: COMUNE,
    });
    const empB = await makeEmployee(orgId, sub, actorId, scheduleId, "Bruno Determinato", "24000", {
      domicilio_comune: COMUNE, tempo_determinato: "true",
    });
    await payAndCommit(orgId, actorId, scheduleId, "2025-01-01", "2025-01-31", "2025-02-03");
    await payAndCommit(orgId, actorId, scheduleId, "2025-02-01", "2025-02-28", "2025-03-03");
    // A third run, calculated but never committed: statutory money exists on
    // its stubs and must not reach the filing.
    const draft = await createPayRun({
      orgId, actorId, payScheduleId: scheduleId,
      periodStart: "2025-03-01", periodEnd: "2025-03-31", payDate: "2025-04-03",
    });
    const draftCalc = await calculatePayRun({ orgId, actorId, documentId: draft.documentId });
    assert.deepEqual(draftCalc.errors, []);
    const draftIrpef = (await db.execute<{ amount: string }>(sql`
      select coalesce(sum(l.amount), 0)::text as amount
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
        join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
       where s.org_id = ${orgId} and s.pay_run_document_id = ${draft.documentId}
         and l.kind = 'deduction' and pc.system_key = 'income_tax'
    `)).rows[0]!.amount;
    assert.ok(cmp(draftIrpef, "0") > 0, "the draft run withholds real IRPEF, so its exclusion is proven");

    const filing = cuFiling();
    const data = await filing.population(orgId, TAX_YEAR);
    assert.equal(data.rows.length, 2, "two employees aggregate, neither run reports alone");
    const byId = new Map(data.rows.map((row) => [String(row.rowId), row]));
    assert.ok(byId.has(empA) && byId.has(empB), "row ids are the two employee ids");

    // parseRowId round-trips every emitted row id, and refuses a foreign one.
    for (const rowId of byId.keys()) {
      const scope = parseCuRowId(rowId);
      assert.deepEqual(scope, { employees: [rowId], accounts: [] });
      assert.deepEqual(filing.parseRowId(rowId), scope);
    }
    assert.equal(filing.parseRowId("not-a-cu-row"), null);

    // The tie-out: an independent line-sum query matches every box to the cent.
    const expected = await committedLineSums(orgId);
    for (const [id, want] of expected) {
      const row = byId.get(id);
      assert.ok(row, `population carries employee ${id}`);
      assert.equal(cmp(String(row.redditi), want.redditi), 0, `redditi ties for ${row.employee}`);
      assert.equal(cmp(String(row.irpef), want.irpef), 0, `IRPEF ties for ${row.employee}`);
      assert.equal(cmp(String(row.addRegionale), want.addreg), 0, `addizionale regionale ties for ${row.employee}`);
      assert.equal(cmp(String(row.inpsWorker), want.inps), 0, `INPS ties for ${row.employee}`);
      assert.equal(cmp(String(row.imponibileInps), want.imponibile), 0, `imponibile ties for ${row.employee}`);
      assert.equal(cmp(String(row.trattamentoIntegrativo), want.ti), 0, `TI ties for ${row.employee}`);
    }
    // Hand-computed anchor, independent of both queries: monthly salaries of
    // 3.000 (A) and 2.000 (B) across two runs certify 6.000 and 4.000 of
    // redditi — salary earnings are fully taxable, and the TI/somma credits
    // never enter punti 1/2.
    assert.equal(cmp(String(byId.get(empA)!.redditi), "6000"), 0, "A certifies two months of 3.000");
    assert.equal(cmp(String(byId.get(empB)!.redditi), "4000"), 0, "B certifies two months of 2.000");
    assert.equal(byId.get(empA)!.contratto, "tempo indeterminato");
    assert.equal(byId.get(empB)!.contratto, "tempo determinato");
    // The draft's money is really absent: population IRPEF plus the draft's
    // IRPEF equals every stub's IRPEF including the draft.
    const allIrpef = (await db.execute<{ amount: string }>(sql`
      select coalesce(sum(l.amount), 0)::text as amount
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
        join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
       where s.org_id = ${orgId} and s.tax_year = ${TAX_YEAR} and s.country = 'IT'
         and l.kind = 'deduction' and pc.system_key = 'income_tax'
    `)).rows[0]!.amount;
    const popIrpef = [...byId.values()].reduce((acc, row) => add(acc, String(row.irpef)), "0");
    assert.equal(cmp(add(popIrpef, draftIrpef), allIrpef), 0, "draft IRPEF is outside the filing");

    // The slip carries the authority's own punto numbers and ties to the row.
    assert.ok(filing.slip, "CU slip declared");
    const slipA = await filing.slip.build(orgId, TAX_YEAR, empA);
    const boxesA = new Map(slipA.boxes.map((box) => [box.code, box.value]));
    assert.equal(boxesA.get("1"), String(byId.get(empA)!.redditi));
    assert.ok(!boxesA.has("2"));
    assert.equal(boxesA.get("21"), String(byId.get(empA)!.irpef));
    assert.equal(boxesA.get("22"), String(byId.get(empA)!.addRegionale));
    assert.equal(boxesA.get("INPS-4"), String(byId.get(empA)!.imponibileInps));
    assert.equal(boxesA.get("INPS-6"), String(byId.get(empA)!.inpsWorker));
    const slipB = await filing.slip.build(orgId, TAX_YEAR, empB);
    const boxesB = new Map(slipB.boxes.map((box) => [box.code, box.value]));
    assert.equal(boxesB.get("2"), String(byId.get(empB)!.redditi));
    assert.ok(!boxesB.has("1"));
    await assert.rejects(
      filing.slip.build(orgId, TAX_YEAR, "00000000-0000-0000-0000-000000000000"),
      /no 2025 Certificazione Unica/,
    );
  },
);

test(
  "CU population refuses a year with no committed runs by name",
  { skip: !DB },
  async () => {
    const { orgId } = await seedOrg();
    const filing = cuFiling();
    await assert.rejects(
      filing.population(orgId, TAX_YEAR),
      /no committed IT pay stubs/,
    );
  },
);
