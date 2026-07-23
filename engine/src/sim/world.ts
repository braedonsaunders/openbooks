import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../db.ts";
import { dropScratchOrg } from "../test-fixtures.ts";
import { ensureCloseDefaults } from "../close.ts";
import { seedProjectTypes } from "../seed-project-types.ts";
import { ensureReportDefinitions } from "../ensure-report-definitions.ts";
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
}

/** Chart of accounts: [key, number, name, type]. Types are verified enum values. */
const COA: [string, string, string, string][] = [
  ["bank", "1000", "Operating Cash", "asset_bank"],
  ["ar", "1100", "Accounts Receivable", "asset_receivable"],
  ["prepaid", "1200", "Prepaid Expenses", "asset_current_other"],
  ["taxInput", "1250", "Recoverable Tax", "asset_current_other"],
  ["inventory", "1300", "Inventory Asset", "asset_current_other"],
  ["ap", "2000", "Accounts Payable", "liability_payable"],
  ["accrued", "2100", "Accrued Liabilities", "liability_current_other"],
  ["taxOutput", "2250", "Tax Payable", "liability_current_other"],
  ["revenueService", "4000", "Service Revenue", "income"],
  ["revenueProduct", "4010", "Product Revenue", "income"],
  ["cogs", "5000", "Cost of Goods Sold", "expense"],
  ["materials", "5100", "Materials", "expense"],
  ["subcontractor", "5200", "Subcontractor Costs", "expense"],
  ["payroll", "6000", "Payroll", "expense"],
  ["rent", "6100", "Rent", "expense"],
  ["utilities", "6200", "Utilities", "expense"],
  ["insurance", "6300", "Insurance", "expense"],
  ["office", "6400", "Office & Software", "expense"],
  ["professionalFees", "6500", "Professional Fees", "expense"],
];

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
  return withBypass(async () => {
    const orgId = randomUUID();
    const cur = profile.baseCurrency;

    await db.execute(sql`
      insert into orgs (id, name, base_currency, country, settings, env_kind)
      values (${orgId}, ${profile.name}, ${cur}, ${profile.country}, '{}'::jsonb, 'production')`);

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

    // Chart of accounts.
    const accounts: Record<string, string> = {};
    for (const [key, number, name, type] of COA) {
      const id = randomUUID();
      accounts[key] = id;
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    }

    // Control accounts (posting reads these from orgs.settings).
    await db.execute(sql`
      update orgs set settings = ${JSON.stringify({ controlAccounts: { ar: accounts.ar, ap: accounts.ap, bank: accounts.bank } })}::jsonb
       where id = ${orgId}`);

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

    // Built-in configuration a fresh org needs.
    await ensureCloseDefaults(orgId, actors.admin);
    await seedProjectTypes(orgId, actors.admin);
    await ensureReportDefinitions(orgId);

    return { orgId, bookId, subsidiaryId, fiscalCalendarId, currency: cur, accounts, vendors, customers, actors, periods };
  });
}

/** Tear an org down completely (bypasses posted-entry immutability). */
export async function resetOrg(orgId: string): Promise<void> {
  await dropScratchOrg(orgId);
}
