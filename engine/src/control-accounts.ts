import { sql } from "drizzle-orm";
import { db } from "./db.ts";

/**
 * Every org-level account role that can feed a posting path. Account type is
 * the chart's authoritative normal-balance/statement semantic, so a role may
 * only point at types that make accounting sense for that role.
 */
export const CONTROL_ACCOUNT_TYPE_POLICY = {
  ar: ["asset_receivable"],
  ap: ["liability_payable"],
  bank: ["asset_bank"],
  taxCollected: ["liability_payable", "liability_current_other"],
  // Input tax may be tracked as a recoverable asset or netted through the same
  // payable control used for output tax (the standard industry charts do the
  // latter). Both retain balance-sheet semantics; P&L types remain invalid.
  taxPaid: [
    "asset_current_other",
    "asset_other",
    "liability_payable",
    "liability_current_other",
  ],
  employeePayable: ["liability_payable", "liability_current_other"],
  fxUnrealizedGainLoss: ["income", "income_other", "expense", "expense_other"],
  fxRealizedGainLoss: ["income", "income_other", "expense", "expense_other"],
  retainagePayable: [
    "liability_payable",
    "liability_current_other",
    "liability_long_term",
  ],
  laborWip: [
    "asset_current_other",
    "asset_other",
    "cogs",
    "expense",
    "expense_other",
  ],
  laborClearing: ["asset_current_other", "liability_current_other"],
  payrollVariance: ["cogs", "expense", "expense_other"],
  unbilledReceivable: ["asset_receivable", "asset_current_other"],
  projectRevenue: ["income", "income_other"],
  incomeTaxExpense: ["expense", "expense_other"],
  incomeTaxPayable: [
    "liability_payable",
    "liability_current_other",
    "liability_long_term",
  ],
  deferredTaxAsset: ["asset_current_other", "asset_other"],
  deferredTaxLiability: ["liability_current_other", "liability_long_term"],
  valuationAllowance: ["asset_current_other", "asset_other"],
} as const;

export type ControlAccountRole = keyof typeof CONTROL_ACCOUNT_TYPE_POLICY;
export const CONTROL_ACCOUNT_ROLES = Object.keys(
  CONTROL_ACCOUNT_TYPE_POLICY,
) as ControlAccountRole[];

/** Org-level control accounts from orgs.settings.controlAccounts. */
export type OrgControlAccounts = Partial<Record<ControlAccountRole, string>>;

export interface ControlAccountRecord extends Record<string, unknown> {
  id: string;
  type: string;
  isActive: boolean;
  isSummary: boolean;
}

/**
 * Callers map this configuration refusal to their 422-class surface. Invalid
 * legacy mappings deliberately share the incomplete-settings error family:
 * neither condition may be allowed to reach the posting kernel.
 */
export class ControlAccountsIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlAccountsIncompleteError";
  }
}

/**
 * Shared write/read boundary for control-account semantics. The settings route
 * calls this before persisting a mapping; loadControlAccounts calls it again so
 * imports or legacy/direct JSON writes cannot smuggle an invalid account into
 * a later posting.
 */
export function assertValidControlAccountMappings(
  mappings: OrgControlAccounts,
  accountRecords: readonly ControlAccountRecord[],
): void {
  const accounts = new Map(
    accountRecords.map((account) => [account.id, account]),
  );

  for (const role of CONTROL_ACCOUNT_ROLES) {
    const accountId = mappings[role];
    if (accountId === undefined) continue;
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new ControlAccountsIncompleteError(
        `${role} control account must be a non-empty account id`,
      );
    }

    const account = accounts.get(accountId);
    if (!account) {
      throw new ControlAccountsIncompleteError(
        `${role} control account ${accountId} does not exist in this organization`,
      );
    }
    if (!account.isActive) {
      throw new ControlAccountsIncompleteError(
        `${role} control account is inactive`,
      );
    }
    if (account.isSummary) {
      throw new ControlAccountsIncompleteError(
        `${role} control account is a summary account`,
      );
    }
    const allowedTypes: readonly string[] = CONTROL_ACCOUNT_TYPE_POLICY[role];
    if (!allowedTypes.includes(account.type)) {
      throw new ControlAccountsIncompleteError(
        `${role} control account type ${account.type} is incompatible; expected ${allowedTypes.join(", ")}`,
      );
    }
  }
}

function parseStoredControlAccounts(value: unknown): OrgControlAccounts {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const mappings: OrgControlAccounts = {};
  for (const role of CONTROL_ACCOUNT_ROLES) {
    const accountId = raw[role];
    if (accountId === undefined || accountId === null || accountId === "")
      continue;
    if (
      typeof accountId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        accountId,
      )
    ) {
      throw new ControlAccountsIncompleteError(
        `${role} control account id is invalid`,
      );
    }
    mappings[role] = accountId;
  }
  return mappings;
}

/**
 * Single validated reader of orgs.settings.controlAccounts for posting-rule
 * dependencies. Every configured role is checked, even when the immediate
 * caller only needs ar/ap/bank, so legacy-invalid policy always fails closed.
 */
export async function loadControlAccounts(
  orgId: string,
): Promise<OrgControlAccounts> {
  const configured = await db.execute<{ control: unknown }>(sql`
    select settings->'controlAccounts' as control
      from orgs
     where id = ${orgId}`);
  const mappings = parseStoredControlAccounts(configured.rows[0]?.control);
  const ids = [...new Set(Object.values(mappings))];
  if (ids.length === 0) return mappings;

  const records = await db.execute<ControlAccountRecord>(sql`
    select id, type, is_active as "isActive", is_summary as "isSummary"
      from accounts
     where org_id = ${orgId}
       and id in (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})`);
  assertValidControlAccountMappings(mappings, records.rows);
  return mappings;
}

/** Control accounts shaped for PostingDeps: ar/ap/bank are mandatory before
 * any document may post. Fails closed on incomplete or invalid configuration
 * instead of letting unsafe account ids reach the posting kernel. */
export async function loadRequiredControlAccounts(
  orgId: string,
): Promise<
  Required<Pick<OrgControlAccounts, "ar" | "ap" | "bank">> &
    Pick<OrgControlAccounts, "taxCollected" | "taxPaid" | "employeePayable">
> {
  const c = await loadControlAccounts(orgId);
  if (!c.ar || !c.ap || !c.bank) {
    throw new ControlAccountsIncompleteError(
      `org ${orgId} control accounts are incomplete: ar, ap, and bank must be configured in orgs.settings.controlAccounts before posting`,
    );
  }
  return {
    ar: c.ar,
    ap: c.ap,
    bank: c.bank,
    taxCollected: c.taxCollected,
    taxPaid: c.taxPaid,
    employeePayable: c.employeePayable,
  };
}
