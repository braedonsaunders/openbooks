import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { setPackSlotAccount } from "./packs.ts";
import { yearEndFiling } from "./filing-registry.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";
import { add } from "../money/money.ts";
import { parseFrRecapRowId } from "./fr/filings.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * France annual récapitulatif des versements déclarés en DSN.
 *
 * Premise (see engine/src/payroll/fr/filings.ts): France issues no employer
 * annual tax certificate — the monthly DSN carries pay and PAS to the DGFiP
 * — so this filing is the per-employee, per-month reconciliation of the
 * year's COMMITTED versements, each month tying to its DSN to the centime.
 *
 * Fixture (Spain's shape): Camille is paid 2000 + 2000 across March and
 * June, Idriss 3000 + 3000 across the same two months, and a DRAFT July run
 * that must be EXCLUDED. The tie-out is cross-checked by an independently
 * written SQL statement over the same posted stubs — one query agreeing
 * with itself proves nothing.
 */

interface Fixture {
  orgId: string;
  actorId: string;
  scheduleId: string;
  camille: string;
  idriss: string;
}

async function frPayrollOrg(): Promise<Fixture> {
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
  const wageExpense = await account("6000", "Salaires", "expense");
  const burdenExpense = await account("6010", "Charges patronales", "expense");
  const netPayable = await account("2300", "Salaires à payer", "liability_current");
  const urssafPayable = await account("2330", "URSSAF / DGFiP à payer", "liability_current");
  const caissePayable = await account("2340", "Caisse de retraite à payer", "liability_current");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        countries: ["FR"],
      },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "FR");
  await setPackSlotAccount(org.orgId, actorId, "FR", "pas", urssafPayable);
  await setPackSlotAccount(org.orgId, actorId, "FR", "salariales", urssafPayable);
  await setPackSlotAccount(org.orgId, actorId, "FR", "retraite_comp", caissePayable);
  await setPackSlotAccount(org.orgId, actorId, "FR", "patronales", urssafPayable);
  // AGIRC-ARRCO/CEG/CET are declared `external`: the org names its own
  // caisse on the components (the QC/Revenu-Québec precedent).
  const caisseId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${caisseId}, ${org.orgId}, 'company', 'Caisse de retraite', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
    values (${org.orgId}, ${caisseId}, true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    update pay_components set remittance_party_id = ${caisseId}
     where org_id = ${org.orgId} and code in ('ARRCO', 'ARRCO-ER', 'CEG', 'CEG-ER', 'CET', 'CET-ER')`);

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Mensuel', 'monthly', 12, '2026-03-31', 3, true,
            ${actorId}, ${actorId})`);

  const employee = async (name: string, annualSalary: string): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${id}, ${org.orgId}, 'person', ${name}, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id)
      values (${randomUUID()}, ${org.orgId}, ${id})`);
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                    is_active, created_by, updated_by)
      values (${org.orgId}, ${id}, 'EUR', ${annualSalary}, 'year', '2026-01-01', true,
              ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                             province, pay_basis, is_active, created_by, updated_by)
      values (${org.orgId}, ${id}, ${scheduleId}, 'FR', 'FR', 'salary', true, ${actorId}, ${actorId})`);
    // Métropole domicile, no transmitted rate: the statutory default grille
    // prices PAS. Without the domicile the engine refuses by name.
    await db.execute(sql`
      insert into employee_tax_certificates (org_id, employee_party_id, country, certificate_key,
                                             region, sub_region, answers, effective_from,
                                             created_by, updated_by)
      values (${org.orgId}, ${id}, 'FR', 'fr_pas_option', null, null,
              '{"domicile": "metropole_hors_france"}'::jsonb, '2026-01-01', ${actorId}, ${actorId})`);
    return id;
  };
  const camille = await employee("Camille Martin", "24000");
  const idriss = await employee("Idriss Bernard", "36000");
  return { orgId: org.orgId, actorId, scheduleId, camille, idriss };
}

async function runAndCommit(fx: Fixture, periodStart: string, periodEnd: string): Promise<string> {
  const run = await createPayRun({
    orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
    periodStart, periodEnd,
  });
  assert.deepEqual((await calculatePayRun({
    orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
  })).errors, []);
  await commitPayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
  return run.documentId;
}

/** A calculated-but-never-committed run: the filing must not see it. */
async function runDraft(fx: Fixture, periodStart: string, periodEnd: string): Promise<string> {
  const run = await createPayRun({
    orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
    periodStart, periodEnd,
  });
  assert.deepEqual((await calculatePayRun({
    orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
  })).errors, []);
  return run.documentId;
}

/**
 * The independent cross-check: per (employee, month) sums straight off the
 * posted columns and lines, written separately from the population query —
 * gross and net from the stub columns, PAS from the pas lines.
 */
async function independentTieout(fx: Fixture) {
  return (await db.execute<{
    employee_party_id: string; month: string; gross: string; net: string; pas: string;
  }>(sql`
    select s.employee_party_id, to_char(s.pay_date, 'YYYY-MM') as month,
           sum(s.gross)::text as gross, sum(s.net_pay)::text as net,
           (select coalesce(sum(l.amount), 0) from pay_stub_lines l
             join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
            where l.org_id = ${fx.orgId} and l.stub_id = s.id and l.kind = 'deduction'
              and pc.system_key = 'pas')::text as pas
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
       and r.run_status = 'committed'
     where s.org_id = ${fx.orgId} and s.tax_year = 2026 and s.country = 'FR'
     group by s.employee_party_id, to_char(s.pay_date, 'YYYY-MM')`)).rows;
}

test(
  "FR récapitulatif: two employees across two committed months tie to the posted stubs; the draft is excluded",
  { skip: !DB },
  async () => {
    const fx = await frPayrollOrg();
    try {
      await runAndCommit(fx, "2026-03-01", "2026-03-27");
      await runAndCommit(fx, "2026-06-01", "2026-06-26");
      const draftId = await runDraft(fx, "2026-07-01", "2026-07-25");
      const draftStubs = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pay_stubs where org_id = ${fx.orgId} and pay_run_document_id = ${draftId}`))
        .rows[0]!.n;
      assert.ok(draftStubs > 0, "the draft run really calculated stubs that must be excluded");

      const filing = yearEndFiling("FR", "recapitulatif-annuel");
      const population = await filing.population(fx.orgId, 2026);
      assert.equal(population.rows.length, 4, "two employees across two committed months");
      assert.deepEqual(
        [...new Set(population.rows.map((row) => row.month))].sort(),
        ["2026-03", "2026-06"],
        "the July draft contributes no month",
      );

      // Every row id round-trips through the declared grammar.
      for (const row of population.rows) {
        const scope = parseFrRecapRowId(String(row.rowId));
        assert.ok(scope, `${String(row.rowId)} parses`);
        assert.equal(scope!.employees.length, 1);
        assert.deepEqual(scope!.accounts, []);
      }
      assert.equal(parseFrRecapRowId("not-an-fr-row"), null);

      // The engine really withheld: without these the tie-out below would
      // pass vacuously over zeros.
      for (const row of population.rows) {
        assert.ok(Number(row.pas) > 0, `${String(row.employee)} ${String(row.month)} withholds PAS`);
        assert.ok(Number(row.brut) > 0, "brut is posted");
        assert.ok(Number(row.netImposable) > 0, "net imposable is derived");
      }

      // Tie-out against the independently written statement, to the centime.
      const check = await independentTieout(fx);
      assert.equal(check.length, 4);
      for (const row of population.rows) {
        const other = check.find(
          (candidate) =>
            candidate.employee_party_id === parseFrRecapRowId(String(row.rowId))!.employees[0] &&
            candidate.month === row.month,
        );
        assert.ok(other, "cross-check has the same slice");
        assert.equal(
          String(row.brut),
          other!.gross,
          `${String(row.employee)} ${String(row.month)} brut ties to posted gross`,
        );
        assert.equal(String(row.netPaye), other!.net);
        assert.equal(String(row.pas), other!.pas);
      }

      // Annual totals tie the year's DSNs (the employer-side answer).
      // Exact-decimal: the totals are money strings, so the re-sum uses
      // add(), never Number() — a float here could agree falsely.
      const tot = (key: string) =>
        population.rows.reduce((acc, row) => add(acc, String(row[key])), "0");
      const totals = Object.fromEntries(population.totals!.map((t) => [t.label, t.value]));
      assert.equal(totals["Prélèvement à la source (année)"], tot("pas"));

      // One row as its slip: boxes match the population, SIRET unassigned.
      const camilleMarch = population.rows.find(
        (row) => row.employee === "Camille Martin" && row.month === "2026-03",
      );
      assert.ok(camilleMarch);
      const slip = await filing.slip!.build(fx.orgId, 2026, String(camilleMarch!.rowId));
      const box = (code: string) => slip.boxes.find((b) => b.code === code)!.value;
      assert.equal(box("BRUT"), camilleMarch!.brut);
      assert.equal(box("PAS"), camilleMarch!.pas);
      assert.equal(box("NET_PAYE"), camilleMarch!.netPaye);
      assert.ok(
        slip.headerFields.some((h) => h.label === "SIRET (établissement)" && h.value === "Unassigned"),
      );
      assert.ok(slip.notes!.some((n) => n.includes("DSN")));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "FR récapitulatif refuses an empty year and an uncovered year by name",
  { skip: !DB },
  async () => {
    const fx = await frPayrollOrg();
    try {
      const filing = yearEndFiling("FR", "recapitulatif-annuel");
      await assert.rejects(() => filing.population(fx.orgId, 2026), /no committed French pay runs/);
      await assert.rejects(
        () => filing.population(fx.orgId, 2025),
        /no published FR statutory tables for tax year 2025/,
      );
      await assert.rejects(() => filing.slip!.build(fx.orgId, 2026, "not-a-row"), /not one of this filing/);
      assert.equal(filing.amendment.supported, false);
      assert.match(
        filing.amendment.supported === false ? filing.amendment.refusal : "",
        /DSN rectificative/,
      );
      assert.match(filing.downloadRefusal ?? "", /net-entreprises/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
