import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { cmp } from "../../money/money.ts";
import { db } from "../../platform/db.ts";
import { sealSecret } from "../../platform/secrets.ts";
import { PAYROLL_COUNTRY_PACKS, setPackSlotAccount } from "../packs.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { seedPayrollComponents } from "../run-setup.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../../testing/fixtures.ts";

/**
 * The NL jaaropgaaf, ON COMMITTED RUNS.
 *
 * Three employees — one per tabeltoepassing arm (under_aow, aow_1945,
 * aow_1946) — across two committed monthly runs, plus a third calculated but
 * UNCOMMITTED run that must not appear on any statutory statement. The
 * population must aggregate per employee (not report one row), tie to the
 * committed stubs to the cent, and carry each employee's own arm; the refusal
 * paths must name the reason rather than print an empty slip.
 *
 * Money anchors (all engine goldens cross-checked against the Belastingdienst
 * witte maandtabel 2026, Standaard, uitgave januari 2026):
 * - Jan (under_aow, € 999/mo, korting): LH € 13,83/mo.
 * - Piet (aow_1946, € 3.240/mo, korting): LH € 69,58/mo, verrekende ARK
 *   € 231,17/mo (engine golden with Tabel cross-check).
 * - Truus (aow_1945, € 999/mo, korting): the AOW kortingen (AHK 1.556 + OUK
 *   2.067 + ARK) exceed X1 (2.139), so X floors at € 0 — a pensioner who
 *   owes nothing still gets a statement, with zeros that are true.
 *
 * DB-owned: every test here skips without OPENBOOKS_DB_URL and runs on the
 * gate. The pure row-grammar tests live in filings.test.ts (unit partition).
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const PREMIES = { awf_laag: "true", aof_hoog: "false", whk_percent: "1.25" };

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
    values (${scheduleId}, ${org.orgId}, 'Monthly NL', 'monthly', 12, '2026-02-28', 3,
            ${subsidiaryId}, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, subsidiaryId, scheduleId };
}

async function nlEmployee(
  fx: Fixture,
  args: {
    name: string;
    annualSalary: string;
    opgaaf: Record<string, string>;
    bsn?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${fx.orgId}, 'person', ${args.name}, ${fx.subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${fx.orgId}, ${id})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, 'EUR', ${args.annualSalary}, 'year', 2080, '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                           province, pay_basis, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, ${fx.scheduleId}, 'NL', 'NL',
            'salary', true, ${fx.actorId}, ${fx.actorId})`);
  // No plaintext national identifier is ever stored: the sealed column holds
  // ciphertext, rendered only at slip time.
  if (args.bsn) {
    await db.execute(sql`
      update employee_payroll_profiles
         set sin_encrypted = ${sealSecret(args.bsn)}, sin_last3 = ${args.bsn.slice(-3)}
       where org_id = ${fx.orgId} and employee_party_id = ${id}`);
  }
  for (const [key, answers] of [
    ["nl_loonheffingen", args.opgaaf],
    ["nl_premies", PREMIES],
  ] as const) {
    await db.execute(sql`
      insert into employee_tax_certificates (org_id, employee_party_id, country, certificate_key,
                                             region, sub_region, answers, effective_from,
                                             created_by, updated_by)
      values (${fx.orgId}, ${id}, 'NL', ${key}, null, null,
              ${JSON.stringify(answers)}::jsonb, '2026-01-01',
              ${fx.actorId}, ${fx.actorId})`);
  }
  return id;
}

async function monthlyRun(
  fx: Fixture, periodStart: string, periodEnd: string, commit: boolean,
): Promise<void> {
  const run = await createPayRun({
    orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
    periodStart, periodEnd,
  });
  const result = await calculatePayRun({
    orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
  });
  assert.deepEqual(result.errors, [], `${periodStart} calculates`);
  if (commit) await commitPayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
}

/** Independent stub sums: the oracle the population must tie to, to the cent. */
interface IndependentSums {
  loon: string; ingehouden: string; ark: string; sv: string;
  zvw: string; premies: string; runs: string;
}

async function independentSums(orgId: string, employeePartyId: string): Promise<IndependentSums> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    with committed as (
      select s.*
        from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
     where s.org_id = ${orgId} and s.tax_year = 2026 and s.country = 'NL'
       and s.employee_party_id = ${employeePartyId}
    )
    select (select coalesce(sum(l.amount), 0) from pay_stub_lines l
             join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
            where l.org_id = ${orgId} and l.stub_id in (select id from committed)
              and l.kind = 'earning' and coalesce(pc.taxable, true)) as loon,
           (select coalesce(sum(l.amount), 0) from pay_stub_lines l
             join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
            where l.org_id = ${orgId} and l.stub_id in (select id from committed)
              and l.kind = 'deduction' and pc.system_key = 'loonheffing') as ingehouden,
           (select coalesce(sum((c.factors->>'ARK_T')::numeric), 0) from committed c) as ark,
           (select coalesce(sum((c.factors->>'SV_BASE')::numeric), 0) from committed c) as sv,
           (select coalesce(sum(l.amount), 0) from pay_stub_lines l
             join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
            where l.org_id = ${orgId} and l.stub_id in (select id from committed)
              and l.kind = 'employer_contribution' and pc.system_key = 'zvw') as zvw,
           (select coalesce(sum(l.amount), 0) from pay_stub_lines l
             join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
            where l.org_id = ${orgId} and l.stub_id in (select id from committed)
              and l.kind = 'employer_contribution' and pc.system_key in ('ww', 'wia')) as premies,
           (select count(*)::int from committed) as runs
  `));
  const row = rows.rows[0]!;
  const text = (value: unknown): string => String(value ?? "0");
  return {
    loon: text(row.loon),
    ingehouden: text(row.ingehouden),
    ark: text(row.ark),
    sv: text(row.sv),
    zvw: text(row.zvw),
    premies: text(row.premies),
    runs: text(row.runs),
  };
}

const filing = () =>
  PAYROLL_COUNTRY_PACKS["NL"]!.filings().yearEnd.find((entry) => entry.key === "jaaropgaaf")!;

test(
  "the jaaropgaaf aggregates three arms over two committed runs and excludes the draft",
  { skip: !DB },
  async () => {
    const fx = await nlPayrollOrg();
    try {
      const jan = await nlEmployee(fx, {
        name: "Jan Modaal", annualSalary: "11988",
        opgaaf: { apply_loonheffingskorting: "true" }, bsn: "111222333",
      });
      const piet = await nlEmployee(fx, {
        name: "Piet AOW", annualSalary: "38880",
        opgaaf: { apply_loonheffingskorting: "true", age_class: "aow_1946" },
      });
      const truus = await nlEmployee(fx, {
        name: "Truus AOW", annualSalary: "11988",
        opgaaf: { apply_loonheffingskorting: "true", age_class: "aow_1945" },
      });
      await monthlyRun(fx, "2026-02-01", "2026-02-28", true);
      await monthlyRun(fx, "2026-03-01", "2026-03-31", true);
      // Calculated, never committed: a draft run must not appear on a
      // statutory filing.
      await monthlyRun(fx, "2026-04-01", "2026-04-30", false);

      const data = await filing().population(fx.orgId, 2026);
      assert.equal(data.rows.length, 3, "one row per employee, not per run");
      const byId = new Map(data.rows.map((row) => [String(row.rowId), row]));
      const rowOf = (id: string) => {
        const row = byId.get(id);
        assert.ok(row, `population carries a row for ${id}`);
        return row;
      };
      const money = (row: Record<string, string | number | null>, key: string) => {
        const value = row[key];
        assert.ok(value !== null && value !== undefined, `${key} is reported`);
        return String(value);
      };

      // Authority-anchored outputs (two committed months each):
      // Jan € 13,83/mo, Piet € 69,58/mo + ARK € 231,17/mo, Truus € 0,00.
      assert.equal(cmp(money(rowOf(jan), "ingehouden"), "27.66"), 0);
      assert.equal(cmp(money(rowOf(jan), "loon"), "1998"), 0);
      assert.equal(cmp(money(rowOf(piet), "ingehouden"), "139.16"), 0);
      assert.equal(cmp(money(rowOf(piet), "arbeidskorting"), "462.34"), 0);
      assert.equal(cmp(money(rowOf(piet), "loon"), "6480"), 0);
      assert.equal(cmp(money(rowOf(truus), "ingehouden"), "0"), 0);
      assert.equal(cmp(money(rowOf(truus), "loon"), "1998"), 0);

      // The tie-out: every money box equals the independent stub sums.
      for (const [id, row] of byId) {
        const sums = await independentSums(fx.orgId, id);
        assert.equal(sums.runs, "2", "two committed runs feed each slip");
        assert.equal(cmp(String(row.loon), sums.loon), 0, "kolom 14 ties");
        assert.equal(cmp(String(row.ingehouden), sums.ingehouden), 0, "kolom 15 ties");
        assert.equal(cmp(String(row.arbeidskorting), sums.ark), 0, "kolom 18 ties");
        assert.equal(cmp(String(row.svLoon), sums.sv), 0, "SV-loon ties");
        assert.equal(cmp(String(row.zvwWerkgeversheffing), sums.zvw), 0, "Zvw ties");
        assert.equal(cmp(String(row.premies), sums.premies), 0, "premies tie");
        // The row grammar round-trips every emitted id and refuses others.
        assert.deepEqual(filing().parseRowId(String(row.rowId)), {
          employees: [String(row.rowId)], accounts: [],
        });
      }
      assert.equal(filing().parseRowId("not-a-row"), null);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "each slip carries its own arm, korting election, boxes and BSN posture",
  { skip: !DB },
  async () => {
    const fx = await nlPayrollOrg();
    try {
      const jan = await nlEmployee(fx, {
        name: "Jan Modaal", annualSalary: "11988",
        opgaaf: { apply_loonheffingskorting: "true" }, bsn: "111222333",
      });
      const piet = await nlEmployee(fx, {
        name: "Piet AOW", annualSalary: "38880",
        opgaaf: { apply_loonheffingskorting: "true", age_class: "aow_1946" },
      });
      await monthlyRun(fx, "2026-02-01", "2026-02-28", true);

      const slipOf = (id: string) => filing().slip!.build(fx.orgId, 2026, id);
      const janSlip = await slipOf(jan);
      const pietSlip = await slipOf(piet);
      assert.equal(janSlip.formNumber, "Jaaropgaaf");
      const header = (slip: Awaited<ReturnType<typeof slipOf>>, label: string) =>
        slip.headerFields.find((field) => field.label === label)?.value;
      const box = (slip: Awaited<ReturnType<typeof slipOf>>, code: string) =>
        slip.boxes.find((entry) => entry.code === code)?.value;

      // Per-arm reporting: same pack, different tabeltoepassing, different money.
      assert.match(header(janSlip, "Tabeltoepassing (leeftijdsklasse, per the opgaaf on file)")!, /Jonger dan de AOW/);
      assert.match(header(pietSlip, "Tabeltoepassing (leeftijdsklasse, per the opgaaf on file)")!, /1946/);
      assert.notEqual(box(janSlip, "15"), box(pietSlip, "15"));
      assert.equal(header(janSlip, "Loonheffingskorting toegepast (per the opgaaf on file)"), "Ja");

      // The §15.3 boxes with the authority's own kolom numbers
      // (scale-insensitive: numeric sums keep their 4-decimal scale).
      assert.equal(cmp(box(janSlip, "14")!, "999"), 0);
      assert.equal(cmp(box(janSlip, "15")!, "13.83"), 0);
      assert.equal(cmp(box(janSlip, "16")!, "0"), 0);
      assert.ok(
        (janSlip.notes ?? []).some((note) => note.includes("Kolom 16")),
        "the zero kolom 16 states its scope on the slip face",
      );

      // BSN: rendered from the sealed profile for Jan, a named gap for Piet.
      assert.equal(header(janSlip, "Burgerservicenummer (BSN)"), "111222333");
      assert.match(header(pietSlip, "Burgerservicenummer (BSN)")!, /Not on file/);
      assert.match(header(pietSlip, "Burgerservicenummer (BSN)")!, /payroll profile/);

      await assert.rejects(() => slipOf(randomUUID()), /no 2026 jaaropgaaf matches/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an empty year and an untranscribed year refuse by name, never as empty slips",
  { skip: !DB },
  async () => {
    const fx = await nlPayrollOrg();
    try {
      await assert.rejects(
        () => filing().population(fx.orgId, 2026),
        /no committed 2026 pay runs/,
      );
      await assert.rejects(
        () => filing().population(fx.orgId, 2025),
        /no transcribed loonheffing tables for 2025/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
