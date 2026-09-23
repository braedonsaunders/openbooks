/**
 * IE PAYE Modernisation reconciliation — DB-owned assertions.
 *
 * Fixture: two employees (Aoife €44,200, Brendan €31,200) across two
 * committed weekly runs — March (pre-October PRSI edition) and November
 * (post-October edition) — plus a calculated-but-DRAFT November run whose
 * figures must NOT appear. The tie-out recomputes every population figure
 * with an independently written flat-join query (no correlated subselects,
 * no stub factors for the tax lines), so a wrong join in the population
 * cannot agree with itself.
 *
 * DB tests written to the standard, not executed on this machine: the Mac
 * is reserved for producing code and all gating runs on a separate machine.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PAYROLL_COUNTRY_PACKS, setPackSlotAccount } from "../packs.ts";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { withSimClock } from "../../platform/clock.ts";
import { db } from "../../platform/db.ts";
import { add, cmp } from "../../money/money.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { seedPayrollComponents } from "../run-setup.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} from "../../testing/fixtures.ts";
import "../../testing/database-bypass.ts";
import {
  IE_PAYE_RECONCILIATION_FILING,
  iePayeReconciliation,
  parseIeReconciliationRowId,
} from "./filings.ts";
import { orgYearEndFilings } from "../yearend.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function makeAccount(
  orgId: string,
  actorId: string,
  number: string,
  name: string,
  type: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_active, is_summary, created_by, updated_by)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, true, false, ${actorId}, ${actorId})`);
  return id;
}

async function makeEmployee(
  orgId: string,
  subsidiaryId: string,
  actorId: string,
  scheduleId: string,
  name: string,
  rate: string,
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
    values (${orgId}, ${id}, ${scheduleId}, 'IE', 'IE', 'salary', true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates
      (org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from, is_active,
       created_by, updated_by)
    values (${orgId}, ${id}, 'EUR', ${rate}, 'year', '2080', '2026-01-01', true,
            ${actorId}, ${actorId})`);
  return id;
}

async function fileRpn(
  orgId: string,
  employeeId: string,
  actorId: string,
  credits: string,
  band: string,
): Promise<void> {
  await db.execute(sql`
    insert into employee_tax_certificates
      (org_id, employee_party_id, country, certificate_key, region, sub_region,
       answers, effective_from, created_by, updated_by)
    values (${orgId}, ${employeeId}, 'IE', 'ie_rpn', null, null,
            ${JSON.stringify({ tax_credits_total: credits, rate_band_total: band, pay_basis: "cumulative" })}::jsonb,
            '2026-01-01'::date, ${actorId}, ${actorId})`);
}

test(
  "IE reconciliation aggregates two employees across two committed runs, priced by pay date",
  // This scenario must straddle the 1 October 2026 PRSI edition change, so
  // its later run is a November 2026 period. createPayRun refuses a period
  // that has not begun, so the body pins business "today" past mid-November
  // 2026 through withSimClock (Guard 2 reads businessToday, which follows
  // the pinned clock) instead of waiting for the calendar.
  { skip: !DB },
  async () => {
    await withSimClock("2026-11-20", async () => {
      const org = await createScratchOrg();
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      try {
        const deductionsId = await makeAccount(org.orgId, actorId, "2110", "Payroll Deductions", "liability_current_other");
        const wageId = await makeAccount(org.orgId, actorId, "6000", "Wages & Salaries", "expense");
        const netId = await makeAccount(org.orgId, actorId, "2300", "Employee Payable", "liability_current_other");
        await db.execute(sql`
          update orgs
             set settings = jsonb_set(
               jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', '{"payroll": true}'::jsonb),
               '{payroll}',
               ${JSON.stringify({ wageExpenseAccountId: wageId, netPayAccountId: netId, countries: ["IE"] })}::jsonb
             )
           where id = ${org.orgId}`);
        await db.execute(sql`
          update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts}',
            ${JSON.stringify({ payrollDeductions: deductionsId })}::jsonb) where id = ${org.orgId}`);
        await db.execute(sql`
          update subsidiaries set base_currency = 'EUR', country = 'IE', name = 'Dublin HQ'
           where org_id = ${org.orgId} and id = ${org.subsidiaryId}`);
        await seedPayrollComponents(org.orgId, actorId, "IE");
        // Statutory slots declare no liabilityAccountRole, so seeding alone leaves
        // every deduction unmapped and run-commit refuses the run. Map them all to
        // the payroll-deductions control account, as the IT settlement fixture does.
        for (const slot of PAYROLL_COUNTRY_PACKS.IE!.statutorySlots) {
          await setPackSlotAccount(org.orgId, actorId, "IE", slot.key, deductionsId);
        }

        const scheduleId = randomUUID();
        await db.execute(sql`
          insert into pay_schedules
            (id, org_id, name, frequency, periods_per_year, anchor_period_end, pay_date_offset_days,
             subsidiary_id, is_active, created_by, updated_by)
          values (${scheduleId}, ${org.orgId}, 'IE weekly', 'weekly', 52, '2026-01-04', 0,
                  ${org.subsidiaryId}, true, ${actorId}, ${actorId})`);
        const aoife = await makeEmployee(org.orgId, org.subsidiaryId, actorId, scheduleId, "Aoife Byrne", "44200");
        const brendan = await makeEmployee(org.orgId, org.subsidiaryId, actorId, scheduleId, "Brendan Doyle", "31200");
        await fileRpn(org.orgId, aoife, actorId, "4000", "44000");
        await fileRpn(org.orgId, brendan, actorId, "3300", "40000");

        // Run 1: week of 2–8 March 2026 — pre-October PRSI edition.
        const run1 = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: "2026-03-02", periodEnd: "2026-03-08", payDate: "2026-03-08",
        });
        assert.deepEqual((await calculatePayRun({ orgId: org.orgId, actorId, documentId: run1.documentId })).errors, []);
        await commitPayRun({ orgId: org.orgId, documentId: run1.documentId, actorId });
        // Run 2: week of 9–15 November 2026 — post-October PRSI edition.
        const run2 = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: "2026-11-09", periodEnd: "2026-11-15", payDate: "2026-11-15",
        });
        assert.deepEqual((await calculatePayRun({ orgId: org.orgId, actorId, documentId: run2.documentId })).errors, []);
        await commitPayRun({ orgId: org.orgId, documentId: run2.documentId, actorId });
        // Run 3: calculated but NEVER committed — a draft must not appear on a
        // statutory surface. Deliberately large so inclusion cannot hide.
        const run3 = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: "2026-11-16", periodEnd: "2026-11-22", payDate: "2026-11-22",
        });
        assert.deepEqual((await calculatePayRun({ orgId: org.orgId, actorId, documentId: run3.documentId })).errors, []);

        const rows = await iePayeReconciliation(org.orgId, 2026);
        // Two employees aggregate; the draft run contributes no third row and
        // no second filing account.
        assert.equal(rows.length, 2);
        const byName = new Map(rows.map((row) => [row.employeeName, row]));
        const a = byName.get("Aoife Byrne");
        const b = byName.get("Brendan Doyle");
        assert.ok(a && b, "both employees reconcile");
        assert.ok(cmp(a.grossPay, b.grossPay) !== 0, "distinct pay reconciles distinctly");

        // The October step is priced by pay date: March PRSI sits entirely in
        // the pre columns, November PRSI entirely in the post columns.
        const march = (await db.execute<{ ee: string; er: string }>(sql`
          select (select coalesce(sum(l.amount), 0) from pay_stub_lines l
                   join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                  where l.org_id = ${org.orgId} and l.stub_id = s.id and l.kind = 'deduction'
                    and pc.system_key = 'prsi')::text as ee,
                 (select coalesce(sum(l.amount), 0) from pay_stub_lines l
                   join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                  where l.org_id = ${org.orgId} and l.stub_id = s.id and l.kind = 'employer_contribution'
                    and pc.system_key = 'prsi')::text as er
            from pay_stubs s join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
           where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run1.documentId}
             and s.employee_party_id = ${aoife} and r.run_status = 'committed'`)).rows[0]!;
        assert.equal(cmp(a.prsiEmployeePre, march.ee), 0);
        assert.equal(cmp(a.prsiEmployerPre, march.er), 0);
        assert.ok(cmp(a.prsiEmployeePost, "0") !== 0, "November PRSI posts post-October");

        // Independent tie-out: a flat join over the same committed stubs —
        // different shape from the population's correlated subselects — must
        // agree to the cent on every figure, for every employee.
        type OracleRow = {
          employee: string; gross: string; paye: string;
          pre_ee: string; post_ee: string; pre_er: string; post_er: string; usc: string;
        };
        const oracle = (await db.execute<OracleRow>(sql`
          select s.employee_party_id as employee,
                 sum(case when l.kind = 'earning' then l.amount else 0 end)::text as gross,
                 sum(case when pc.system_key = 'ie_paye' and l.kind = 'deduction'
                          then l.amount else 0 end)::text as paye,
                 sum(case when pc.system_key = 'prsi' and l.kind = 'deduction'
                            and s.pay_date < '2026-10-01'::date
                          then l.amount else 0 end)::text as pre_ee,
                 sum(case when pc.system_key = 'prsi' and l.kind = 'deduction'
                            and s.pay_date >= '2026-10-01'::date
                          then l.amount else 0 end)::text as post_ee,
                 sum(case when pc.system_key = 'prsi' and l.kind = 'employer_contribution'
                            and s.pay_date < '2026-10-01'::date
                          then l.amount else 0 end)::text as pre_er,
                 sum(case when pc.system_key = 'prsi' and l.kind = 'employer_contribution'
                            and s.pay_date >= '2026-10-01'::date
                          then l.amount else 0 end)::text as post_er,
                 sum(case when pc.system_key = 'usc' and l.kind = 'deduction'
                          then l.amount else 0 end)::text as usc
            from pay_stub_lines l
            join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
            join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
            join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
              and r.run_status = 'committed'
            join documents d on d.id = r.document_id and d.org_id = r.org_id
              and d.status <> 'voided'
           where l.org_id = ${org.orgId} and s.tax_year = 2026 and s.country = 'IE'
           group by s.employee_party_id`)).rows;
        assert.equal(oracle.length, 2, "the draft run is excluded from the oracle too");
        const bases = (await db.execute<{ employee: string; taxable: string; reckonable: string }>(sql`
          select s.employee_party_id as employee,
                 sum(coalesce((s.factors->>'IE_TAXBASE')::numeric, 0))::text as taxable,
                 sum(s.pensionable_earnings)::text as reckonable
            from pay_stubs s
            join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
              and r.run_status = 'committed'
            join documents d on d.id = r.document_id and d.org_id = r.org_id
              and d.status <> 'voided'
           where s.org_id = ${org.orgId} and s.tax_year = 2026 and s.country = 'IE'
           group by s.employee_party_id`)).rows;
        for (const row of rows) {
          const o = oracle.find((r) => r.employee === row.employeePartyId);
          const base = bases.find((r) => r.employee === row.employeePartyId);
          assert.ok(o && base, `oracle covers ${row.employeeName}`);
          for (const [actual, expected, field] of [
            [row.grossPay, o.gross, "grossPay"],
            [row.paye, o.paye, "paye"],
            [row.prsiEmployeePre, o.pre_ee, "prsiEmployeePre"],
            [row.prsiEmployeePost, o.post_ee, "prsiEmployeePost"],
            [row.prsiEmployerPre, o.pre_er, "prsiEmployerPre"],
            [row.prsiEmployerPost, o.post_er, "prsiEmployerPost"],
            [row.usc, o.usc, "usc"],
            [row.taxablePay, base.taxable, "taxablePay"],
            [row.reckonablePay, base.reckonable, "reckonablePay"],
          ] as const) {
            assert.equal(cmp(actual, expected ?? "0"), 0, `${row.employeeName}.${field} ties to the runs`);
          }
          // Every emitted row id parses back to its owner through the
          // declaration the subsidiary-scope guard reads.
          const scope = parseIeReconciliationRowId(`${row.employeePartyId}:${row.filingAccountId ?? ""}`);
          assert.deepEqual(scope?.employees, [row.employeePartyId]);
        }
        assert.equal(parseIeReconciliationRowId("not-an-ie-row"), null);

        // Employer-side tie: the filing totals are what the year's ROS
        // submissions must sum to — they equal the oracle's column sums.
        const data = await IE_PAYE_RECONCILIATION_FILING.population(org.orgId, 2026);
        assert.equal(data.rows.length, 2);
        const sum = (pick: (r: OracleRow) => string): string =>
          oracle.reduce((acc, r) => add(acc, pick(r)), "0");
        const totalOf = (label: string): string =>
          data.totals?.find((t) => t.label === label)?.value ?? "missing";
        assert.equal(cmp(totalOf("PAYE"), sum((r) => r.paye)), 0);
        assert.equal(cmp(totalOf("USC"), sum((r) => r.usc)), 0);
        assert.equal(
          cmp(
            totalOf("PRSI (employee + employer)"),
            add(
              add(sum((r) => r.pre_ee), sum((r) => r.post_ee)),
              add(sum((r) => r.pre_er), sum((r) => r.post_er)),
            ),
          ),
          0,
        );
        assert.equal(totalOf("Employees"), "2");
      } finally {
        await dropScratchOrgReporting(org.orgId);
      }
    });
  },
);

test(
  "IE reconciliation refuses an empty year by name",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await seedPayrollComponents(org.orgId, actorId, "IE");
      await assert.rejects(
        iePayeReconciliation(org.orgId, 2026),
        /no committed IE pay stubs for tax year 2026/,
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "IE reconciliation refuses a year the pack does not publish, through the generic enumeration",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const sections = await orgYearEndFilings(org.orgId, 2025);
      const ie = sections.filter((section) => section.country === "IE");
      assert.equal(ie.length, 1);
      assert.match(ie[0]!.populationRefusal ?? "", /2025 statutory tables are not loaded for IE/);
      assert.deepEqual(ie[0]!.data.rows, []);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
