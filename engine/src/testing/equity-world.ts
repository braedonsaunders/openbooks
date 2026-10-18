/**
 * A scratch legal entity for equity suites: the equity duties split across a
 * manager, an approver and an outsider, a holder, the equity accounts and an
 * account policy, a common class, and the monthly periods of the second half
 * of 2026 (July already exists on the scratch calendar).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createShareClass } from "../equity/structure.ts";
import { EquityError } from "../equity/errors.ts";
import { createScratchOrg, createScratchUser, seedPostingAccount, type ScratchOrg } from "./fixtures.ts";

export interface EquityAccounts {
  common: string;
  preferred: string;
  apic: string;
  apicShareBased: string;
  expense: string;
  treasury: string;
  convertible: string;
  interestExpense: string;
  accruedInterest: string;
  deposit: string;
}

export interface EquityWorld {
  org: ScratchOrg;
  managerId: string;
  approverId: string;
  outsiderId: string;
  holderId: string;
  accounts: EquityAccounts;
  commonClassId: string;
}

export async function setEquityFeature(orgId: string, key: string, on: boolean): Promise<void> {
  const updated = await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${key}}`}::text[], ${on ? "true" : "false"}::jsonb, true)
     where id = ${orgId} returning id`);
  assert.equal(updated.rows.length, 1, `feature ${key} written`);
}

async function grant(orgId: string, roleKey: string, permissions: string[]): Promise<void> {
  const updated = await db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb where org_id = ${orgId} and key = ${roleKey} returning id`);
  assert.equal(updated.rows.length, 1, `role ${roleKey} granted`);
}

/**
 * One equity account policy version. `lifecycle` also maps the note interest
 * and early-exercise deposit accounts.
 */
export async function seedEquityPolicy(w: Omit<EquityWorld, "commonClassId">, effectiveFrom: string, options: { lifecycle?: boolean } = {}): Promise<void> {
  const a = w.accounts;
  const lifecycle = options.lifecycle === true;
  await db.execute(sql`
    insert into equity_account_policies (org_id, subsidiary_id, effective_from, common_stock_account_id, preferred_stock_account_id,
      apic_account_id, apic_share_based_account_id, compensation_expense_account_id, treasury_stock_account_id,
      convertible_instruments_account_id, interest_expense_account_id, accrued_interest_account_id, early_exercise_deposit_account_id,
      reason, created_by, updated_by)
    values (${w.org.orgId}, ${w.org.subsidiaryId}, ${effectiveFrom}, ${a.common}, ${a.preferred}, ${a.apic}, ${a.apicShareBased},
      ${a.expense}, ${a.treasury}, ${a.convertible}, ${lifecycle ? a.interestExpense : null}, ${lifecycle ? a.accruedInterest : null},
      ${lifecycle ? a.deposit : null}, 'Initial equity accounts', ${w.approverId}, ${w.approverId})`);
}

/** Monthly periods August through December 2026 on the scratch calendar. */
async function seedSecondHalf(org: ScratchOrg): Promise<void> {
  const calendarId = (await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id from accounting_periods where org_id = ${org.orgId} and id = ${org.periodId}`)).rows[0]!.fiscal_calendar_id;
  for (let month = 8; month <= 12; month += 1) {
    const key = `2026-${String(month).padStart(2, "0")}`;
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${org.orgId}, 2026, ${month}, ${key}, ${`${key}-01`}::date,
        ((${`${key}-01`}::date + interval '1 month') - interval '1 day')::date, false, ${calendarId})`);
  }
}

export async function setupEquityWorld(options: { policy?: boolean; lifecycle?: boolean; policyFrom?: string } = {}): Promise<EquityWorld> {
  const org = await createScratchOrg();
  const managerId = await createScratchUser(org.orgId, "Equity Manager", "equity_manager");
  await grant(org.orgId, "equity_manager", ["equity.read", "equity.manage"]);
  const approverId = await createScratchUser(org.orgId, "Equity Approver", "equity_approver");
  await grant(org.orgId, "equity_approver", ["equity.read", "equity.approve"]);
  const outsiderId = await createScratchUser(org.orgId, "Equity Outsider", "equity_outsider");
  await grant(org.orgId, "equity_outsider", ["gl.read"]);
  await setEquityFeature(org.orgId, "equity", true);
  const holderId = await seedHolder(org.orgId, "Founder One");
  const accounts: EquityAccounts = {
    common: await seedPostingAccount(org.orgId, "3010", "Common Stock", "equity"),
    preferred: await seedPostingAccount(org.orgId, "3020", "Preferred Stock", "equity"),
    apic: await seedPostingAccount(org.orgId, "3100", "Additional Paid-in Capital", "equity"),
    apicShareBased: await seedPostingAccount(org.orgId, "3110", "Paid-in Capital - Share-based", "equity"),
    expense: await seedPostingAccount(org.orgId, "6400", "Stock Compensation Expense", "expense"),
    treasury: await seedPostingAccount(org.orgId, "3200", "Treasury Stock", "equity"),
    convertible: await seedPostingAccount(org.orgId, "2600", "Convertible Instruments", "liability_current_other"),
    interestExpense: await seedPostingAccount(org.orgId, "7100", "Interest Expense - Convertible Notes", "expense_other"),
    accruedInterest: await seedPostingAccount(org.orgId, "2610", "Accrued Interest - Convertible Notes", "liability_current_other"),
    deposit: await seedPostingAccount(org.orgId, "2620", "Early-Exercise Deposits", "liability_current_other"),
  };
  await seedSecondHalf(org);
  const base = { org, managerId, approverId, outsiderId, holderId, accounts };
  if (options.policy !== false) await seedEquityPolicy(base, options.policyFrom ?? "2026-01-01", { lifecycle: options.lifecycle });
  const commonClass = await createShareClass({
    orgId: org.orgId, actorId: managerId, subsidiaryId: org.subsidiaryId, code: "CS", name: "Common Stock", kind: "common",
    effectiveOn: "2026-01-01", authorizedShares: "10000000", parValue: "0.0001",
  });
  return { ...base, commonClassId: commonClass.id };
}

export async function seedHolder(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${id}, ${orgId}, 'person', ${name})`);
  return id;
}

/** A spot rate from one currency to another on a date. */
export async function seedSpotRate(orgId: string, from: string, to: string, asOf: string, rate: string): Promise<void> {
  await db.execute(sql`insert into currencies (code, name, minor_units) values (${from}, ${from}, 2) on conflict (code) do nothing`);
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${orgId}, ${from}, ${to}, ${asOf}, 'spot', ${rate}::numeric, 'manual')`);
}

export function equityRefusal(code: string) {
  return (error: unknown) => error instanceof EquityError && error.code === code;
}

export async function entryLines(orgId: string, entryId: string): Promise<{ account_id: string; amount: string; currency: string; txn_amount: string }[]> {
  return (await db.execute<{ account_id: string; amount: string; currency: string; txn_amount: string }>(sql`
    select account_id, amount::text as amount, currency, txn_amount::text as txn_amount
      from journal_lines where org_id = ${orgId} and entry_id = ${entryId} order by line_number`)).rows;
}

export async function accountBalance(orgId: string, accountId: string): Promise<string> {
  const row = (await db.execute<{ balance: string }>(sql`
    select coalesce(sum(jl.amount), 0)::numeric(19,4)::text as balance
      from journal_lines jl join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
     where jl.org_id = ${orgId} and jl.account_id = ${accountId} and je.status in ('posted', 'reversed')`)).rows[0];
  return row?.balance ?? "0.0000";
}

/** Sum of an entry's lines in ledger units: zero for a balanced entry. */
export function linesBalance(lines: readonly { amount: string }[]): bigint {
  return lines.reduce((sum, line) => sum + BigInt(line.amount.replace(".", "")), 0n);
}
