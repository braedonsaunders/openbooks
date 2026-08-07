/**
 * Migrate ad-hoc vacation accrual onto the entitlement-plan engine.
 *
 *   npx tsx scripts/migrate-vacation-to-entitlements.ts            # verify only
 *   npx tsx scripts/migrate-vacation-to-entitlements.ts --apply    # write
 *   npx tsx scripts/migrate-vacation-to-entitlements.ts --org=<id> # one tenant
 *
 * Vacation is the one entitlement OpenBooks already had, and it grew its own
 * private plumbing: `pay_stubs.vacation_accrued`,
 * `payroll_opening_balances.vacation_balance`, and the CA pack's
 * `vacation_accrual` / `vacation_payout` system components. That is a second
 * accrual mechanism beside the plan engine — precisely the parallel source of
 * truth the house standard forbids. This script folds it into the one engine:
 *
 *   1. seed a "VAC" entitlement_plan per org (money, accrue, percent of
 *      earnings, wired to the pack's existing components and the org's
 *      vacation payable account, so nothing about the GL changes);
 *   2. replay history into entitlement_ledger — opening balances, every
 *      committed stub's accrual, every committed vacation payout;
 *   3. VERIFY that each employee's replayed plan balance equals the balance
 *      the legacy expression produced, to the penny, and fail loudly if not.
 *
 * Step 3 is the point. A migration that cannot prove it preserved every
 * employee's balance is not a migration, it is a data loss with good
 * intentions. The verification runs on --apply AND on its own, so it can be
 * re-run at any time as a tie-out between the old columns and the new ledger.
 *
 * The replay is idempotent: run-sourced rows are keyed one per
 * (pay_run, plan, employee, kind) and the carry-in is keyed one per
 * (org, plan, employee), both by unique index. Re-running never inflates a
 * balance.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool, withBypassContext, withOrg } from "../engine/src/db.ts";
import { add, cmp, neg, roundMoney, sum } from "../engine/src/money.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onlyOrg = args.find((a) => a.startsWith("--org="))?.slice("--org=".length) ?? null;
// Print every employee compared, not only the failures. A tie-out that emits
// nothing but "PASSED" is indistinguishable from a tie-out that compared
// nothing, which is exactly how a verification becomes vacuous.
const verbose = args.includes("--verbose");

const VACATION_PLAN_CODE = "VAC";

interface OrgRow {
  id: string;
  name: string;
}

interface EmployeeReplay {
  employeePartyId: string;
  employeeName: string;
  /** The balance the legacy expression yields today. */
  legacyBalance: string;
  /** The balance SUM(entitlement_ledger) yields from the replayed movements. */
  replayedBalance: string;
  movements: number;
}

/**
 * The legacy vacation balance, computed with the SAME expression
 * engine/src/payroll-run.ts uses for a termination payout: the tax year's
 * opening balance, plus every committed stub's accrual, less every committed
 * vacation payout.
 *
 * NOTE the asymmetry, which is faithfully preserved here: the opening balance
 * is read for ONE tax year while the accruals and payouts span all years. That
 * is what the product computed, so that is what the replay must equal. It is
 * reported as a known defect at the end of every run (see `reportKnownDefects`)
 * rather than silently "corrected" during a migration.
 *
 * The employee population must produce EXACTLY ONE ROW PER EMPLOYEE. It did
 * not: a bare UNION of (employee, max stub year) with (employee, max opening
 * year) emits two rows whenever those years differ — which is every employee
 * with a prior-year conversion opening balance and current-year stubs, i.e.
 * every converted tenant. The outer select then computes a DIFFERENT balance
 * for each (the opening-balance subquery is keyed on e.tax_year, so one row
 * carries the carry-in and the other reads zero), and `new Map(rows.map(...))`
 * keeps whichever Postgres happened to return last. With no ORDER BY, the
 * penny-exact tie-out this whole script exists to be flipped between "with
 * opening balance" and "without" from run to run.
 *
 * So the year is chosen explicitly, and it is chosen to match the REPLAY:
 * `replayLedger` and `projectedBalances` both carry in the opening row of
 * max(tax_year) where vacation_balance <> 0, so the legacy side must read that
 * same year. Employees with no opening row fall back to their last stub year,
 * where the carry-in is zero either way.
 */
export async function legacyVacationBalances(orgId: string): Promise<Map<string, string>> {
  const rows = (await db.execute(sql`
    with stub_years as (
      select s.employee_party_id, max(s.tax_year) as tax_year
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
       where s.org_id = ${orgId}
       group by s.employee_party_id
    ),
    opening_years as (
      select b.employee_party_id, max(b.tax_year) as tax_year
        from payroll_opening_balances b
       where b.org_id = ${orgId} and b.vacation_balance <> 0
       group by b.employee_party_id
    ),
    employees as (
      select coalesce(s.employee_party_id, o.employee_party_id) as employee_party_id,
             coalesce(o.tax_year, s.tax_year) as tax_year
        from stub_years s
        full outer join opening_years o
          on o.employee_party_id = s.employee_party_id
    )
    select e.employee_party_id,
      (
        coalesce((select b.vacation_balance from payroll_opening_balances b
                   where b.org_id = ${orgId} and b.employee_party_id = e.employee_party_id
                     and b.tax_year = e.tax_year), 0)
        + coalesce((select sum(s.vacation_accrued) from pay_stubs s
                      join pay_runs r on r.document_id = s.pay_run_document_id
                     where s.org_id = ${orgId} and s.employee_party_id = e.employee_party_id
                       and r.run_status = 'committed'), 0)
        - coalesce((select sum(l.amount) from pay_stub_lines l
                      join pay_stubs s on s.id = l.stub_id
                      join pay_runs r on r.document_id = s.pay_run_document_id
                      join pay_components c on c.id = l.component_id
                     where s.org_id = ${orgId} and s.employee_party_id = e.employee_party_id
                       and r.run_status = 'committed' and c.system_key = 'vacation_payout'), 0)
      )::text as balance
      from employees e
  `)) as unknown as { rows: { employee_party_id: string; balance: string }[] };
  // Collapsing rows into a Map is what HID the duplicate-row defect: two rows
  // for one employee silently became "whichever Postgres returned last".
  // Never again — an ambiguous population is a failed migration, loudly.
  const seen = new Set<string>();
  for (const row of rows.rows) {
    if (seen.has(row.employee_party_id)) {
      throw new Error(
        `legacy vacation balance is ambiguous for employee ${row.employee_party_id}: `
        + "the population query returned more than one row, so the tie-out would "
        + "depend on row order. Fix the population query, not this check.",
      );
    }
    seen.add(row.employee_party_id);
  }
  return new Map(rows.rows.map((r) => [r.employee_party_id, roundMoney(r.balance, 4)]));
}

/**
 * Seed (or refresh) the org's Vacation plan. The plan deliberately reuses the
 * pack's existing vacation components and the org's configured vacation
 * payable account: after the migration the GL projection of a pay run is
 * byte-identical to what it was before.
 *
 * The plan's accrual value is the org's most common
 * employee_payroll_profiles.vacation_percent — the base rate. Per-employee
 * rates keep their one home on the payroll profile; service tiers raise them.
 */
async function ensureVacationPlan(orgId: string): Promise<string | null> {
  // `max(uuid)` is not a Postgres aggregate — this query threw on every run,
  // which is why the tie-out this script exists for had never executed against
  // a real tenant. Take the OLDEST component of each system key instead
  // (deterministic; a pack seeds exactly one of each).
  const components = (await db.execute(sql`
    select
      (array_agg(id order by created_at, id)
         filter (where system_key = 'vacation_accrual'))[1] as accrual_id,
      (array_agg(id order by created_at, id)
         filter (where system_key = 'vacation_payout'))[1] as payout_id
      from pay_components where org_id = ${orgId}
  `)) as unknown as { rows: { accrual_id: string | null; payout_id: string | null }[] };
  const accrualComponentId = components.rows[0]?.accrual_id ?? null;
  const payoutComponentId = components.rows[0]?.payout_id ?? null;

  const settings = (await db.execute(sql`
    select settings#>>'{payroll,vacationPayableAccountId}' as account_id from orgs where id = ${orgId}
  `)) as unknown as { rows: { account_id: string | null }[] };

  const modal = (await db.execute(sql`
    select vacation_percent::text as percent, count(*)::int as n
      from employee_payroll_profiles
     where org_id = ${orgId} and vacation_percent is not null and vacation_percent > 0
     group by vacation_percent
     order by n desc, vacation_percent asc
     limit 1
  `)) as unknown as { rows: { percent: string; n: number }[] };
  const accrualValue = modal.rows[0]?.percent ?? "4";

  if (!apply) return null;
  const inserted = (await db.execute(sql`
    insert into entitlement_plans (org_id, code, name, unit, direction, accrual_method,
                                   accrual_value, accrual_component_id, payout_component_id,
                                   liability_account_id, cap_behavior, is_active)
    values (${orgId}, ${VACATION_PLAN_CODE}, 'Vacation', 'money', 'accrue', 'percent_of_earnings',
            ${roundMoney(accrualValue, 4)}, ${accrualComponentId}, ${payoutComponentId},
            ${settings.rows[0]?.account_id ?? null}, 'warn', true)
    on conflict (org_id, code) do update
       set accrual_component_id = coalesce(entitlement_plans.accrual_component_id, excluded.accrual_component_id),
           payout_component_id = coalesce(entitlement_plans.payout_component_id, excluded.payout_component_id),
           liability_account_id = coalesce(entitlement_plans.liability_account_id, excluded.liability_account_id),
           updated_at = now()
    returning id
  `)) as unknown as { rows: { id: string }[] };
  return inserted.rows[0]!.id;
}

/** Replay opening balances, committed accruals, and committed payouts. */
async function replayLedger(orgId: string, planId: string): Promise<void> {
  // Carry-in: the opening balance row's vacation figure, dated 1 January of
  // its tax year. Keyed by the partial unique index, so re-runs are no-ops.
  await db.execute(sql`
    insert into entitlement_ledger (org_id, plan_id, employee_party_id, movement_date,
                                    amount, kind, note)
    select b.org_id, ${planId}, b.employee_party_id,
           make_date(b.tax_year, 1, 1), b.vacation_balance, 'opening',
           'Migrated from payroll_opening_balances.vacation_balance'
      from payroll_opening_balances b
     where b.org_id = ${orgId} and b.vacation_balance <> 0
       and b.tax_year = (select max(b2.tax_year) from payroll_opening_balances b2
                          where b2.org_id = b.org_id and b2.employee_party_id = b.employee_party_id
                            and b2.vacation_balance <> 0)
    on conflict do nothing
  `);

  // Accruals: one per committed stub that accrued vacation, tied to its run.
  await db.execute(sql`
    insert into entitlement_ledger (org_id, plan_id, employee_party_id, movement_date,
                                    amount, kind, pay_run_document_id, stub_line_id, note)
    select s.org_id, ${planId}, s.employee_party_id, s.pay_date, s.vacation_accrued, 'accrual',
           s.pay_run_document_id,
           (select l.id from pay_stub_lines l
              join pay_components c on c.id = l.component_id
             where l.stub_id = s.id and c.system_key = 'vacation_accrual'
             order by l.sequence limit 1),
           'Migrated from pay_stubs.vacation_accrued'
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
     where s.org_id = ${orgId} and s.vacation_accrued <> 0
    on conflict do nothing
  `);

  // Payouts: the vacation_payout earning lines, negated (money leaving the bank).
  await db.execute(sql`
    insert into entitlement_ledger (org_id, plan_id, employee_party_id, movement_date,
                                    amount, kind, pay_run_document_id, stub_line_id, note)
    select s.org_id, ${planId}, s.employee_party_id, s.pay_date, -sum(l.amount), 'payout',
           s.pay_run_document_id, min(l.id), 'Migrated from vacation_payout stub lines'
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id
     where s.org_id = ${orgId} and c.system_key = 'vacation_payout'
     group by s.org_id, s.employee_party_id, s.pay_date, s.pay_run_document_id, s.id
    having sum(l.amount) <> 0
    on conflict do nothing
  `);
}

/**
 * Replayed balances straight out of the ledger — SUM(entitlement_ledger), the
 * only definition of a plan balance there is.
 */
async function replayedBalances(orgId: string, planId: string): Promise<Map<string, { balance: string; movements: number }>> {
  const rows = (await db.execute(sql`
    select employee_party_id, sum(amount)::text as balance, count(*)::int as movements
      from entitlement_ledger
     where org_id = ${orgId} and plan_id = ${planId}
     group by employee_party_id
  `)) as unknown as { rows: { employee_party_id: string; balance: string; movements: number }[] };
  return new Map(rows.rows.map((r) => [
    r.employee_party_id,
    { balance: roundMoney(r.balance, 4), movements: r.movements },
  ]));
}

/**
 * The dry-run replay: compute what the ledger WOULD contain, without writing
 * anything, so the verification can run against a tenant before the migration
 * is applied. Same three sources, same signs.
 */
export async function projectedBalances(orgId: string): Promise<Map<string, { balance: string; movements: number }>> {
  const rows = (await db.execute(sql`
    select employee_party_id, sum(amount)::text as balance, count(*)::int as movements from (
      select b.employee_party_id, b.vacation_balance as amount
        from payroll_opening_balances b
       where b.org_id = ${orgId} and b.vacation_balance <> 0
         and b.tax_year = (select max(b2.tax_year) from payroll_opening_balances b2
                            where b2.org_id = b.org_id and b2.employee_party_id = b.employee_party_id
                              and b2.vacation_balance <> 0)
      union all
      select s.employee_party_id, s.vacation_accrued as amount
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
       where s.org_id = ${orgId} and s.vacation_accrued <> 0
      union all
      select s.employee_party_id, -l.amount as amount
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id
        join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
        join pay_components c on c.id = l.component_id
       where s.org_id = ${orgId} and c.system_key = 'vacation_payout'
    ) movements
    group by employee_party_id
  `)) as unknown as { rows: { employee_party_id: string; balance: string; movements: number }[] };
  return new Map(rows.rows.map((r) => [
    r.employee_party_id,
    { balance: roundMoney(r.balance, 4), movements: r.movements },
  ]));
}

async function employeeNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = (await db.execute(sql`
    select id, display_name from parties
     where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])
  `)) as unknown as { rows: { id: string; display_name: string }[] };
  return new Map(rows.rows.map((r) => [r.id, r.display_name]));
}

/**
 * Penny-exact tie-out between the legacy expression and the plan ledger. Any
 * difference at all — one cent on one employee — fails the whole migration.
 */
async function verify(orgId: string, planId: string | null): Promise<{
  checked: number; mismatches: EmployeeReplay[]; compared: EmployeeReplay[];
  totalLegacy: string; totalReplayed: string;
}> {
  const legacy = await legacyVacationBalances(orgId);
  const replayed = planId ? await replayedBalances(orgId, planId) : await projectedBalances(orgId);
  const ids = [...new Set([...legacy.keys(), ...replayed.keys()])];
  const names = await employeeNames(orgId, ids);

  const mismatches: EmployeeReplay[] = [];
  const compared: EmployeeReplay[] = [];
  for (const id of ids) {
    const legacyBalance = legacy.get(id) ?? "0.0000";
    const entry = replayed.get(id) ?? { balance: "0.0000", movements: 0 };
    const row: EmployeeReplay = {
      employeePartyId: id,
      employeeName: names.get(id) ?? id,
      legacyBalance,
      replayedBalance: entry.balance,
      movements: entry.movements,
    };
    compared.push(row);
    if (cmp(legacyBalance, entry.balance) !== 0) mismatches.push(row);
  }
  return {
    checked: ids.length,
    mismatches,
    compared,
    totalLegacy: sum([...legacy.values()]),
    totalReplayed: sum([...replayed.values()].map((v) => v.balance)),
  };
}

/**
 * The report the header comment promises, and that did not exist.
 *
 * A migration that faithfully reproduces a defective expression has to SAY so,
 * every time it runs, or "the tie-out passed" quietly becomes "the old numbers
 * were right". These are preserved deliberately; each is an engine fix, not a
 * migration fix, because changing them here would move balances under cover of
 * a data move.
 */
function reportKnownDefects(): void {
  console.log("");
  console.log("known defects preserved by this replay (engine-side fixes, not migration fixes):");
  console.log(
    "  1. The opening balance is read for ONE tax year while accruals and payouts span\n"
    + "     ALL years. An employee with opening balances in more than one year therefore\n"
    + "     carries in only the latest non-zero one. Both sides of the tie-out do this,\n"
    + "     so the migration is faithful; the ENGINE should carry every year forward.",
  );
  console.log(
    "  2. The legacy balance has no notion of a plan, so it cannot distinguish vacation\n"
    + "     from any other accrued bank. That is why the replay seeds exactly one 'VAC'\n"
    + "     plan per org and why a second money bank cannot be migrated by this script.",
  );
  console.log(
    "  3. Both sides count a run only while pay_runs.run_status = 'committed', so a\n"
    + "     VOIDED run drops out of both at once and the tie-out stays exact. The plan\n"
    + "     ledger, however, has no run-status predicate at all — voiding a run must\n"
    + "     REVERSE its entitlement movements (engine/src/document-void.ts does), or the\n"
    + "     two sides diverge by the voided accrual. Re-run this after any pay-run void.",
  );
}

async function main(): Promise<number> {
  // Listing tenants is trusted, org-spanning maintenance; the per-org work
  // below runs inside that org's own RLS context.
  const orgs = (await withBypassContext(() => db.execute(
    onlyOrg
      ? sql`select id, name from orgs where id = ${onlyOrg}`
      : sql`select id, name from orgs order by created_at`,
  ))) as unknown as { rows: OrgRow[] };
  if (orgs.rows.length === 0) {
    // Zero here is almost never an empty database. It is what a tenant-spanning
    // read looks like when RLS denied it: the `orgs` policy returns no rows
    // rather than an error when `app.bypass_rls` is off. Say so, loudly, so
    // nobody reads "0 employees checked" as a clean tie-out again.
    console.error(
      "no orgs visible — either the database is genuinely empty, or this process "
      + "did not hold RLS bypass (see withBypassContext in engine/src/db.ts). "
      + "Confirm with: psql \"$OPENBOOKS_DB_URL\" -c \"set app.bypass_rls='on'\" -c 'select count(*) from orgs'",
    );
    return 1;
  }

  const installed = ((await db.execute(sql`
    select to_regclass('public.entitlement_plans') is not null as ok
  `)) as unknown as { rows: { ok: boolean }[] }).rows[0]!.ok;
  if (apply && !installed) {
    console.error(
      "entitlement tables are not present — apply schema/migrations/generated/0003_payroll_entitlements.sql first",
    );
    return 1;
  }

  let failed = false;
  for (const org of orgs.rows) {
    await withOrg(org.id, async () => {
      const planId = installed ? await ensureVacationPlan(org.id) : null;
      if (apply && planId) await replayLedger(org.id, planId);

      // The verification is useful BEFORE the schema lands: both sides read
      // only the legacy payroll tables, so a dry run against a tenant that has
      // not been migrated still proves the replay is faithful.
      const existing = planId ?? (installed
        ? ((await db.execute(sql`
            select id from entitlement_plans where org_id = ${org.id} and code = ${VACATION_PLAN_CODE}
          `)) as unknown as { rows: { id: string }[] }).rows[0]?.id ?? null
        : null);

      const result = await verify(org.id, existing);
      const mode = apply ? "applied" : "dry run";
      const drift = add(result.totalReplayed, neg(result.totalLegacy));
      console.log(
        `org "${org.name}" (${mode}): ${result.checked} employees, `
        + `legacy ${result.totalLegacy}, replayed ${result.totalReplayed}, drift ${drift}`,
      );
      if (result.mismatches.length > 0) {
        failed = true;
        console.error(
          `  REPLAY VERIFICATION FAILED — ${result.mismatches.length} employee(s) do not tie out:`,
        );
        for (const m of result.mismatches.slice(0, 50)) {
          console.error(
            `    ${m.employeeName}: legacy ${m.legacyBalance} vs replayed ${m.replayedBalance} `
            + `(${m.movements} movements)`,
          );
        }
      } else if (result.checked > 0) {
        if (verbose) {
          for (const row of result.compared) {
            console.log(
              `    ${row.employeeName}: legacy ${row.legacyBalance} = replayed `
              + `${row.replayedBalance} (${row.movements} movements)`,
            );
          }
        }
        console.log("  replay verification PASSED — every balance ties to the penny");
      } else {
        // Never call an empty comparison a pass. Zero employees checked means
        // the tie-out proved nothing at all.
        console.log(
          "  replay verification INCONCLUSIVE — no employee has vacation history in this org",
        );
      }
    });
  }
  reportKnownDefects();
  return failed ? 1 : 0;
}

/**
 * Run only when invoked as a script. Importing this module (the migration's
 * own tests do) must never execute a migration or close the shared pool.
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  void (async () => {
    try {
      process.exitCode = await main();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
