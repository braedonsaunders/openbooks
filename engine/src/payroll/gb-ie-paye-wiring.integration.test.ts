import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../platform/db.ts";
import {
  calculatePayRun,
  commitPayRun,
  createPayRun,
  seedPayrollComponents,
} from "./run.ts";
import {
  ensurePackSlotRoleAccounts,
  packSlotState,
  setPackSlotAccount,
} from "./packs.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} from "../testing/fixtures.ts";
import "../testing/database-bypass.ts";

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
  country: string,
  province: string,
  rate: string,
  currency: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${orgId}, 'person', ${`Emp ${country}`}, ${subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${orgId}, ${id})`);
  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis, is_active,
       created_by, updated_by)
    values (${orgId}, ${id}, ${scheduleId}, ${country}, ${province}, 'salary', true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates
      (org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from, is_active,
       created_by, updated_by)
    values (${orgId}, ${id}, ${currency}, ${rate}, 'year', '2080', '2026-01-01', true,
            ${actorId}, ${actorId})`);
  return id;
}

async function fileCertificate(
  orgId: string,
  employeeId: string,
  actorId: string,
  country: string,
  key: string,
  answers: Record<string, string>,
  effectiveFrom: string,
): Promise<void> {
  await db.execute(sql`
    insert into employee_tax_certificates
      (org_id, employee_party_id, country, certificate_key, region, sub_region,
       answers, effective_from, created_by, updated_by)
    values (${orgId}, ${employeeId}, ${country}, ${key}, null, null,
            ${JSON.stringify(answers)}::jsonb, ${effectiveFrom}::date, ${actorId}, ${actorId})`);
}

test(
  "GB and IE payrolls post withheld tax to the role-resolved deductions account",
  { skip: !DB },
  async () => {
    // One org running both packs — the topology that fused them: GB and IE
    // both seeded a component with code PAYE / system key paye, pay_components
    // is unique on (org, code) and (org, system key, kind), so the second
    // install never seeded its row and its runs pushed onto the first pack's
    // component. The GB row was mapped to the subcontractor-payable account
    // (2130), so Irish PAYE posted to a vendor liability.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deductionsId = await makeAccount(org.orgId, actorId, "2110", "Payroll Deductions", "liability_current_other");
      const subcontractorId = await makeAccount(org.orgId, actorId, "2130", "Subcontractor Payable", "liability_payable");
      const wageId = await makeAccount(org.orgId, actorId, "6000", "Wages & Salaries", "expense");
      const netId = await makeAccount(org.orgId, actorId, "2300", "Employee Payable", "liability_current_other");
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(
             jsonb_set(
               jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', '{"payroll": true}'::jsonb),
               '{payroll}',
               ${JSON.stringify({ wageExpenseAccountId: wageId, netPayAccountId: netId, countries: ["GB", "IE"] })}::jsonb
             ),
             '{controlAccounts}',
             ${JSON.stringify({ payrollDeductions: deductionsId })}::jsonb
           )
         where id = ${org.orgId}`);

      // GB first, then IE — the install order that swallowed the IE row.
      await seedPayrollComponents(org.orgId, actorId, "GB");
      await seedPayrollComponents(org.orgId, actorId, "IE");

      // Defect C: IE seeds its own PAYE component — distinct code and system
      // key from the GB row, owned by the IE pack.
      const components = (await db.execute<{
        id: string; code: string; country: string | null; system_key: string | null; kind: string;
        liability_account_id: string | null;
      }>(sql`
        select id, code, country, system_key, kind, liability_account_id from pay_components
         where org_id = ${org.orgId} and country in ('GB', 'IE') order by code, kind`)).rows;
      const gbPayeRow = components.find((c) => c.code === "PAYE");
      const iePayeRow = components.find((c) => c.code === "IEPAYE");
      assert.ok(gbPayeRow, "GB PAYE component seeded");
      assert.ok(iePayeRow, "IE PAYE component seeded");
      assert.equal(gbPayeRow.country, "GB");
      assert.equal(iePayeRow.country, "IE");
      assert.equal(gbPayeRow.system_key, "paye");
      assert.equal(iePayeRow.system_key, "ie_paye");

      // Defect B: both packs' withheld-tax slots resolve to the chart's
      // payroll-deductions account BY ROLE — 2110 here, never the
      // subcontractor-payable 2130 the GB row used to point at. The wiring
      // happens at install (no hand mapping), and an explicit mapping would
      // still win because only null rows are filled.
      assert.equal(gbPayeRow.liability_account_id, deductionsId);
      assert.equal(iePayeRow.liability_account_id, deductionsId);
      const gbSlots = await packSlotState(org.orgId, ["GB"], {});
      const ieSlots = await packSlotState(org.orgId, ["IE"], {});
      assert.equal(gbSlots.find((p) => p.country === "GB")!.slots.find((s) => s.key === "paye")!.accountId, deductionsId);
      assert.equal(gbSlots.find((p) => p.country === "GB")!.slots.find((s) => s.key === "nic")!.accountId, deductionsId);
      assert.equal(ieSlots.find((p) => p.country === "IE")!.slots.find((s) => s.key === "paye")!.accountId, deductionsId);

      // GB leg: monthly £3,000 on a 1257L cumulative code (starter A, second
      // tax month — mirrors the certified P6/P9 round trip).
      await db.execute(sql`
        update subsidiaries set base_currency = 'GBP', country = 'GB', name = 'London HQ'
         where org_id = ${org.orgId} and id = ${org.subsidiaryId}`);
      const gbScheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules
          (id, org_id, name, frequency, periods_per_year, anchor_period_end, pay_date_offset_days,
           subsidiary_id, is_active, created_by, updated_by)
        values (${gbScheduleId}, ${org.orgId}, 'GB monthly', 'monthly', 12, '2026-04-01', 0,
                ${org.subsidiaryId}, true, ${actorId}, ${actorId})`);
      const gbEmployee = await makeEmployee(org.orgId, org.subsidiaryId, actorId, gbScheduleId, "GB", "ENG", "36000", "GBP");
      await fileCertificate(org.orgId, gbEmployee, actorId, "GB", "gb_tax_code_notice", { tax_code: "1257L" }, "2026-04-06");
      await fileCertificate(org.orgId, gbEmployee, actorId, "GB", "gb_starter_checklist", { starter_declaration: "A" }, "2026-04-06");
      const gbRun = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: gbScheduleId,
        periodStart: "2026-05-01", periodEnd: "2026-05-31", payDate: "2026-06-05",
      });
      const gbCalc = await calculatePayRun({ orgId: org.orgId, actorId, documentId: gbRun.documentId });
      assert.deepEqual(gbCalc.errors, []);
      const gbStubRows = (await db.execute<{ id: string; gross: string }>(sql`
        select id, gross::text as gross from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${gbRun.documentId}
           and employee_party_id = ${gbEmployee}`)).rows;
      assert.equal(gbStubRows.length, 1);
      assert.equal(gbStubRows[0]!.gross, "3000.0000");
      const gbStubLines = (await db.execute<{
        component_id: string | null; system_key: string | null; kind: string; amount: string;
      }>(sql`
        select l.component_id, c.system_key, l.kind, l.amount::text as amount
          from pay_stub_lines l join pay_components c on c.id = l.component_id
         where l.org_id = ${org.orgId} and l.stub_id = ${gbStubRows[0]!.id}
         order by l.sequence`)).rows;
      const gbPayeLine = gbStubLines.find((line) => line.system_key === "paye" && line.kind === "deduction");
      const gbNicEeLine = gbStubLines.find((line) => line.system_key === "nic" && line.kind === "deduction");
      const gbNicErLine = gbStubLines.find((line) => line.system_key === "nic" && line.kind === "employer_contribution");
      assert.ok(gbPayeLine && gbNicEeLine && gbNicErLine, "GB PAYE and both NIC shares assessed");
      // The stub lines ride the GB components — the rows the GB slots map.
      assert.equal(gbPayeLine.component_id, gbPayeRow.id);
      // PAYE prices above zero through the product (its exact arithmetic is
      // pinned against HMRC's worked examples in the GB parity suite). NIC is
      // hand arithmetic off the transcribed 2026/27 thresholds: employee 8%
      // above the £1,048 primary threshold, employer 15% above the £417
      // secondary threshold, on £3,000 monthly pay.
      assert.ok(Number(gbPayeLine.amount) > 0, "GB PAYE assessed");
      assert.equal(Number(gbNicEeLine.amount).toFixed(2), "156.16");
      assert.equal(Number(gbNicErLine.amount).toFixed(2), "387.45");
      await commitPayRun({ orgId: org.orgId, documentId: gbRun.documentId, actorId });
      const gbLines = (await db.execute<{ account_id: string; number: string; amount: string }>(sql`
        select l.account_id, a.number, l.amount::text as amount from document_lines l
          join accounts a on a.id = l.account_id
         where l.org_id = ${org.orgId} and l.document_id = ${gbRun.documentId}`)).rows;
      const gbTotalCents = gbLines.reduce((sum, line) => sum + Math.round(Number(line.amount) * 100), 0);
      assert.equal(gbTotalCents, 0);
      // Credits (negative legs) are the only money the run owes anyone: net
      // pay to the employee account, every withholding to the deductions
      // account. Nothing withheld may land anywhere else.
      const gbCredits = gbLines.filter((line) => Number(line.amount) < 0);
      assert.deepEqual(
        [...new Set(gbCredits.map((line) => line.account_id))].sort(),
        [deductionsId, netId].sort(),
      );
      const gbWithheldTotal = gbCredits
        .filter((line) => line.account_id === deductionsId)
        .reduce((sum, line) => sum + Number(line.amount), 0);
      assert.equal(
        gbWithheldTotal.toFixed(2),
        (-(Number(gbPayeLine.amount) + Number(gbNicEeLine.amount) + Number(gbNicErLine.amount))).toFixed(2),
      );
      assert.ok(
        gbLines.every((line) => line.account_id !== subcontractorId),
        "no GB payroll line touches the subcontractor-payable account",
      );

      // IE leg: weekly €850 in week 1, cumulative, single-person RPN — Mark's
      // hand-worked €93.85 PAYE pins the arithmetic independently of routing.
      const ieSubId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                  is_elimination, is_active, custom)
        values (${ieSubId}, ${org.orgId}, ${org.subsidiaryId}, 'Dublin branch', 'EUR', 'IE',
                '{}'::jsonb, false, true, '{}'::jsonb)`);
      const ieScheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules
          (id, org_id, name, frequency, periods_per_year, anchor_period_end, pay_date_offset_days,
           subsidiary_id, is_active, created_by, updated_by)
        values (${ieScheduleId}, ${org.orgId}, 'IE weekly', 'weekly', 52, '2026-01-04', 0,
                ${ieSubId}, true, ${actorId}, ${actorId})`);
      const ieEmployee = await makeEmployee(org.orgId, ieSubId, actorId, ieScheduleId, "IE", "IE", "44200", "EUR");
      await fileCertificate(org.orgId, ieEmployee, actorId, "IE", "ie_rpn", {
        tax_credits_total: "4000", rate_band_total: "44000", pay_basis: "cumulative",
      }, "2026-01-01");
      const ieRun = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: ieScheduleId,
        periodStart: "2025-12-29", periodEnd: "2026-01-04", payDate: "2026-01-04",
      });
      const ieCalc = await calculatePayRun({ orgId: org.orgId, actorId, documentId: ieRun.documentId });
      assert.deepEqual(ieCalc.errors, []);
      const ieStubRows = (await db.execute<{ id: string; gross: string }>(sql`
        select id, gross::text as gross from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${ieRun.documentId}
           and employee_party_id = ${ieEmployee}`)).rows;
      assert.equal(ieStubRows.length, 1);
      assert.equal(ieStubRows[0]!.gross, "850.0000");
      const ieStubLines = (await db.execute<{
        component_id: string | null; system_key: string | null; kind: string; amount: string;
      }>(sql`
        select l.component_id, c.system_key, l.kind, l.amount::text as amount
          from pay_stub_lines l join pay_components c on c.id = l.component_id
         where l.org_id = ${org.orgId} and l.stub_id = ${ieStubRows[0]!.id}
         order by l.sequence`)).rows;
      const iePayeLine = ieStubLines.find((line) => line.system_key === "ie_paye" && line.kind === "deduction");
      const iePrsiEeLine = ieStubLines.find((line) => line.system_key === "prsi" && line.kind === "deduction");
      const iePrsiErLine = ieStubLines.find((line) => line.system_key === "prsi" && line.kind === "employer_contribution");
      const ieUscLine = ieStubLines.find((line) => line.system_key === "usc" && line.kind === "deduction");
      assert.ok(iePayeLine && iePrsiEeLine && iePrsiErLine && ieUscLine, "IE PAYE, PRSI shares and USC assessed");
      // The stub line rides the IE component — not the GB row the unfused
      // pack used to share with it.
      assert.equal(iePayeLine.component_id, iePayeRow.id);
      // Mark's hand-worked example: €850/wk at week 1 with €4,000 credits and
      // a €44,000 band is €93.85 PAYE. PRSI is hand arithmetic off the
      // transcribed weekly class-A rates: employee 4.2% of the full €850 is
      // €35.70; employer 11.25% of €850 is €95.625, rounded half-up to the
      // cent the engine prices in (January edition, A1).
      assert.equal(Number(iePayeLine.amount).toFixed(2), "93.85");
      assert.equal(Number(iePrsiEeLine.amount).toFixed(2), "35.70");
      assert.equal(Number(iePrsiErLine.amount).toFixed(2), "95.63");
      assert.ok(Number(ieUscLine.amount) > 0, "USC assessed");
      await commitPayRun({ orgId: org.orgId, documentId: ieRun.documentId, actorId });
      const ieLines = (await db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, amount::text as amount from document_lines
         where org_id = ${org.orgId} and document_id = ${ieRun.documentId}`)).rows;
      const ieTotalCents = ieLines.reduce((sum, line) => sum + Math.round(Number(line.amount) * 100), 0);
      assert.equal(ieTotalCents, 0);
      const ieCredits = ieLines.filter((line) => Number(line.amount) < 0);
      assert.deepEqual(
        [...new Set(ieCredits.map((line) => line.account_id))].sort(),
        [deductionsId, netId].sort(),
      );
      const ieWithheldTotal = ieCredits
        .filter((line) => line.account_id === deductionsId)
        .reduce((sum, line) => sum + Number(line.amount), 0);
      assert.equal(
        ieWithheldTotal.toFixed(3),
        (-(Number(iePayeLine.amount) + Number(iePrsiEeLine.amount)
          + Number(iePrsiErLine.amount) + Number(ieUscLine.amount))).toFixed(3),
      );
      assert.ok(
        ieLines.every((line) => line.account_id !== subcontractorId),
        "no IE payroll line touches the subcontractor-payable account",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a slot mapping with no seeded components is refused, and an explicit mapping survives role wiring",
  { skip: !DB },
  async () => {
    // Mapping a slot whose components were never seeded used to report
    // success while the slot stayed unmapped — the setup surface showed ok
    // and the value was not there afterwards. And once mapped, the
    // operator's choice must win over the role default on every later
    // ensure: role wiring completes setup, it never re-points a liability.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deductionsId = await makeAccount(org.orgId, actorId, "2110", "Payroll Deductions", "liability_current_other");
      const otherId = await makeAccount(org.orgId, actorId, "2120", "Other Payroll Liabilities", "liability_current_other");
      await db.execute(sql`
        update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts}',
          ${JSON.stringify({ payrollDeductions: deductionsId })}::jsonb)
         where id = ${org.orgId}`);

      await assert.rejects(
        () => setPackSlotAccount(org.orgId, actorId, "GB", "paye", deductionsId),
        /no seeded payroll components/,
      );

      await seedPayrollComponents(org.orgId, actorId, "GB");
      // Install wired the slot from the role (no hand mapping involved).
      const wired = (await db.execute<{ liability_account_id: string | null }>(sql`
        select liability_account_id from pay_components
         where org_id = ${org.orgId} and code = 'PAYE'`)).rows[0]!.liability_account_id;
      assert.equal(wired, deductionsId);

      // The operator re-points the slot; later ensures must not move it.
      await setPackSlotAccount(org.orgId, actorId, "GB", "paye", otherId);
      await ensurePackSlotRoleAccounts(db, org.orgId, actorId, "GB");
      const kept = (await db.execute<{ liability_account_id: string | null }>(sql`
        select liability_account_id from pay_components
         where org_id = ${org.orgId} and code = 'PAYE'`)).rows[0]!.liability_account_id;
      assert.equal(kept, otherId);
      const state = await packSlotState(org.orgId, ["GB"], {});
      assert.equal(state.find((p) => p.country === "GB")!.slots.find((s) => s.key === "paye")!.accountId, otherId);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
