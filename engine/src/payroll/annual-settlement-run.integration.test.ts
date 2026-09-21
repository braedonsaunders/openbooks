import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp, neg } from "../money/money.ts";
import { IT_PACK_RATES } from "./it/rates.ts";
import { IT_PAYROLL_PACK } from "./it/pack.ts";
import { payRunBankFilePopulation } from "./bank-file.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { payrollRemittanceSummary } from "./remittance.ts";
import { setPackSlotAccount } from "./packs.ts";
import { upsertStatutoryRate } from "./statutory-rates.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

/**
 * Annual settlement wiring: the run layer invokes the pack's declared
 * settlement on the final period of the pack's tax year.
 *
 * Italy's conguaglio (art. 23 c. 3 DPR 600/1973) is the proving pack: its
 * compute is pinned without a database beside the pack, and these tests
 * prove the WIRING end to end — committed year-to-date priors in, pushed
 * lines on the December stub, journal balanced, remittance tied, bank-file
 * population whole. Hand-worked figures come from the pack's own settlement
 * tests (engine/src/payroll/it/conguaglio.test.ts), never asserted against
 * the wiring itself:
 *
 * - mid-year joiner, 4000 x 6: IRPEF delta -3979.16 (refund credit),
 *   regionale -0.01, comunale 0 (pushes nothing);
 * - bonus year, 2500 x 11 + December 2500 + 5000 one-off: IRPEF +1668.74
 *   (collection deduction), regionale +51.24, comunale +33.32;
 * - level full year, 2000 x 12: IRPEF dust +0.04, regionale dust -0.01,
 *   comunale exactly zero (no line) — dust settles per the pack's law, so
 *   "zero" here means no material settlement and no comunale line, asserted
 *   exactly rather than as an absence.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const MONTHS_2026 = [
  ["2026-01-01", "2026-01-31"],
  ["2026-02-01", "2026-02-28"],
  ["2026-03-01", "2026-03-31"],
  ["2026-04-01", "2026-04-30"],
  ["2026-05-01", "2026-05-31"],
  ["2026-06-01", "2026-06-30"],
  ["2026-07-01", "2026-07-31"],
  ["2026-08-01", "2026-08-31"],
  ["2026-09-01", "2026-09-30"],
  ["2026-10-01", "2026-10-31"],
  ["2026-11-01", "2026-11-30"],
  ["2026-12-01", "2026-12-31"],
] as const;

interface Harness {
  orgId: string;
  actorId: string;
  scheduleId: string;
  bonusComponentId: string;
}

async function seedHarness(orgId: string, actorId: string): Promise<Harness> {
  const account = async (number: string, name: string, type: string) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                            reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false,
              '[]'::jsonb, '{}'::jsonb, true)`);
    return id;
  };
  const wageExpense = await account("6000", "Wages expense", "expense");
  const burdenExpense = await account("6010", "Payroll burden", "expense");
  const netPayable = await account("2300", "Wages payable", "liability_current");
  const itPayable = await account("2310", "Erario F24 payable", "liability_current");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        taxPayableAccountId: itPayable,
        wagesTo: "expense",
        countries: ["IT"],
      },
    })}::jsonb where id = ${orgId}`);
  await seedPayrollComponents(orgId, actorId, "IT");
  await setPackSlotAccount(orgId, actorId, "IT", "irpef", itPayable);
  await setPackSlotAccount(orgId, actorId, "IT", "addizionale_regionale", itPayable);
  await setPackSlotAccount(orgId, actorId, "IT", "addizionale_comunale", itPayable);
  await setPackSlotAccount(orgId, actorId, "IT", "inps", itPayable);

  const root = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null and is_active
     order by created_at limit 1`)).rows[0]!.id;
  const itSubId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                              is_elimination, is_active, custom)
    values (${itSubId}, ${orgId}, ${root}, 'Italy Entity', 'EUR', 'IT',
            '{}'::jsonb, false, true, '{}'::jsonb)`);

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, subsidiary_id, is_active,
                               created_by, updated_by)
    values (${scheduleId}, ${orgId}, 'Monthly IT', 'monthly', 12, '2026-01-31', 0,
            ${itSubId}, true, ${actorId}, ${actorId})`);

  // Domicile-deliberated addizionali, the same 1,23% / 0,8% the pack's own
  // settlement tests price against.
  await upsertStatutoryRate({
    orgId, actorId, rates: IT_PACK_RATES, rateKey: "it_addizionale_regionale",
    region: "03", filingAccountId: null, taxYear: 2026, values: { rate: "1.23" },
  });
  await upsertStatutoryRate({
    orgId, actorId, rates: IT_PACK_RATES, rateKey: "it_addizionale_comunale",
    region: "03", subRegion: "H501", filingAccountId: null, taxYear: 2026,
    values: { rate: "0.8" },
  });

  const bonus = (await db.execute<{ id: string }>(sql`
    select id from pay_components
     where org_id = ${orgId} and code = 'BONUS' and kind = 'earning' and system_key = 'bonus'`));
  assert.equal(bonus.rows.length, 1, "shared BONUS component seeded");
  return { orgId, actorId, scheduleId, bonusComponentId: bonus.rows[0]!.id };
}

async function seedEmployee(
  fx: Harness, name: string, annualRate: string, opts: { eft?: boolean } = {},
): Promise<string> {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${fx.orgId}, 'person', ${name}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, 'EUR', ${annualRate}, 'year', 2080, '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                           province, pay_basis, is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${fx.scheduleId}, 'IT', '03', 'salary',
            true, ${fx.actorId}, ${fx.actorId})`);
  // The detrazioni declaration, domiciled in Roma (H501): the monthly engine
  // and the settlement read the same answers, so refusal parity is structural.
  await db.execute(sql`
    insert into employee_tax_certificates (id, org_id, employee_party_id, country, certificate_key,
                                           answers, created_by, updated_by)
    values (${randomUUID()}, ${fx.orgId}, ${employeeId}, 'IT', 'it_detrazioni',
            ${JSON.stringify({ domicilio_comune: "H501" })}::jsonb, ${fx.actorId}, ${fx.actorId})`);
  if (opts.eft) {
    await db.execute(sql`
      insert into party_bank_accounts (org_id, party_id, bank_name, country, currency,
                                       account_last_four, approval_status, is_active,
                                       created_by, updated_by)
      values (${fx.orgId}, ${employeeId}, 'Test Bank', 'IT', 'EUR', '1234', 'approved', true,
              ${fx.actorId}, ${fx.actorId})`);
  }
  return employeeId;
}

async function addLineAdjustment(
  fx: Harness, documentId: string, employeeId: string, amount: string,
): Promise<void> {
  await db.execute(sql`
    insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                     adjustment_type, component_id, amount,
                                     created_by, updated_by)
    values (${fx.orgId}, ${documentId}, ${employeeId}, 'line', ${fx.bonusComponentId}, ${amount},
            ${fx.actorId}, ${fx.actorId})`);
}

async function calculateMonthly(
  fx: Harness, monthIndex: number, opts: { commit?: boolean } = {},
): Promise<string> {
  const [start, end] = MONTHS_2026[monthIndex]!;
  const run = await createPayRun({
    orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
    periodStart: start, periodEnd: end, payDate: end,
  });
  const result = await calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
  assert.deepEqual(result.errors, [], `month ${monthIndex + 1} calculates clean`);
  if (opts.commit !== false) {
    await commitPayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
  }
  return run.documentId;
}

type StubLine = {
  system_key: string | null;
  kind: string;
  description: string;
  amount: string;
  sequence: number;
};

async function stubLines(orgId: string, documentId: string, employeeId: string): Promise<StubLine[]> {
  const rows = (await db.execute<StubLine>(sql`
    select c.system_key, l.kind, l.description, l.amount::text as amount, l.sequence
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where l.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
       and s.employee_party_id = ${employeeId}
     order by l.sequence, l.description`));
  return rows.rows;
}

async function stubFactors(orgId: string, documentId: string, employeeId: string)
  : Promise<Record<string, string>> {
  const rows = (await db.execute<{ factors: Record<string, string> }>(sql`
    select factors from pay_stubs
     where org_id = ${orgId} and pay_run_document_id = ${documentId}
       and employee_party_id = ${employeeId}`));
  assert.equal(rows.rows.length, 1, "one stub for the employee on the run");
  return rows.rows[0]!.factors;
}

const settlementTuples = (lines: StubLine[]) =>
  lines
    .filter((line) => /conguaglio/i.test(line.description))
    .map((line) => [line.system_key, line.kind, line.amount, line.sequence]);

test(
  "a committed December run settles the year: refund, collection, and dust",
  { skip: !DB },
  async () => {
    assert.ok(IT_PAYROLL_PACK.annualSettlement, "Italy declares a settlement in this tree");
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const fx = await seedHarness(org.orgId, actorId);
      // Level full year (dust), bonus year (collection), credit-band year
      // (nonzero TI/somma through the generic keys) from January; the
      // mid-year joiner (refund) from July.
      const dust = await seedEmployee(fx, "Livia Livello", "24000");
      const bonus = await seedEmployee(fx, "Bruno Bonus", "30000");
      const credit = await seedEmployee(fx, "Tina Trattamento", "14400");
      for (let month = 0; month < 6; month++) await calculateMonthly(fx, month);
      const joiner = await seedEmployee(fx, "Giulia Joiner", "48000", { eft: true });
      for (let month = 6; month < 11; month++) await calculateMonthly(fx, month);
      const novemberId = await calculateMonthly(fx, 10);

      // November is an ordinary month: no settlement line, no settlement
      // factor — the wiring must be byte-identical outside the final period.
      for (const employeeId of [dust, bonus, credit, joiner]) {
        const lines = await stubLines(org.orgId, novemberId, employeeId);
        assert.deepEqual(settlementTuples(lines), [], "no conguaglio line outside December");
        const factors = await stubFactors(org.orgId, novemberId, employeeId);
        assert.ok(
          !Object.keys(factors).some((key) => key.startsWith("CONG_")),
          "no settlement factor outside December",
        );
      }

      // A calculated-but-uncommitted December bonus draft for the joiner: its
      // withholding must NOT enter the settlement's year-to-date, or an
      // employee's refund would move when somebody recalculates a draft.
      const draftBonus = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-12-01", periodEnd: "2026-12-31", payDate: "2026-12-31",
        runType: "bonus",
      });
      await addLineAdjustment(fx, draftBonus.documentId, joiner, "20000");
      const draftResult = await calculatePayRun({
        orgId: fx.orgId, documentId: draftBonus.documentId, actorId,
      });
      assert.deepEqual(draftResult.errors, [], "draft bonus calculates clean");
      const draftLines = await stubLines(org.orgId, draftBonus.documentId, joiner);
      const draftWithheld = draftLines
        .filter((line) => line.system_key === "income_tax")
        .map((line) => line.amount)
        .reduce((acc, amount) => add(acc, amount), "0.0000");
      assert.ok(cmp(draftWithheld, "0") > 0, "the draft withholds something worth excluding");

      // December regular: the bonus-year employee's one-off lands here, so
      // the final run prices 2500 + 5000 exactly like the pack's own fixture.
      const december = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-12-01", periodEnd: "2026-12-31", payDate: "2026-12-31",
      });
      await addLineAdjustment(fx, december.documentId, bonus, "5000");
      const decResult = await calculatePayRun({
        orgId: fx.orgId, documentId: december.documentId, actorId,
      });
      assert.deepEqual(decResult.errors, [], "December calculates clean — no settlement refusal");

      // The refund: over-withheld IRPEF returns as a credit, regionale dust
      // as a credit, comunale exactly zero pushes nothing.
      assert.deepEqual(settlementTuples(await stubLines(org.orgId, december.documentId, joiner)), [
        ["income_tax", "credit", "3979.1600", 110],
        ["regional_surtax", "credit", "0.0100", 115],
      ]);
      const joinerFactors = await stubFactors(org.orgId, december.documentId, joiner);
      assert.equal(joinerFactors["CONG_IRPEF_ANNUAL"], "1534.7200");
      assert.equal(joinerFactors["CONG_IRPEF_YTD"], "5513.8800");
      assert.equal(joinerFactors["CONG_IRPEF_DELTA"], "-3979.1600");
      assert.equal(joinerFactors["CONG_ADDCOM_DELTA"], "0.0000");

      // The collection: under-withheld IRPEF collects as a deduction.
      assert.deepEqual(settlementTuples(await stubLines(org.orgId, december.documentId, bonus)), [
        ["income_tax", "deduction", "1668.7400", 110],
        ["regional_surtax", "deduction", "51.2400", 115],
        ["municipal_surtax", "deduction", "33.3200", 120],
      ]);
      const bonusFactors = await stubFactors(org.orgId, december.documentId, bonus);
      assert.equal(bonusFactors["CONG_IRPEF_ANNUAL"], "5042.0800");
      assert.equal(bonusFactors["CONG_IRPEF_YTD"], "3373.3400");
      assert.equal(bonusFactors["CONG_IRPEF_DELTA"], "1668.7400");

      // The level year: only cent dust settles, and the comunale line — whose
      // delta is exactly zero — is absent, not a zero line.
      assert.deepEqual(settlementTuples(await stubLines(org.orgId, december.documentId, dust)), [
        ["income_tax", "deduction", "0.0400", 110],
        ["regional_surtax", "credit", "0.0100", 115],
      ]);
      const dustFactors = await stubFactors(org.orgId, december.documentId, dust);
      assert.equal(dustFactors["CONG_ADDCOM_DELTA"], "0.0000");

      // The credit keys ride the generic map: the settlement's TI/somma paid
      // figures reconcile to the committed stub lines AND to the monthly
      // factors, so they were supplied, not defaulted.
      for (const employeeId of [dust, bonus, credit, joiner]) {
        const factors = await stubFactors(org.orgId, december.documentId, employeeId);
        for (const key of ["ti_payout", "somma_payout"] as const) {
          const lineSum = (await db.execute<{ total: string }>(sql`
            select coalesce(sum(l.amount), 0)::text as total
              from pay_stub_lines l
              join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
              join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
              join pay_components c on c.id = l.component_id and c.org_id = l.org_id
             where s.org_id = ${org.orgId} and s.employee_party_id = ${employeeId}
               and s.tax_year = 2026 and r.run_status = 'committed'
               and c.system_key = ${key}`)).rows[0]!.total;
          const factorKey = key === "ti_payout" ? "CONG_TI_PAID" : "CONG_SOMMA_PAID";
          assert.equal(
            factors[factorKey], lineSum,
            `${factorKey} carries the committed ${key} lines`,
          );
        }
      }
      // Recalculation is stable: stubs are replaced wholesale, so a second
      // calculate settles the same figures, never a second layer.
      await calculatePayRun({ orgId: fx.orgId, documentId: december.documentId, actorId });
      const joinerAgain = await stubFactors(org.orgId, december.documentId, joiner);
      assert.equal(joinerAgain["CONG_IRPEF_DELTA"], "-3979.1600");
      assert.deepEqual(settlementTuples(await stubLines(org.orgId, december.documentId, joiner)), [
        ["income_tax", "credit", "3979.1600", 110],
        ["regional_surtax", "credit", "0.0100", 115],
      ]);

      await commitPayRun({ orgId: fx.orgId, documentId: december.documentId, actorId });

      // The run balances: net is gross less deductions plus credits on every
      // December stub, and the journal projection sums to zero.
      for (const employeeId of [dust, bonus, credit, joiner]) {
        const stub = (await db.execute<{ gross: string; net_pay: string }>(sql`
          select gross::text as gross, net_pay::text as net_pay from pay_stubs
           where org_id = ${org.orgId} and pay_run_document_id = ${december.documentId}
             and employee_party_id = ${employeeId}`)).rows[0]!;
        const lines = await stubLines(org.orgId, december.documentId, employeeId);
        const signed = (kinds: string[]) =>
          lines.filter((line) => kinds.includes(line.kind))
            .map((line) => line.amount).reduce((acc, amount) => add(acc, amount), "0.0000");
        assert.equal(
          stub.net_pay,
          add(add(stub.gross, neg(signed(["deduction"]))), signed(["credit"])),
          "net is gross less deductions plus credits",
        );
      }
      const journal = (await db.execute<{ total: string }>(sql`
        select coalesce(sum(amount), 0)::text as total from document_lines
         where org_id = ${org.orgId} and document_id = ${december.documentId}`));
      assert.equal(cmp(journal.rows[0]!.total, "0"), 0, "journal projection balances");

      // The remittance ties: the payable is withholdings minus credits, so
      // the joiner's refund reduces what the employer owes the destination.
      const groups = await payrollRemittanceSummary(org.orgId, { from: "2026-12-01", to: "2026-12-31" });
      const withIncomeTax = groups.filter((group) =>
        group.components.some((c) => c.systemKey === "income_tax"));
      assert.equal(withIncomeTax.length, 1, "one destination carries the December withholdings");
      const ref = (await db.execute<{ ded: string; cred: string }>(sql`
        select coalesce(sum(l.amount) filter (where l.kind = 'deduction' or l.kind = 'employer_contribution'), 0)::text as ded,
               coalesce(sum(l.amount) filter (where l.kind = 'credit'), 0)::text as cred
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${org.orgId} and s.pay_run_document_id = ${december.documentId}
           and r.run_status = 'committed'`)).rows[0]!;
      assert.equal(cmp(withIncomeTax[0]!.total, add(ref.ded, neg(ref.cred))), 0);
      const incomeTaxRow = withIncomeTax[0]!.components
        .filter((c) => c.systemKey === "income_tax")
        .map((c) => c.amount).reduce((acc, amount) => add(acc, amount), "0.0000");
      const incomeTaxRef = (await db.execute<{ ded: string; cred: string }>(sql`
        select coalesce(sum(l.amount) filter (where l.kind = 'deduction'), 0)::text as ded,
               coalesce(sum(l.amount) filter (where l.kind = 'credit'), 0)::text as cred
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          join pay_components c on c.id = l.component_id and c.org_id = l.org_id
         where s.org_id = ${org.orgId} and s.pay_run_document_id = ${december.documentId}
           and c.system_key = 'income_tax'`)).rows[0]!;
      assert.equal(cmp(incomeTaxRow, add(incomeTaxRef.ded, neg(incomeTaxRef.cred))), 0);

      // The bank-file population is whole: control plus excluded cheque still
      // equals net pay, and the refunded employee's EFT entry carries the
      // settlement-adjusted net.
      const population = await payRunBankFilePopulation(org.orgId, december.documentId);
      const netTotal = (await db.execute<{ net: string }>(sql`
        select net_total::text as net from pay_runs
         where org_id = ${org.orgId} and document_id = ${december.documentId}`)).rows[0]!.net;
      assert.equal(cmp(add(population.total, population.excludedTotal), netTotal), 0);
      assert.deepEqual(population.entries.map((e) => e.employeePartyId), [joiner]);
      const joinerNet = (await db.execute<{ net_pay: string }>(sql`
        select net_pay::text as net_pay from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${december.documentId}
           and employee_party_id = ${joiner}`)).rows[0]!.net_pay;
      assert.equal(population.entries[0]!.amount, joinerNet);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a settlement mode the run layer cannot honour refuses by name on the final run",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const pack = IT_PAYROLL_PACK;
    const before = pack.annualSettlement;
    try {
      const fx = await seedHarness(org.orgId, actorId);
      const employeeId = await seedEmployee(fx, "Dieter Dezember", "24000");
      // Germany's December program is a different algorithm for the final
      // period, not an extra line: a pack declaring that shape must make the
      // run refuse, never silently skip the settlement.
      pack.annualSettlement = (taxYear: number) => {
        const edition = before!(taxYear);
        return edition && { ...edition, mode: "final_period_recomputation" as const };
      };
      const december = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-12-01", periodEnd: "2026-12-31", payDate: "2026-12-31",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: december.documentId, actorId });
      const documentId = december.documentId;
      const stored = (await db.execute<{ errors: unknown }>(sql`
        select calculation_errors as errors from pay_runs
         where org_id = ${org.orgId} and document_id = ${documentId}`)).rows[0]!;
      const errors = (stored.errors ?? []) as { employeePartyId: string; message: string }[];
      const mine = errors.filter((e) => e.employeePartyId === employeeId);
      assert.equal(mine.length, 1, "the employee is refused, nobody else is affected");
      assert.match(mine[0]!.message, /final_period_recomputation/);
      assert.match(mine[0]!.message, /adjustment_line/);
    } finally {
      pack.annualSettlement = before;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a settlement whose declared inputs are missing refuses by name",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const pack = IT_PAYROLL_PACK;
    const before = pack.annualSettlement;
    try {
      const fx = await seedHarness(org.orgId, actorId);
      const employeeId = await seedEmployee(fx, "Marta Mancante", "24000");
      pack.annualSettlement = (taxYear: number) => {
        const edition = before!(taxYear);
        return edition && { ...edition, requiredEmployeeFacts: ["fatto_sintetico"] };
      };
      const december = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-12-01", periodEnd: "2026-12-31", payDate: "2026-12-31",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: december.documentId, actorId });
      const documentId = december.documentId;
      const stored = (await db.execute<{ errors: unknown }>(sql`
        select calculation_errors as errors from pay_runs
         where org_id = ${org.orgId} and document_id = ${documentId}`)).rows[0]!;
      const errors = (stored.errors ?? []) as { employeePartyId: string; message: string }[];
      const mine = errors.filter((e) => e.employeePartyId === employeeId);
      assert.equal(mine.length, 1, "the employee is refused, nobody else is affected");
      assert.match(mine[0]!.message, /fatto_sintetico/);
    } finally {
      pack.annualSettlement = before;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
