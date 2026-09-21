import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp } from "../money/money.ts";
import { es111Quarters, es111Slip, es190Slips, es190Slip } from "./es/yearend.ts";
import { esPackFilings } from "./es/filings.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

/**
 * The ES 190/111 populations over committed pay runs.
 *
 * Fixture: one ES org, two employees (Ana, Bruno; provincia MD), two
 * COMMITTED 2026 runs (Q1 pay 2026-01-31 with both employees; Q3 pay
 * 2026-09-30 with Ana only — across the 10-September edition split, so the
 * annual box proves the sum-across-editions shape) plus one DRAFT Q2 run
 * (Bruno, 9999.99) that must never appear on a statutory filing.
 *
 * Amounts are exact decimals carried as text; the tie-out asserts the
 * populations equal the stub lines to the cent — a filing that does not tie
 * is worse than no filing.
 *
 * DB-owned: skipped without OPENBOOKS_DB_URL (unit partition). Written to
 * the standard; the gate executes.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface EsFixture {
  orgId: string;
  anaId: string;
  brunoId: string;
}

async function seedEsFilingFixture(): Promise<EsFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
      payroll: { countries: ["ES"] },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "ES");
  const components = (await db.execute<{ id: string; code: string }>(sql`
    select id, code from pay_components where org_id = ${org.orgId} and code in ('BASE', 'IRPF')
  `)).rows;
  const baseId = components.find((c) => c.code === "BASE")!.id;
  const irpfId = components.find((c) => c.code === "IRPF")!.id;

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Mensual', 'monthly', 12, '2026-01-31', 0, true,
            ${actorId}, ${actorId})`);

  const employee = async (name: string): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${id}, ${org.orgId}, 'person', ${name}, ${org.subsidiaryId}, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${id})`);
    await db.execute(sql`
      insert into employee_payroll_profiles
        (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis, is_active,
         created_by, updated_by)
      values (${org.orgId}, ${id}, ${scheduleId}, 'ES', 'MD', 'salary', true,
              ${actorId}, ${actorId})`);
    return id;
  };
  const anaId = await employee("Ana Trabajadora");
  const brunoId = await employee("Bruno Trabajador");

  const run = async (
    payDate: string, status: "committed" | "calculated",
    lines: { employeeId: string; gross: string; irpf: string }[],
  ): Promise<void> => {
    const documentId = randomUUID();
    await db.execute(sql`
      insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                             currency, status, created_by, updated_by)
      values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
              ${org.subsidiaryId}, ${payDate}, 'EUR', 'approved', ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                            tax_year, run_status, calculated_at, created_by, updated_by)
      values (${documentId}, ${org.orgId}, ${scheduleId}, ${payDate}, ${payDate}, ${payDate},
              2026, ${status}, now(), ${actorId}, ${actorId})`);
    for (const line of lines) {
      const stubId = randomUUID();
      await db.execute(sql`
        insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                               periods_per_year, pay_date, tax_year, country, country_source,
                               currency_code, gross, net_pay, created_by, updated_by)
        values (${stubId}, ${org.orgId}, ${documentId}, ${line.employeeId}, 'MD',
                12, ${payDate}, 2026, 'ES', 'calculation',
                'EUR', ${line.gross}, ${line.gross}, ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, hours, amount,
                                    sequence, created_by, updated_by)
        values (${org.orgId}, ${stubId}, ${baseId}, 'earning', 'Base pay',
                null, ${line.gross}, 10, ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, hours, amount,
                                    sequence, created_by, updated_by)
        values (${org.orgId}, ${stubId}, ${irpfId}, 'deduction', 'IRPF withholding',
                null, ${line.irpf}, 110, ${actorId}, ${actorId})`);
    }
  };

  // Q1 committed: both employees. Q3 committed: Ana only (across the
  // September edition split). Q2 draft: Bruno's 9999.99 must not file.
  await run("2026-01-31", "committed", [
    { employeeId: anaId, gross: "2000.00", irpf: "270.20" },
    { employeeId: brunoId, gross: "3000.00", irpf: "500.00" },
  ]);
  await run("2026-09-30", "committed", [
    { employeeId: anaId, gross: "2000.00", irpf: "270.20" },
  ]);
  await run("2026-05-31", "calculated", [
    { employeeId: brunoId, gross: "9999.99", irpf: "999.99" },
  ]);
  return { orgId: org.orgId, anaId, brunoId };
}

test(
  "190 population aggregates two employees across two committed runs and excludes the draft",
  { skip: !DB },
  async () => {
    const fx = await seedEsFilingFixture();
    try {
      const slips = await es190Slips(fx.orgId, 2026);
      assert.equal(slips.length, 2);
      const ana = slips.find((s) => s.employeePartyId === fx.anaId)!;
      const bruno = slips.find((s) => s.employeePartyId === fx.brunoId)!;
      // Ana: two months across the edition split; Bruno: one month. The Q2
      // draft (9999.99) appears in neither — a draft on a filing is a wrong filing.
      assert.equal(cmp(String(ana.percepcionIntegra), "4000.00"), 0);
      assert.equal(cmp(String(ana.retencionesPracticadas), "540.40"), 0);
      assert.equal(cmp(String(bruno.percepcionIntegra), "3000.00"), 0);
      assert.equal(cmp(String(bruno.retencionesPracticadas), "500.00"), 0);
      // Tie-out by a second method: independent SQL over the same stubs.
      const totals = (await db.execute<{ percepcion: string; retencion: string }>(sql`
        select sum(case when pc.system_key is distinct from 'irpf' and l.kind = 'earning'
                        then l.amount else 0 end)::text as percepcion,
               sum(case when pc.system_key = 'irpf' then l.amount else 0 end)::text as retencion
          from pay_stub_lines l
          join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${fx.orgId} and s.tax_year = 2026 and s.country = 'ES'
           and r.run_status = 'committed'`)).rows[0]!;
      const slipTotal = slips.reduce((acc, s) => add(acc, s.percepcionIntegra), "0");
      const taxTotal = slips.reduce((acc, s) => add(acc, s.retencionesPracticadas), "0");
      assert.equal(slipTotal, totals.percepcion);
      assert.equal(taxTotal, totals.retencion);
      assert.equal(cmp(String(slipTotal), "7000.00"), 0);
      assert.equal(cmp(String(taxTotal), "1040.40"), 0);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "111 population aggregates quarters off pay dates; the draft quarter is absent",
  { skip: !DB },
  async () => {
    const fx = await seedEsFilingFixture();
    try {
      const quarters = await es111Quarters(fx.orgId, 2026);
      assert.deepEqual(quarters.map((q) => q.quarter), [1, 3]);
      const q1 = quarters[0]!;
      assert.equal(q1.perceptores, 2);
      assert.equal(cmp(String(q1.percepciones), "5000.00"), 0);
      assert.equal(cmp(String(q1.retenciones), "770.20"), 0);
      const q3 = quarters[1]!;
      assert.equal(q3.perceptores, 1);
      assert.equal(cmp(String(q3.percepciones), "2000.00"), 0);
      assert.equal(cmp(String(q3.retenciones), "270.20"), 0);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "parseRowId round-trips every emitted row id and refuses foreign ones",
  { skip: !DB },
  async () => {
    const fx = await seedEsFilingFixture();
    try {
      const filings = esPackFilings();
      const byKey = new Map(filings.yearEnd.map((f) => [f.key, f]));
      const data190 = await byKey.get("190")!.population(fx.orgId, 2026);
      assert.ok(data190.rows.length > 0, 'data190.rows must emit rows for this round-trip to mean anything');
      for (const row of data190.rows) {
        const scope = byKey.get("190")!.parseRowId(String(row.rowId));
        assert.ok(scope, `190 must parse its own row ${row.rowId}`);
        assert.equal(scope!.employees.length, 1);
      }
      const data111 = await byKey.get("111")!.population(fx.orgId, 2026);
      assert.ok(data111.rows.length > 0, 'data111.rows must emit rows for this round-trip to mean anything');
      for (const row of data111.rows) {
        const scope = byKey.get("111")!.parseRowId(String(row.rowId));
        assert.ok(scope, `111 must parse its own row ${row.rowId}`);
      }
      // Both directions: foreign ids parse to null through the declarations.
      assert.equal(byKey.get("190")!.parseRowId("Q1"), null);
      assert.equal(byKey.get("111")!.parseRowId(`${fx.anaId}:MD`), null);
      assert.equal(byKey.get("190")!.parseRowId(fx.anaId), null);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "slips render the statutory boxes with the authority's own labels",
  { skip: !DB },
  async () => {
    const fx = await seedEsFilingFixture();
    try {
      const slip = await es190Slip(fx.orgId, 2026, `${fx.anaId}:MD`);
      assert.equal(slip.formCode, "ES_CERT_RET");
      const byCode = new Map(slip.boxes.map((b) => [b.code, b]));
      assert.equal(cmp(String(byCode.get("dinerarias-integro")?.value), "4000.00"), 0);
      assert.equal(cmp(String(byCode.get("dinerarias-retenciones")?.value), "540.40"), 0);
      assert.ok(
        slip.headerFields.some((h) => h.value.includes("sin subclave")),
        "the slip must state the clave-A-no-subclave classification it files under",
      );
      const q1 = await es111Slip(fx.orgId, 2026, "Q1");
      const boxes111 = new Map(q1.boxes.map((b) => [b.code, b]));
      assert.equal(boxes111.get("01")?.value, "2");
      assert.equal(cmp(String(boxes111.get("02")?.value), "5000.00"), 0);
      assert.equal(cmp(String(boxes111.get("03")?.value), "770.20"), 0);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a year with no committed runs refuses by name instead of printing an empty slip",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`
        update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
          payroll: { countries: ["ES"] },
        })}::jsonb where id = ${org.orgId}`);
      await assert.rejects(() => es190Slips(org.orgId, 2026), /no committed ES pay stubs for tax year 2026/);
      await assert.rejects(() => es111Quarters(org.orgId, 2026), /no committed ES pay stubs for tax year 2026/);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a year the pack's tables do not cover refuses by name",
  { skip: !DB },
  async () => {
    const fx = await seedEsFilingFixture();
    try {
      // This tree transcribes 2026 only (keep/payroll-es-priors is unmerged):
      // 2025 must refuse rather than file off untranscribed tables.
      await assert.rejects(() => es190Slips(fx.orgId, 2025), /2025 statutory tables are not loaded for ES/);
      await assert.rejects(() => es111Quarters(fx.orgId, 2025), /2025 statutory tables are not loaded for ES/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
