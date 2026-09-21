/**
 * AU STP finalisation: the populated declaration, reconciled to committed runs.
 *
 * DB-OWNED. Fixture: Sydney Worker paid across TWO committed fortnightly
 * runs (run 1: 80h regular + 10h overtime at 1.5x; run 2: 80h regular) and
 * Melbourne Worker paid across the same two runs (80h each, no overtime),
 * plus a THIRD run that is calculated but never committed and must be
 * excluded. Expected figures are hand-derived from the transcribed Schedule
 * 1 scale 2 (fortnightly, resident claiming the threshold, no STSL — pure
 * `calculateAu2027`: $2400/fn withholds $404.00, $2850/fn withholds
 * $550.00) and 12% SG on the pensionable leg ($2400 → $288.00,
 * $2850 → $342.00).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { normalizeMoney, sum } from "../money/money.ts";
import { auPackFilings } from "./filings.ts";
import { parseStpFinalisationRowId, stpReportableGross } from "./stp-figures.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { setPackSlotAccount } from "./packs.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const money = (value: string): string => normalizeMoney(value);

test(
  "AU STP finalisation reconciles two employees across two committed runs and excludes the draft",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await db.execute(sql`
        insert into currencies (code, name, minor_units)
        values ('AUD', 'Australian Dollar', 2)
        on conflict (code) do nothing`);
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
      const paygPayable = await account("2310", "PAYG withholding payable", "liability_current");
      const superPayable = await account("2320", "Superannuation payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          features: { payroll: true },
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            wagesTo: "expense",
            countries: ["AU"],
          },
        })}::jsonb where id = ${org.orgId}`);

      await seedPayrollComponents(org.orgId, actorId, "AU");
      await setPackSlotAccount(org.orgId, actorId, "AU", "payg", paygPayable);
      await setPackSlotAccount(org.orgId, actorId, "AU", "super", superPayable);

      const auSubId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                  is_elimination, is_active, custom)
        values (${auSubId}, ${org.orgId}, ${org.subsidiaryId}, 'AU Entity', 'AUD', 'AU',
                '{}'::jsonb, false, true, '{}'::jsonb)`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, subsidiary_id, is_active,
                                   created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Fortnightly AU', 'biweekly', 26, '2026-07-18', 3,
                ${auSubId}, true, ${actorId}, ${actorId})`);

      const overtimeTypeId = randomUUID();
      await db.execute(sql`
        insert into time_types (id, org_id, name, classification, cost_multiplier, created_by, updated_by)
        values (${overtimeTypeId}, ${org.orgId}, 'Overtime', 'overtime', '1.5', ${actorId}, ${actorId})`);

      const seedEmployee = async (name: string, province: string) => {
        const employeeId = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
          values (${employeeId}, ${org.orgId}, 'person', ${name}, ${auSubId}, true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                        is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, 'AUD', '30', 'hour', '2026-07-01', true, ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                                 province, pay_basis, vacation_percent,
                                                 vacation_method, is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${scheduleId}, 'AU', ${province}, 'hourly', '0',
                  'accrue', true, ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into employee_tax_certificates (id, org_id, employee_party_id, country, certificate_key,
                                                 answers, created_by, updated_by)
          values (${randomUUID()}, ${org.orgId}, ${employeeId}, 'AU', 'au_tfn_declaration',
                  ${JSON.stringify({
                    tax_file_number: "123456782",
                    residency: "australian_resident",
                    working_holiday_maker: "false",
                    tax_free_threshold: "true",
                    stsl_debt: "false",
                  })}::jsonb, ${actorId}, ${actorId})`);
        return employeeId;
      };
      const sydneyId = await seedEmployee("Sydney Worker", "NSW");
      const melbourneId = await seedEmployee("Melbourne Worker", "VIC");

      const timeEntry = async (
        employeeId: string, workedOn: string, hours: number, timeTypeId: string | null,
      ) => {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, time_type_id, status,
                                    is_billable, billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${workedOn}, ${hours}, ${timeTypeId}, 'approved', false,
                  'unbilled', 'actual', ${actorId}, ${actorId})`);
      };
      // Run 1 (2026-07-05 – 18): Sydney 80h regular + 10h overtime, Melbourne 80h.
      for (const workedOn of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await timeEntry(sydneyId, workedOn, 20, null);
        await timeEntry(melbourneId, workedOn, 20, null);
      }
      await timeEntry(sydneyId, "2026-07-12", 10, overtimeTypeId);
      // Run 2 (2026-07-19 – 08-01): both 80h regular.
      for (const workedOn of ["2026-07-20", "2026-07-22", "2026-07-24", "2026-07-28"]) {
        await timeEntry(sydneyId, workedOn, 20, null);
        await timeEntry(melbourneId, workedOn, 20, null);
      }
      // Run 3 (2026-08-02 – 15): calculated, NEVER committed — the exclusion proof.
      for (const workedOn of ["2026-08-03", "2026-08-05", "2026-08-07", "2026-08-11"]) {
        await timeEntry(sydneyId, workedOn, 20, null);
        await timeEntry(melbourneId, workedOn, 20, null);
      }

      const filing = auPackFilings().yearEnd.find((entry) => entry.key === "stp_finalisation")!;

      const run1 = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      assert.deepEqual(
        (await calculatePayRun({ orgId: org.orgId, documentId: run1.documentId, actorId })).errors, [],
      );

      // A year with calculated-but-uncommitted work has nothing to declare.
      await assert.rejects(
        filing.population(org.orgId, 2027),
        (error: unknown) => {
          assert.ok(error instanceof PayrollPackError);
          assert.match((error as Error).message, /no committed AU pay runs/);
          return true;
        },
      );

      await commitPayRun({ orgId: org.orgId, documentId: run1.documentId, actorId });
      const run2 = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-19", periodEnd: "2026-08-01",
      });
      assert.deepEqual(
        (await calculatePayRun({ orgId: org.orgId, documentId: run2.documentId, actorId })).errors, [],
      );
      await commitPayRun({ orgId: org.orgId, documentId: run2.documentId, actorId });
      const run3 = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-08-02", periodEnd: "2026-08-15",
      });
      assert.deepEqual(
        (await calculatePayRun({ orgId: org.orgId, documentId: run3.documentId, actorId })).errors, [],
      );

      const committed = (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from pay_runs
         where org_id = ${org.orgId} and run_status = 'committed'`)).rows[0]!.count;
      assert.equal(committed, "2", "exactly two runs committed — the third stays a draft");

      // The tie-out: hand-derived engine figures, to the cent.
      const data = await filing.population(org.orgId, 2027);
      assert.equal(data.rows.length, 2, "one row per employee, aggregated across runs");
      const byId = new Map(data.rows.map((row) => [row.rowId as string, row]));
      const sydney = byId.get(sydneyId)!;
      const melbourne = byId.get(melbourneId)!;
      assert.deepEqual(
        {
          gross: money(sydney.gross as string),
          overtime: money(sydney.overtime as string),
          bonuses: money(sydney.bonuses as string),
          paidLeave: money(sydney.paidLeave as string),
          payg: money(sydney.payg as string),
          sg: money(sydney.sg as string),
          sacrifice: money(sydney.sacrifice as string),
        },
        {
          gross: money("5250"), overtime: money("450"), bonuses: money("0"),
          paidLeave: money("0"), payg: money("954"), sg: money("630"), sacrifice: money("0"),
        },
        "Sydney: 2850 + 2400 gross, 450 overtime, 550 + 404 PAYG, 342 + 288 SG",
      );
      assert.deepEqual(
        {
          gross: money(melbourne.gross as string),
          overtime: money(melbourne.overtime as string),
          payg: money(melbourne.payg as string),
          sg: money(melbourne.sg as string),
        },
        { gross: money("4800"), overtime: money("0"), payg: money("808"), sg: money("576") },
        "Melbourne: 2400 + 2400 gross, 404 + 404 PAYG, 288 + 288 SG",
      );

      // The cross-check: an INDEPENDENTLY WRITTEN query (flat left-join with
      // case sums, not the population's per-stub correlated subqueries) over
      // the same committed stubs must agree to the cent — and must not see
      // the draft run's $2400-per-employee either.
      const check = (await db.execute<Record<string, unknown>>(sql`
        select s.employee_party_id,
               sum(case when l.kind = 'earning' then l.amount else 0 end) as gross,
               sum(case when l.kind = 'earning' and pc.system_key = 'overtime'
                        then l.amount else 0 end) as overtime,
               sum(case when l.kind = 'deduction' and pc.system_key = 'payg_withholding'
                        then l.amount else 0 end) as payg,
               sum(case when l.kind = 'employer_contribution' and pc.system_key = 'super_guarantee'
                        then l.amount else 0 end) as sg,
               sum(s.pensionable_earnings) as ote
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
                           and r.run_status = 'committed'
          left join pay_stub_lines l on l.stub_id = s.id and l.org_id = s.org_id
          left join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
         where s.org_id = ${org.orgId} and s.tax_year = 2027 and s.country = 'AU'
         group by s.employee_party_id
      `));
      assert.equal(check.rows.length, 2);
      for (const row of check.rows) {
        const populated = byId.get(String(row.employee_party_id))!;
        assert.ok(populated, "cross-check employee is a populated row");
        assert.equal(money(populated.gross as string), money(String(row.gross)));
        assert.equal(money(populated.overtime as string), money(String(row.overtime)));
        assert.equal(money(populated.payg as string), money(String(row.payg)));
        assert.equal(money(populated.sg as string), money(String(row.sg)));
      }
      const checkGross = money(sum(check.rows.map((row) => String(row.gross))));
      assert.equal(checkGross, money("10050"), "draft run's 4800 is nowhere in the totals");

      // parseRowId round-trips every emitted row and refuses foreign ones.
      for (const row of data.rows) {
        assert.deepEqual(
          filing.parseRowId(row.rowId as string),
          { employees: [row.rowId], accounts: [] },
        );
        assert.deepEqual(parseStpFinalisationRowId(row.rowId as string), filing.parseRowId(row.rowId as string));
      }
      assert.equal(filing.parseRowId("not-a-uuid"), null);
      assert.equal(filing.parseRowId(`${sydneyId}:${melbourneId}`), null);

      // The slip carries the STP vocabulary with the derivation intact.
      const slip = await filing.slip!.build(org.orgId, 2027, sydneyId);
      assert.equal(slip.formCode, "AU_STP");
      const box = new Map(slip.boxes.map((entry) => [entry.code, entry.value as string]));
      assert.equal(money(box.get("GROSS")!), money("5250"));
      assert.equal(money(box.get("OT")!), money("450"));
      assert.equal(money(box.get("PAYG")!), money("954"));
      assert.equal(money(box.get("SG")!), money("630"));
      assert.equal(
        money(box.get("GROSS-STP")!),
        money(stpReportableGross({
          gross: "5250", overtime: "450", bonusesCommissions: "0", paidLeave: "0",
        })),
        "STP-reportable gross is the total less separately-itemised overtime",
      );
      await assert.rejects(
        filing.slip!.build(org.orgId, 2027, randomUUID()),
        /no 2027 STP finalisation figures match/,
      );

      // Correction and transmission gaps are named, with real remedies.
      assert.equal(filing.amendment.supported, false);
      if (filing.amendment.supported === false) {
        assert.match(filing.amendment.refusal, /update event/i);
        assert.match(filing.amendment.refusal, /STP-enabled/i);
      }
      assert.match(filing.downloadRefusal!, /no ATO file/i);

      // A year the pack's tables do not cover refuses by name, not as an empty form.
      await assert.rejects(filing.population(org.orgId, 2026), /2026/);
      await assert.rejects(filing.population(org.orgId, 2025), /2025/);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
