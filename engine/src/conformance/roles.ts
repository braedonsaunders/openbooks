/**
 * Role binding for the conformance corpus.
 *
 * Cases assert on semantic roles ("deferred revenue"), never on a chart-of-
 * accounts number, so every case stays valid across industry COA presets and
 * across tenants. This module produces the two bindings the runner needs:
 *
 *  - `syntheticRoles()` for `computation` cases: stable fake ids, no database.
 *  - `createConformanceOrg()` for `ledger` cases: a scratch tenant whose real
 *    accounts are bound to the same roles, plus the extra accounts the corpus
 *    needs that the general test fixture does not carry (accumulated
 *    depreciation, impairment, deferred tax, unrealized FX, contract asset).
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../test-fixtures.ts";
import type { LedgerContext, Role } from "./types.ts";

export const ROLES: readonly Role[] = [
  "ar",
  "ap",
  "bank",
  "revenue",
  "deferredRevenue",
  "recognizedRevenue",
  "contractAsset",
  "inventory",
  "cogs",
  "inventoryAdjustment",
  "inventoryClearing",
  "freight",
  "taxRecoverable",
  "taxPayable",
  "withholdingPayable",
  "fixedAsset",
  "accumulatedDepreciation",
  "impairmentLoss",
  "disposalGainLoss",
  "fxRealizedGainLoss",
  "fxUnrealizedGainLoss",
  "loanPayable",
  "incomeTaxExpense",
  "incomeTaxPayable",
  "deferredTaxAsset",
  "deferredTaxLiability",
  "rouAsset",
  "leaseLiability",
  "leaseExpense",
  "leaseInterestExpense",
  "rouAmortization",
] as const;

/**
 * Deterministic non-UUID ids for computation cases. Readable in a diff, and
 * impossible to confuse with a real account id if one ever leaks across tiers.
 */
export function syntheticRoles(): Record<Role, string> {
  const map = {} as Record<Role, string>;
  for (const role of ROLES) map[role] = `role:${role}`;
  return map;
}

/** Accounts the corpus needs beyond the shared scratch fixture. */
const EXTRA_ACCOUNTS: readonly [Role, string, string, string][] = [
  ["contractAsset", "1150", "Contract Asset", "asset_current_other"],
  ["fixedAsset", "1500", "Equipment at Cost", "asset_fixed"],
  ["accumulatedDepreciation", "1590", "Accumulated Depreciation", "asset_fixed"],
  ["impairmentLoss", "6800", "Impairment Loss", "expense"],
  ["disposalGainLoss", "7100", "Gain or Loss on Disposal", "expense_other"],
  ["fxUnrealizedGainLoss", "7020", "Unrealized FX Gain or Loss", "expense_other"],
  ["loanPayable", "2800", "Foreign Currency Loan", "liability_long_term"],
  ["incomeTaxExpense", "8000", "Income Tax Expense", "expense_other"],
  ["incomeTaxPayable", "2400", "Income Tax Payable", "liability_current_other"],
  ["deferredTaxAsset", "1600", "Deferred Tax Asset", "asset_other"],
  ["deferredTaxLiability", "2600", "Deferred Tax Liability", "liability_long_term"],
  ["rouAsset", "1700", "Right-of-Use Asset", "asset_fixed"],
  ["leaseLiability", "2700", "Lease Liability", "liability_long_term"],
  ["leaseExpense", "6900", "Operating Lease Cost", "expense"],
  ["leaseInterestExpense", "6910", "Lease Interest Expense", "expense_other"],
  ["rouAmortization", "6920", "Right-of-Use Amortization", "expense"],
];

export interface ConformanceOrg {
  roles: Record<Role, string>;
  ledger: LedgerContext;
  /** Reverse map for turning posted journal lines back into roles. */
  roleOf: Map<string, Role>;
  drop: () => Promise<void>;
}

/**
 * Build the ledger-tier tenant: the shared scratch org plus this corpus's extra
 * accounts, an attributable actor, USD registered for the foreign-currency
 * cases, and the control accounts the FX and tax services resolve from
 * `orgs.settings`.
 */
export async function createConformanceOrg(): Promise<ConformanceOrg> {
  const scratch: ScratchOrg = await createScratchOrg();
  const roles = {} as Record<Role, string>;

  // Bind the roles the shared fixture already provides.
  roles.ar = scratch.accounts.ar;
  roles.ap = scratch.accounts.ap;
  roles.bank = scratch.accounts.bank;
  roles.revenue = scratch.accounts.revenue;
  roles.deferredRevenue = scratch.accounts.deferred;
  roles.recognizedRevenue = scratch.accounts.recognized;
  roles.inventory = scratch.accounts.invAsset;
  roles.cogs = scratch.accounts.cogs;
  roles.inventoryAdjustment = scratch.accounts.adjustment;
  roles.inventoryClearing = scratch.accounts.clearing;
  roles.fxRealizedGainLoss = scratch.accounts.fxGainLoss;
  roles.freight = scratch.accounts.freight;
  roles.taxRecoverable = scratch.accounts.taxInput;
  roles.taxPayable = scratch.accounts.taxOutput;
  roles.withholdingPayable = scratch.accounts.withholding;

  for (const [role, number, name, type] of EXTRA_ACCOUNTS) {
    const id = randomUUID();
    roles[role] = id;
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable,
                            required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${scratch.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
              '[]'::jsonb, '{}'::jsonb, true)`);
  }

  // The shared fixture opens a single month. Recognition schedules, period-end
  // revaluation, and fiscal-year provision arithmetic all need a full year, so
  // open the remaining eleven months of 2026 on the same calendar.
  const calendar = (await db.execute<{ id: string }>(sql`
    select id from fiscal_calendars where org_id = ${scratch.orgId} limit 1`));
  const fiscalCalendarId = calendar.rows[0]!.id;
  for (let month = 1; month <= 12; month++) {
    if (month === 7) continue; // already created by the shared fixture
    const mm = String(month).padStart(2, "0");
    const startsOn = `2026-${mm}-01`;
    const endsOn = new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10);
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
                                      is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${scratch.orgId}, 2026, ${month}, ${`2026-${mm}`}, ${startsOn}, ${endsOn},
              false, ${fiscalCalendarId})`);
  }

  // The foreign-currency cases need a second ISO currency on the registry.
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('USD', 'United States Dollar', 2)
    on conflict (code) do nothing`);

  // Control accounts the FX revaluation and income-tax provision services
  // resolve from org settings. Merged, not replaced — the scratch fixture
  // already wrote ar/ap/bank/fxRealizedGainLoss.
  await db.execute(sql`
    update orgs
       set settings = settings || ${JSON.stringify({
         controlAccounts: {
           ar: roles.ar,
           ap: roles.ap,
           bank: roles.bank,
           fxRealizedGainLoss: roles.fxRealizedGainLoss,
           fxUnrealizedGainLoss: roles.fxUnrealizedGainLoss,
           incomeTaxExpense: roles.incomeTaxExpense,
           incomeTaxPayable: roles.incomeTaxPayable,
           deferredTaxAsset: roles.deferredTaxAsset,
           deferredTaxLiability: roles.deferredTaxLiability,
         },
       })}::jsonb
     where id = ${scratch.orgId}`);

  const actorId = await createScratchUser(scratch.orgId, "Conformance Runner", "accountant");

  const roleOf = new Map<string, Role>();
  for (const role of ROLES) {
    const account = roles[role];
    if (account) roleOf.set(account, role);
  }

  return {
    roles,
    roleOf,
    ledger: {
      orgId: scratch.orgId,
      subsidiaryId: scratch.subsidiaryId,
      bookId: scratch.bookId,
      periodId: scratch.periodId,
      stockLocationId: scratch.stockLocationId,
      customerId: scratch.customerId,
      vendorId: scratch.vendorId,
      actorId,
      date: scratch.date,
      items: {
        fifo: scratch.items.fifo,
        movingAvg: scratch.items.movingAvg,
        standard: scratch.items.standard,
        service: scratch.items.service,
      },
    },
    drop: () => dropScratchOrg(scratch.orgId),
  };
}
