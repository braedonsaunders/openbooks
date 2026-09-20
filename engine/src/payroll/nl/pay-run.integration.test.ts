import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { PAYROLL_COUNTRY_PACKS, setPackSlotAccount } from "../packs.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { seedPayrollComponents } from "../run-setup.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../../testing/fixtures.ts";

/**
 * The NL pack, ON A REAL PAY RUN.
 *
 * A persona set up a Netherlands company end to end and could not complete
 * a single pay run: calculating failed with the NL pack's own money-parse
 * refusal, because the pipeline hands every pack 4-decimal money strings
 * ("0.0000") and the pack only accepted one or two. Unit tests called the
 * engine with 2dp strings, so they were green while no Dutch employee could
 * be paid. These tests run the whole pipeline — profile, certificates,
 * salary, calculation, commit — so they fail exactly the way the persona did.
 *
 * The expected withholding below is quoted from the authority's own output:
 * Belastingdienst, witte loonbelastingtabel 2026, Standaard, maandtabel
 * (uitgave januari 2026, download.belastingdienst.nl) — tabelloon € 999,00,
 * column "met loonheffingskorting": € 13,83. The engine prices the
 * Rekenvoorschriften algorithm rather than looking the row up, so this pins
 * the algorithm against the publication, not against itself.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const PERIOD_START = "2026-02-01";
const PERIOD_END = "2026-02-28";
/** € 11.988 a year is € 999,00 a month at 12 periods — the table row above. */
const ANNUAL_SALARY = "11988";
const PERIOD_WAGES = "999.0000";

interface Fixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  scheduleId: string;
}

async function nlPayrollOrg(): Promise<Fixture> {
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
  const loonheffingPayable = await account("2330", "Loonheffingen payable", "liability_current");
  const svPayable = await account("2360", "SV premiums payable", "liability_current");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        countries: ["NL"],
      },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "NL");
  await setPackSlotAccount(org.orgId, actorId, "NL", "loonheffing", loonheffingPayable);
  await setPackSlotAccount(org.orgId, actorId, "NL", "werknemersverzekeringen", svPayable);
  await setPackSlotAccount(org.orgId, actorId, "NL", "zvw", svPayable);

  const subsidiaryId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                              is_elimination, is_active, custom)
    values (${subsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'NL Entity', 'EUR', 'NL',
            '{}'::jsonb, false, true, '{}'::jsonb)`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, subsidiary_id, is_active,
                               created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Monthly NL', 'monthly', 12, ${PERIOD_END}, 3,
            ${subsidiaryId}, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, subsidiaryId, scheduleId };
}

async function nlEmployee(
  fx: Fixture,
  name: string,
  certificates: { key: string; answers: Record<string, string> }[],
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${fx.orgId}, 'person', ${name}, ${fx.subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${fx.orgId}, ${id})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, 'EUR', ${ANNUAL_SALARY}, 'year', 2080, '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  // The profile carries NO NL facts: every per-employee input the loonheffing
  // engine reads is a pack-declared certificate answer, entered through the
  // certificates surface (web/app/api/payroll/certificates).
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                           province, pay_basis, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, ${fx.scheduleId}, 'NL', 'NL',
            'salary', true, ${fx.actorId}, ${fx.actorId})`);
  for (const certificate of certificates) {
    await db.execute(sql`
      insert into employee_tax_certificates (org_id, employee_party_id, country, certificate_key,
                                             region, sub_region, answers, effective_from,
                                             created_by, updated_by)
      values (${fx.orgId}, ${id}, 'NL', ${certificate.key}, null, null,
              ${JSON.stringify(certificate.answers)}::jsonb, '2026-01-01',
              ${fx.actorId}, ${fx.actorId})`);
  }
  return id;
}

const stubOf = async (fx: Fixture, documentId: string, employeePartyId: string) => {
  const r = (await db.execute<{ id: string; gross: string; factors: Record<string, string> }>(sql`
    select id, gross::text as gross, factors from pay_stubs
     where org_id = ${fx.orgId} and pay_run_document_id = ${documentId}
       and employee_party_id = ${employeePartyId}
  `));
  return r.rows[0] ?? null;
};

const deductionsOf = async (fx: Fixture, stubId: string) => {
  const r = (await db.execute<{ system_key: string; description: string; amount: string }>(sql`
    select c.system_key, l.description, l.amount::text as amount
      from pay_stub_lines l join pay_components c on c.id = l.component_id
     where l.org_id = ${fx.orgId} and l.stub_id = ${stubId} and l.kind = 'deduction'
     order by l.sequence
  `));
  return r.rows;
};

test(
  "an NL pay run calculates and commits, withholding the witte maandtabel figure to the cent",
  { skip: !DB },
  async () => {
    assert.equal(PAYROLL_COUNTRY_PACKS["NL"]!.installable, true);
    const fx = await nlPayrollOrg();
    try {
      // Configured entirely through the declared surfaces: a bare profile
      // plus the pack's two certificates — no profile column, no default.
      const employee = await nlEmployee(fx, "Jan Modaal", [
        { key: "nl_loonheffingen", answers: { apply_loonheffingskorting: "true" } },
        { key: "nl_premies", answers: { awf_laag: "true", aof_hoog: "false", whk_percent: "1.25" } },
      ]);
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END,
      });
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, [], "the persona's pay run calculates");

      const stub = await stubOf(fx, run.documentId, employee);
      assert.ok(stub, "the Dutch employee was paid");
      assert.equal(stub!.gross, PERIOD_WAGES);
      // Witte maandtabel 2026, Standaard, tabelloon € 999,00, "met
      // loonheffingskorting": € 13,83 (download.belastingdienst.nl, uitgave
      // januari 2026).
      assert.equal(stub!.factors["LH"], "13.8300");
      const deductions = await deductionsOf(fx, stub!.id);
      const loonheffing = deductions.find((line) => line.system_key === "loonheffing");
      assert.ok(loonheffing, "a loonheffing line is on the stub");
      assert.equal(loonheffing!.amount, "13.8300");
      assert.equal(loonheffing!.description, "Loonbelasting/premie volksverzekeringen");

      await commitPayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
      const committed = await stubOf(fx, run.documentId, employee);
      assert.ok(committed, "the stub survives the commit");
      assert.equal(committed!.factors["LH"], "13.8300");
      const committedDeductions = await deductionsOf(fx, committed!.id);
      assert.equal(
        committedDeductions.find((line) => line.system_key === "loonheffing")?.amount,
        "13.8300",
        "the committed withholding is the table figure, to the cent",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an NL run without the SV facts fails on the missing declaration, not on pipeline money",
  { skip: !DB },
  async () => {
    // The parse defect's shape: with no bonus lines the pipeline hands the
    // pack nonPeriodic "0.0000". Before the fix that string itself was the
    // refusal; now the run must get past parsing and fail — loudly, by name —
    // on the undeclared AWf contract type instead.
    const fx = await nlPayrollOrg();
    try {
      const employee = await nlEmployee(fx, "No Premies", [
        { key: "nl_loonheffingen", answers: { apply_loonheffingskorting: "true" } },
      ]);
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: PERIOD_START, periodEnd: PERIOD_END,
      });
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0]!.message, /AWf/);
      assert.doesNotMatch(result.errors[0]!.message, /money amount/);
      assert.equal(await stubOf(fx, run.documentId, employee), null);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
