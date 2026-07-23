import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../db.ts";
import { dropScratchOrg } from "../test-fixtures.ts";
import { ensureCloseDefaults } from "../close.ts";
import { seedProjectTypes } from "../seed-project-types.ts";
import { ensureReportDefinitions } from "../ensure-report-definitions.ts";
import { createScriptJournal } from "../journal-writes.ts";
import { assertSimOrg, SIM_ORG_PREFIX } from "./db-guard.ts";
import type { Profile } from "./profiles/index.ts";

/**
 * Provision a full accounting org for a profile, spanning the entire simulation
 * window. Mirrors the verified column layout of engine/src/test-fixtures.ts
 * createScratchOrg, but parameterized: profile currency, a real chart of
 * accounts, a vendor/customer population, role-scoped actors, and one accounting
 * period per month across [startDate, endDate] (so posting any simulated day
 * resolves a covering period). Reset uses dropScratchOrg.
 */

export interface SimVendor {
  id: string;
  name: string;
  termDays: number;
  expenseCategories: string[];
  billMin: number;
  billMax: number;
}

export interface SimCustomer {
  id: string;
  name: string;
  termDays: number;
  revenueCategories: string[];
  invoiceMin: number;
  invoiceMax: number;
  payment: { onTime: number; late: number; veryLate: number; shortPay: number; delinquent: number };
}

export interface SimPeriod {
  id: string;
  fiscalYear: number;
  month: number;
  name: string;
  startsOn: string;
  endsOn: string;
}

export interface SimOrg {
  orgId: string;
  bookId: string;
  subsidiaryId: string;
  fiscalCalendarId: string;
  currency: string;
  /** Semantic account keys → account id. */
  accounts: Record<string, string>;
  vendors: SimVendor[];
  customers: SimCustomer[];
  actors: Record<"apClerk" | "arClerk" | "controller" | "admin", string>;
  periods: SimPeriod[];
  /** Field crew for T&M labor (present when the chart supports the labor flow). */
  employees: { id: string; name: string; costRate: string; billRate: string }[];
  /** Time type + labor service item for time-entry logging (T&M). */
  timeTypeId: string | null;
  laborItemId: string | null;
  /** Active client engagements/jobs that billable work is logged against (bottom-up). */
  engagements: { id: string; customerId: string; code: string; name: string }[];
}

/**
 * A full, complex chart of accounts — a real company's books, not a stub. Proper
 * multi-bank cash, receivables with an allowance, prepaids, inventory/WIP, a fixed-
 * asset block with accumulated depreciation, current + long-term liabilities, a
 * complete EQUITY section (common stock, APIC, retained earnings, distributions,
 * opening-balance equity), multiple revenue streams, a COGS block, and a full
 * operating-expense breakdown. Semantic keys drive the generator/ops; the depth
 * is what makes the balance sheet and P&L read like a going concern.
 * [key, number, name, type] — types are verified account_type enum values.
 */
const COA: [string, string, string, string][] = [
  // ---- Assets ----
  ["bank", "1000", "Operating Cash", "asset_bank"],
  ["bankPayroll", "1010", "Payroll Checking", "asset_bank"],
  ["bankSavings", "1020", "Money Market Savings", "asset_bank"],
  ["ar", "1100", "Accounts Receivable", "asset_receivable"],
  ["retainageReceivable", "1150", "Retainage Receivable", "asset_receivable"],
  ["allowanceDoubtful", "1190", "Allowance for Doubtful Accounts", "asset_current_other"],
  ["prepaid", "1200", "Prepaid Expenses", "asset_current_other"],
  ["prepaidInsurance", "1210", "Prepaid Insurance", "asset_current_other"],
  ["taxInput", "1250", "Recoverable Sales Tax", "asset_current_other"],
  ["inventory", "1300", "Inventory", "asset_current_other"],
  ["unbilledRevenue", "1310", "Unbilled Revenue (WIP)", "asset_current_other"],
  ["employeeAdvances", "1400", "Employee Advances", "asset_current_other"],
  ["deposits", "1450", "Security Deposits", "asset_other"],
  ["equipment", "1500", "Equipment", "asset_fixed"],
  ["vehicles", "1510", "Vehicles", "asset_fixed"],
  ["furniture", "1520", "Furniture & Fixtures", "asset_fixed"],
  ["leasehold", "1530", "Leasehold Improvements", "asset_fixed"],
  ["accumDep", "1590", "Accumulated Depreciation", "asset_fixed"],
  // ---- Liabilities ----
  ["ap", "2000", "Accounts Payable", "liability_payable"],
  ["creditCard", "2050", "Corporate Credit Card", "liability_card"],
  ["accrued", "2100", "Accrued Liabilities", "liability_current_other"],
  ["employeePayable", "2110", "Employee Reimbursements Payable", "liability_current_other"],
  ["accruedPayroll", "2120", "Accrued Payroll", "liability_current_other"],
  ["deferredRevenue", "2200", "Deferred Revenue", "liability_current_other"],
  ["taxOutput", "2250", "Sales Tax Payable", "liability_current_other"],
  ["payrollTaxPayable", "2260", "Payroll Taxes Payable", "liability_current_other"],
  ["retainagePayable", "2300", "Retainage Payable", "liability_current_other"],
  ["currentDebt", "2400", "Current Portion of Long-Term Debt", "liability_current_other"],
  ["lineOfCredit", "2700", "Line of Credit", "liability_long_term"],
  ["notesPayable", "2800", "Notes Payable", "liability_long_term"],
  // ---- Equity ----
  ["commonStock", "3000", "Common Stock", "equity"],
  ["apic", "3100", "Additional Paid-In Capital", "equity"],
  ["retainedEarnings", "3200", "Retained Earnings", "equity"],
  ["distributions", "3300", "Owner Distributions", "equity"],
  ["openingBalanceEquity", "3900", "Opening Balance Equity", "equity"],
  // ---- Income ----
  ["revenueService", "4000", "Service Revenue", "income"],
  ["revenueProduct", "4010", "Product Revenue", "income"],
  ["revenueConsulting", "4020", "Consulting Revenue", "income"],
  ["otherIncome", "4900", "Other Income", "income_other"],
  ["interestIncome", "4910", "Interest Income", "income_other"],
  // ---- COGS ----
  ["cogs", "5000", "Cost of Services", "cogs"],
  ["materials", "5100", "Materials & Supplies", "cogs"],
  ["subcontractor", "5200", "Subcontractor Costs", "cogs"],
  ["directLabor", "5300", "Direct Labor", "cogs"],
  ["laborWip", "5350", "Billable Labor Cost", "cogs"],
  ["equipmentRental", "5400", "Equipment Rental", "cogs"],
  ["laborClearing", "2135", "Labor Clearing", "liability_current_other"],
  // ---- Operating expenses ----
  ["payrollOverhead", "6005", "Non-Billable / Bench Labor", "expense"],
  ["payroll", "6000", "Salaries & Wages", "expense"],
  ["benefits", "6010", "Employee Benefits", "expense"],
  ["payrollTaxExpense", "6020", "Payroll Tax Expense", "expense"],
  ["rent", "6100", "Rent", "expense"],
  ["utilities", "6200", "Utilities", "expense"],
  ["insurance", "6300", "Insurance", "expense"],
  ["office", "6400", "Office & Software", "expense"],
  ["professionalFees", "6500", "Professional Fees", "expense"],
  ["marketing", "6550", "Marketing & Advertising", "expense"],
  ["badDebt", "6600", "Bad Debt Expense", "expense"],
  ["travel", "6650", "Travel", "expense"],
  ["meals", "6660", "Meals & Entertainment", "expense"],
  ["depreciation", "6700", "Depreciation Expense", "expense"],
  ["bankFees", "6800", "Bank & Merchant Fees", "expense"],
  ["miscExpense", "6900", "Miscellaneous Expense", "expense_other"],
  ["interestExpense", "7000", "Interest Expense", "expense_other"],
  ["fxGainLoss", "7010", "Realized FX Gain/Loss", "expense_other"],
];

/**
 * A balanced opening balance sheet, posted as a journal on day one — so the
 * company starts as a going concern (cash, receivables, a depreciated fixed-asset
 * base, debt, paid-in capital) with the residual booked to Retained Earnings.
 * Signed base amounts: debit positive, credit negative; they sum to zero.
 * Scaled by `s` so different companies open at different sizes.
 */
function openingBalanceLines(accounts: Record<string, string>, s: number): { accountId: string; amount: number }[] {
  const raw: [string, number][] = [
    ["bank", 420_000], ["bankSavings", 260_000], ["ar", 185_000], ["prepaid", 24_000],
    ["prepaidInsurance", 31_000], ["inventory", 46_000], ["equipment", 640_000], ["vehicles", 185_000],
    ["furniture", 92_000], ["leasehold", 128_000], ["accumDep", -286_000], ["deposits", 18_000],
    ["ap", -98_000], ["creditCard", -21_500], ["accruedPayroll", -37_000], ["deferredRevenue", -52_000],
    ["currentDebt", -60_000], ["lineOfCredit", -150_000], ["notesPayable", -430_000],
    ["commonStock", -10_000], ["apic", -240_000],
  ];
  const lines = raw.map(([k, v]) => ({ accountId: accounts[k]!, amount: Math.round(v * s) }));
  // Retained Earnings is the balancing residual (prior years' accumulated result).
  const residual = lines.reduce((acc, l) => acc + l.amount, 0);
  lines.push({ accountId: accounts.retainedEarnings!, amount: -residual });
  return lines;
}

function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Enumerate (year, month) pairs from the start month through the end month. */
function monthsInWindow(startDate: string, endDate: string): { year: number; month: number }[] {
  const out: { year: number; month: number }[] = [];
  let y = Number(startDate.slice(0, 4));
  let m = Number(startDate.slice(5, 7));
  const endY = Number(endDate.slice(0, 4));
  const endM = Number(endDate.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ year: y, month: m });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export async function provisionOrg(profile: Profile, window: { startDate: string; endDate: string }): Promise<SimOrg> {
  const world = await withBypass(async () => {
    const orgId = randomUUID();
    const cur = profile.baseCurrency;

    await db.execute(sql`
      insert into orgs (id, name, base_currency, country, settings, env_kind)
      values (${orgId}, ${SIM_ORG_PREFIX + profile.name}, ${cur}, ${profile.country}, '{}'::jsonb, 'production')`);

    const fiscalCalendarId = randomUUID();
    await db.execute(sql`
      insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
                                    adjustment_period_enabled, is_default, is_active, config)
      values (${fiscalCalendarId}, ${orgId}, 'Default', 'monthly', 1, 1, 'UTC', false, true, true, '{}'::jsonb)`);

    const bookId = randomUUID();
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${bookId}, ${orgId}, 'PRI', 'Primary', true, true, true)`);

    const subsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${subsidiaryId}, ${orgId}, 'Main Co', ${cur}, ${profile.country}, '{}'::jsonb, false, true, '{}'::jsonb)`);

    await db.execute(sql`
      insert into locations (id, org_id, name, is_active, custom, subsidiary_include_children)
      values (${randomUUID()}, ${orgId}, 'HQ', true, '{}'::jsonb, true)`);

    // Accounting periods: one per month across the whole window.
    const periods: SimPeriod[] = [];
    for (const { year, month } of monthsInWindow(window.startDate, window.endDate)) {
      const id = randomUUID();
      const startsOn = `${year}-${String(month).padStart(2, "0")}-01`;
      const endsOn = lastDayOfMonth(year, month);
      const name = `${year}-${String(month).padStart(2, "0")}`;
      await db.execute(sql`
        insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${id}, ${orgId}, ${year}, ${month}, ${name}, ${startsOn}, ${endsOn}, false, ${fiscalCalendarId})`);
      periods.push({ id, fiscalYear: year, month, name, startsOn, endsOn });
    }

    // Chart of accounts — this company's own chart (or the default services one).
    const accounts: Record<string, string> = {};
    const chart = profile.coa ?? COA;
    for (const [key, number, name, type] of chart) {
      const id = randomUUID();
      accounts[key] = id;
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    }

    // Control accounts (posting reads these from orgs.settings) + sim tag. The
    // simHarness flag is what the destructive-op guard checks before any wipe.
    // Optional control accounts (labor WIP/clearing, unbilled, retainage, FX) are
    // wired only when this company's chart defines them.
    const control: Record<string, string> = { ar: accounts.ar!, ap: accounts.ap!, bank: accounts.bank! };
    for (const k of ["employeePayable", "retainageReceivable", "laborWip", "laborClearing", "unbilledReceivable", "projectRevenue", "payrollVariance"]) {
      if (accounts[k]) control[k] = accounts[k]!;
    }
    if (accounts.fxGainLoss) control.fxRealizedGainLoss = accounts.fxGainLoss;
    const settings: Record<string, unknown> = { simHarness: true, simProfile: profile.id, controlAccounts: control };
    // Turn labor costing ON when the chart has the labor-flow accounts (T&M builds).
    if (accounts.laborWip && accounts.laborClearing) {
      settings.laborCosting = { mode: "post", hoursPerDay: 8, annualHours: 2080, components: [] };
    }
    await db.execute(sql`update orgs set settings = ${JSON.stringify(settings)}::jsonb where id = ${orgId}`);

    // Vendor / customer population.
    const vendors: SimVendor[] = [];
    for (const v of profile.vendors) {
      const id = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${id}, ${orgId}, 'vendor', ${v.name}, true, '{}'::jsonb)`);
      vendors.push({ id, ...v });
    }
    const customers: SimCustomer[] = [];
    for (const c of profile.customers) {
      const id = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${id}, ${orgId}, 'customer', ${c.name}, true, '{}'::jsonb)`);
      customers.push({ id, ...c });
    }

    // Role-scoped actors (provenance for who did what).
    const mkUser = async (name: string, role: string): Promise<string> => {
      const id = randomUUID();
      await db.execute(sql`
        insert into users (id, org_id, email, name, password_hash, role, is_active)
        values (${id}, ${orgId}, ${`${role}-${id.slice(0, 8)}@sim.test`}, ${name}, 'x', ${role}, true)`);
      return id;
    };
    const actors = {
      apClerk: await mkUser("Alex Payable", "accountant"),
      arClerk: await mkUser("Robin Receivable", "accountant"),
      controller: await mkUser("Casey Controller", "admin"),
      admin: await mkUser("Sam Admin", "admin"),
    };

    // Field crew + a time type + a labor service item — the T&M labor flow, wired
    // only when this company's chart defines the labor accounts.
    const employees: SimOrg["employees"] = [];
    let timeTypeId: string | null = null;
    let laborItemId: string | null = null;
    if (accounts.laborWip && accounts.laborClearing) {
      const roster = profile.workforce ?? [
        { name: "Miguel Torres (Foreman)", costRate: "72.00", billRate: "165.00" },
        { name: "Dwayne Ellis (Journeyman)", costRate: "58.00", billRate: "135.00" },
        { name: "Priya Nair (Journeyman)", costRate: "56.00", billRate: "130.00" },
        { name: "Sam Whitaker (Apprentice)", costRate: "38.00", billRate: "95.00" },
        { name: "Rosa Delgado (Equip. Operator)", costRate: "64.00", billRate: "150.00" },
      ];
      for (const w of roster) {
        const id = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${id}, ${orgId}, 'employee', ${w.name}, true, '{}'::jsonb)`);
        employees.push({ id, name: w.name, costRate: w.costRate, billRate: w.billRate });
      }
      timeTypeId = randomUUID();
      await db.execute(sql`
        insert into time_types (id, org_id, name, cost_multiplier, bill_multiplier, is_billable_default, show_on_field_ticket)
        values (${timeTypeId}, ${orgId}, 'Regular Time', '1', '1', true, true)`);
      laborItemId = randomUUID();
      await db.execute(sql`
        insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation, income_account_id)
        values (${laborItemId}, ${orgId}, 'service', 'Field Labor (T&M)', true, true, '{}'::jsonb, 'billing', 'normal', ${accounts.revenueService})`);
    }

    // Built-in configuration a fresh org needs.
    await ensureCloseDefaults(orgId, actors.admin);
    await seedProjectTypes(orgId, actors.admin);

    // Client engagements for bottom-up billing (workers log billable time against
    // these). Governed T&M project type. Only for profiles that opt in via
    // engagementsPerCustomer (construction opens its own jobs explicitly).
    const engagements: SimOrg["engagements"] = [];
    const perCustomer = profile.engagementsPerCustomer ?? 0;
    if (accounts.laborWip && accounts.laborClearing && perCustomer > 0) {
      const tmTypeRow = (await db.execute(sql`
        select id from project_types where org_id = ${orgId} and key = 'time_and_materials' and is_active limit 1`)) as unknown as {
        rows: { id: string }[];
      };
      const tmType = tmTypeRow.rows[0];
      let n = 0;
      if (tmType) {
        for (const c of customers) {
          for (let i = 0; i < perCustomer; i++) {
            const id = randomUUID();
            const code = `ENG-${String(++n).padStart(3, "0")}`;
            const name = `${c.name} — Engagement ${i + 1}`;
            await db.execute(sql`
              insert into projects (id, org_id, name, code, status, project_type_id, customer_id, starts_on)
              values (${id}, ${orgId}, ${name}, ${code}, 'active', ${tmType.id}, ${c.id}, ${window.startDate})`);
            engagements.push({ id, customerId: c.id, code, name });
          }
        }
      }
    }

    await ensureReportDefinitions(orgId);

    return { orgId, bookId, subsidiaryId, fiscalCalendarId, currency: cur, accounts, vendors, customers, actors, periods, employees, timeTypeId, laborItemId, engagements };
  });

  // Opening balances — posted OUTSIDE the provisioning bypass block (createScriptJournal
  // opens its own transaction; running it inside withBypass's pinned tx would nest and
  // prematurely commit). Scaled so different companies open at different sizes.
  const scale = profile.openingScale ?? (profile.industry === "construction" ? 2.5 : 1);
  await withOrgContext(world.orgId, () =>
    createScriptJournal(
      world.orgId,
      world.actors.controller,
      {
        documentDate: window.startDate,
        memo: "Opening balances",
        referenceNumber: "OPENING",
        lines: openingBalanceLines(world.accounts, scale).map((l) => ({ accountId: l.accountId, amount: l.amount })),
      },
      { post: true },
    ),
  );

  return world;
}

/**
 * Completely wipe an org's rows across every table, order-independently. Unlike
 * dropScratchOrg's fixed list (which predates period-close tables), this covers
 * ANY sim org — including ones that have been through monthly/year-end closes
 * (close_runs, period_locks, blueprints, reporting packages). It defers the
 * deferrable circular FKs and, for the 152 non-deferrable FKs, retries deletes to
 * a fixpoint with per-table savepoints so ordering never has to be hand-computed.
 *
 * UNGUARDED — callers must ensure the org is disposable. resetOrg is the guarded
 * entry point.
 */
export async function wipeSimOrg(orgId: string): Promise<void> {
  await withBypass(async () => {
    await db.execute(sql`set local openbooks.amend = 'on'`);
    await db.execute(sql`set local openbooks.sandbox_wipe = 'on'`);
    await db.execute(sql`set constraints all deferred`);
    await db.execute(sql`update orgs set env_kind = 'sandbox' where id = ${orgId}`);
    // Posted inventory movements are guarded even under amend; demote first.
    await db.execute(sql`update inventory_movements set status = 'pending' where org_id = ${orgId}`);
    // Child tables without an org_id column (reached via their parent).
    await db.execute(sql`delete from tax_group_members where tax_group_id in (select id from tax_groups where org_id = ${orgId})`);
    await db.execute(sql`delete from file_blobs where version_id in (select v.id from file_versions v join files f on f.id = v.file_id where f.org_id = ${orgId})`);
    await db.execute(sql`delete from file_versions where file_id in (select id from files where org_id = ${orgId})`);

    // Exclude append-only tables (audit_log, *_events, close_signoffs, dunning_log,
    // ap_capture_*): a BEFORE DELETE guard hard-blocks their removal by design.
    // Their rows are immutable history and orphan harmlessly (no inbound FKs;
    // their own FKs are deferrable). An org with close/payment history therefore
    // cannot be hard-wiped — which is correct — but debris orgs have no such rows.
    const tbls = (await db.execute(sql`
      select c.table_name from information_schema.columns c
       where c.table_schema = 'public' and c.column_name = 'org_id' and c.table_name <> 'orgs'
         and c.table_name not in (
           select distinct cl.relname
             from pg_trigger tg
             join pg_class cl on cl.oid = tg.tgrelid
             join pg_proc pr on pr.oid = tg.tgfoid
            where not tg.tgisinternal and pg_get_functiondef(pr.oid) ilike '%append-only%'
         )`)) as unknown as {
      rows: { table_name: string }[];
    };
    let remaining = tbls.rows.map((r) => r.table_name);
    for (let pass = 0; pass < 15 && remaining.length > 0; pass++) {
      const stillBlocked: string[] = [];
      for (const t of remaining) {
        await db.execute(sql`savepoint sp`);
        try {
          await db.execute(sql`delete from ${sql.raw(`"${t}"`)} where org_id = ${orgId}`);
          await db.execute(sql`release savepoint sp`);
        } catch {
          await db.execute(sql`rollback to savepoint sp`);
          stillBlocked.push(t);
        }
      }
      if (stillBlocked.length === remaining.length) { remaining = stillBlocked; break; } // no progress
      remaining = stillBlocked;
    }
    if (remaining.length > 0) throw new Error(`wipeSimOrg: could not clear tables: ${remaining.join(", ")}`);
    await db.execute(sql`delete from orgs where id = ${orgId}`);
  });
}

/** Tear a SIM org down completely (guarded — refuses untagged orgs). */
export async function resetOrg(orgId: string): Promise<void> {
  await assertSimOrg(orgId);
  await wipeSimOrg(orgId);
}
