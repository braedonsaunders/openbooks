import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, sum } from "../money/money.ts";
import { setPackSlotAccount } from "./packs.ts";
import {
  calculatePayRun,
  commitPayRun,
  createPayRun,
  discardPayRun,
  payScheduleSubsidiaryProblem,
  PayrollError,
  rescopePayScheduleRuns,
  seedPayrollComponents,
} from "./run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

/**
 * The frozen-entity defect: a run freezes its paying entity and currency at
 * creation, and re-scoping the pay schedule afterwards healed nothing — the
 * run kept calculating (and would have posted) in the wrong currency, could
 * not be discarded, and duplicate protection blocked the correct replacement.
 *
 * The scenario mirrors the report with the packs the suite already exercises
 * end to end (CA root + US entity instead of GB + IE — the mechanism is
 * country-agnostic): an UNSCOPED schedule mints a run on the root entity,
 * the schedule is scoped afterwards, and the run must follow while it is
 * still uncommitted.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  rootSubsidiaryId: string;
  usSubsidiaryId: string;
  scheduleId: string;
  employeeId: string;
}

/** Multi-entity org: CA root (CAD) + US entity (USD), salaried Texas employee. */
async function seedTwoEntityOrg(options: { scopedSchedule?: boolean } = {}): Promise<Fixture> {
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
  const irsPayable = await account("2330", "Federal payroll taxes payable", "liability_current");
  const futaPayable = await account("2340", "FUTA payable", "liability_current");
  const sutaPayable = await account("2350", "SUI payable", "liability_current");
  const statePayable = await account("2360", "State income tax payable", "liability_current");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      features: { payroll: true },
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        countries: ["US"],
        us: { sui: { TX: { rate: "0.027", wageBase: "9000" } } },
      },
    })}::jsonb where id = ${org.orgId}`);

  await seedPayrollComponents(org.orgId, actorId, "CA");
  await seedPayrollComponents(org.orgId, actorId, "US");
  await setPackSlotAccount(org.orgId, actorId, "US", "fit", irsPayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "fica", irsPayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "futa", futaPayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "suta", sutaPayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "state_income_tax", statePayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "local_income_tax", statePayable);

  const usSubsidiaryId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                              is_elimination, is_active, custom)
    values (${usSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'US Entity', 'USD', 'US',
            '{}'::jsonb, false, true, '{}'::jsonb)`);

  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Tex Worker', ${usSubsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, 'USD', '104000', 'year', 2080, '2026-01-01', true,
            ${actorId}, ${actorId})`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, subsidiary_id, is_active,
                               created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3,
            ${options.scopedSchedule ? usSubsidiaryId : null}, true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                           province, pay_basis, filing_status, is_active,
                                           created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${scheduleId}, 'US', 'TX', 'salary', 'married_joint',
            true, ${actorId}, ${actorId})`);
  return {
    orgId: org.orgId, actorId, rootSubsidiaryId: org.subsidiaryId,
    usSubsidiaryId, scheduleId, employeeId,
  };
}

async function docOf(orgId: string, documentId: string) {
  return (await db.execute<{ subsidiary_id: string; currency: string; status: string }>(sql`
    select subsidiary_id, currency, status from documents where org_id = ${orgId} and id = ${documentId}
  `)).rows[0];
}

test(
  "a run created on an unscoped schedule freezes the root entity and currency, and refuses the foreign employee by name",
  { skip: !DB },
  async () => {
    const f = await seedTwoEntityOrg();
    try {
      const run = await createPayRun({
        orgId: f.orgId, actorId: f.actorId, payScheduleId: f.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const doc = (await docOf(f.orgId, run.documentId))!;
      assert.equal(doc.subsidiary_id, f.rootSubsidiaryId);
      assert.equal(doc.currency, "CAD");

      const result = await calculatePayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId });
      assert.equal(result.employees, 0);
      assert.equal(result.gross, "0");
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0]!.employee, "Tex Worker");
      assert.match(result.errors[0]!.message, /on the US country pack/);
      assert.ok(
        !result.errors[0]!.message.includes("Tex Worker"),
        "the name rides errors[].employee — repeating it prints it twice",
      );
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "re-scoping the schedule re-resolves the uncommitted run: entity and currency move together",
  { skip: !DB },
  async () => {
    const f = await seedTwoEntityOrg();
    try {
      const run = await createPayRun({
        orgId: f.orgId, actorId: f.actorId, payScheduleId: f.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId });

      await db.execute(sql`
        update pay_schedules set subsidiary_id = ${f.usSubsidiaryId}
         where id = ${f.scheduleId} and org_id = ${f.orgId}`);
      const scope = await rescopePayScheduleRuns(db, {
        orgId: f.orgId, payScheduleId: f.scheduleId, actorId: f.actorId,
      });
      assert.deepEqual(scope, { reresolved: 1, untouched: 0 });

      const doc = (await docOf(f.orgId, run.documentId))!;
      assert.equal(doc.subsidiary_id, f.usSubsidiaryId);
      assert.equal(doc.currency, "USD");
      const stamped = (await db.execute<{ tax_year: number; run_status: string }>(sql`
        select tax_year, run_status from pay_runs where org_id = ${f.orgId} and document_id = ${run.documentId}
      `)).rows[0]!;
      assert.equal(stamped.run_status, "draft");
      assert.equal(stamped.tax_year, 2026);

      const result = await calculatePayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId });
      assert.deepEqual(result.errors, []);
      assert.equal(result.employees, 1);
      assert.equal(result.gross, "4000.0000");
      const stub = (await db.execute<{ currency_code: string; gross: string }>(sql`
        select currency_code, gross from pay_stubs where org_id = ${f.orgId} and pay_run_document_id = ${run.documentId}
      `)).rows[0]!;
      assert.equal(stub.currency_code, "USD");
      assert.equal(stub.gross, "4000.0000");
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "a re-scoped schedule heals the run at re-test time even when the re-scope bypassed the writer",
  { skip: !DB },
  async () => {
    const f = await seedTwoEntityOrg();
    try {
      const run = await createPayRun({
        orgId: f.orgId, actorId: f.actorId, payScheduleId: f.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      // Raw re-scope: no eager re-resolve runs. The next test must heal the
      // run itself rather than fail with the frozen entity's error.
      await db.execute(sql`
        update pay_schedules set subsidiary_id = ${f.usSubsidiaryId}
         where id = ${f.scheduleId} and org_id = ${f.orgId}`);
      const result = await calculatePayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId });
      assert.deepEqual(result.errors, []);
      assert.equal(result.employees, 1);
      const doc = (await docOf(f.orgId, run.documentId))!;
      assert.equal(doc.subsidiary_id, f.usSubsidiaryId);
      assert.equal(doc.currency, "USD");
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "a re-scoped run commits and journals in the entity currency, and a committed run cannot be discarded",
  { skip: !DB },
  async () => {
    const f = await seedTwoEntityOrg({ scopedSchedule: true });
    try {
      const run = await createPayRun({
        orgId: f.orgId, actorId: f.actorId, payScheduleId: f.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const created = (await docOf(f.orgId, run.documentId))!;
      assert.equal(created.subsidiary_id, f.usSubsidiaryId);
      assert.equal(created.currency, "USD");

      await calculatePayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId });
      await commitPayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId });

      // The journal currency is the document's — the header was the symptom,
      // the journal is the defect.
      const journal = (await db.execute<{ currency: string; subtotal: string }>(sql`
        select currency, subtotal::text as subtotal from documents
         where org_id = ${f.orgId} and id = ${run.documentId}
      `)).rows[0]!;
      assert.equal(journal.currency, "USD");
      const lines = (await db.execute<{ amount: string }>(sql`
        select amount::text as amount from document_lines
         where org_id = ${f.orgId} and document_id = ${run.documentId}
      `));
      assert.ok(lines.rows.length >= 5);
      assert.equal(cmp(sum(lines.rows.map((l) => l.amount)), "0"), 0, "GL projection balances");

      await assert.rejects(
        discardPayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId }),
        (error: unknown) =>
          error instanceof PayrollError
          && /is committed and cannot be discarded — void it to reverse the posted payroll/
            .test(error.message),
      );

      // A document the lifecycle moved past draft is refused on its own terms —
      // every posted run is a committed run, so the committed refusal above is
      // the posted boundary too.
      await db.execute(sql`
        update pay_runs set run_status = 'calculated'
         where org_id = ${f.orgId} and document_id = ${run.documentId}`);
      await db.execute(sql`
        update documents set status = 'approved' where org_id = ${f.orgId} and id = ${run.documentId}`);
      await assert.rejects(
        discardPayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId }),
        (error: unknown) =>
          error instanceof PayrollError
          && new RegExp(`pay run ${run.documentNumber} is approved and cannot be discarded`).test(error.message)
          && /only a draft run can be discarded/.test(error.message),
      );
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "a draft run discards cleanly and releases its period for a correct replacement",
  { skip: !DB },
  async () => {
    const f = await seedTwoEntityOrg({ scopedSchedule: true });
    try {
      const run = await createPayRun({
        orgId: f.orgId, actorId: f.actorId, payScheduleId: f.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId });
      const stubsBefore = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pay_stubs where org_id = ${f.orgId} and pay_run_document_id = ${run.documentId}
      `)).rows[0]!;
      assert.equal(stubsBefore.n, 1);

      const discarded = await discardPayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId });
      assert.match(discarded.documentNumber, /^PAY-/);
      const remaining = (await db.execute<{ documents: number; runs: number; stubs: number; adjustments: number }>(sql`
        select (select count(*)::int from documents where org_id = ${f.orgId} and id = ${run.documentId}) as documents,
               (select count(*)::int from pay_runs where org_id = ${f.orgId} and document_id = ${run.documentId}) as runs,
               (select count(*)::int from pay_stubs where org_id = ${f.orgId} and pay_run_document_id = ${run.documentId}) as stubs,
               (select count(*)::int from pay_run_adjustments where org_id = ${f.orgId} and pay_run_document_id = ${run.documentId}) as adjustments
      `)).rows[0]!;
      assert.deepEqual(
        [remaining.documents, remaining.runs, remaining.stubs, remaining.adjustments],
        [0, 0, 0, 0],
        "no table keeps a trace of the discarded run",
      );
      const ledger = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from entitlement_ledger
         where org_id = ${f.orgId} and pay_run_document_id = ${run.documentId}
      `)).rows[0]!;
      assert.equal(ledger.n, 0, "uncommitted ledger movements go with the run");

      // Duplicate protection does not outlive the run it protected against.
      const replacement = await createPayRun({
        orgId: f.orgId, actorId: f.actorId, payScheduleId: f.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      assert.ok(replacement.documentId !== run.documentId);
      const result = await calculatePayRun({
        orgId: f.orgId, documentId: replacement.documentId, actorId: f.actorId,
      });
      assert.deepEqual(result.errors, []);
      assert.equal(result.employees, 1);
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "a schedule with no subsidiary is refused in a multi-entity org and allowed in a single-entity one",
  { skip: !DB },
  async () => {
    const single = await createScratchOrg();
    try {
      assert.equal(await payScheduleSubsidiaryProblem(single.orgId, null), null);
    } finally {
      await dropScratchOrgReporting(single.orgId);
    }
    const f = await seedTwoEntityOrg();
    try {
      const problem = await payScheduleSubsidiaryProblem(f.orgId, null);
      assert.ok(problem, "an unscoped schedule in a multi-entity org must be refused");
      assert.match(problem!, /Choose the subsidiary this schedule pays for/);
      assert.equal(await payScheduleSubsidiaryProblem(f.orgId, f.usSubsidiaryId), null);
      const bogus = await payScheduleSubsidiaryProblem(f.orgId, randomUUID());
      assert.match(bogus ?? "", /active subsidiary/);
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);

test(
  "committed history stays frozen when its schedule is re-scoped",
  { skip: !DB },
  async () => {
    const f = await seedTwoEntityOrg({ scopedSchedule: true });
    try {
      const run = await createPayRun({
        orgId: f.orgId, actorId: f.actorId, payScheduleId: f.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId });
      await commitPayRun({ orgId: f.orgId, documentId: run.documentId, actorId: f.actorId });

      const otherSub = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                  is_elimination, is_active, custom)
        values (${otherSub}, ${f.orgId}, ${f.rootSubsidiaryId},
                'CA West', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      await db.execute(sql`
        update pay_schedules set subsidiary_id = ${otherSub}
         where id = ${f.scheduleId} and org_id = ${f.orgId}`);
      const scope = await rescopePayScheduleRuns(db, {
        orgId: f.orgId, payScheduleId: f.scheduleId, actorId: f.actorId,
      });
      assert.deepEqual(scope, { reresolved: 0, untouched: 1 });

      const doc = (await docOf(f.orgId, run.documentId))!;
      assert.equal(doc.subsidiary_id, f.usSubsidiaryId, "the posted run keeps its entity");
      assert.equal(doc.currency, "USD", "the posted run keeps its currency");
      const status = (await db.execute<{ run_status: string }>(sql`
        select run_status from pay_runs where org_id = ${f.orgId} and document_id = ${run.documentId}
      `)).rows[0]!;
      assert.equal(status.run_status, "committed");
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);
