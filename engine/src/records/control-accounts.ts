import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";

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
  // Statutory payroll withholdings and the employer shares remitted with them
  // (PAYE, NIC, PRSI, USC — the amounts a payroll run credits to a liability
  // and a remittance later debits). Deliberately NOT liability_payable: that
  // family holds vendor and subcontractor money, and a withheld-tax balance
  // parked there mingles employee tax with accounts payable. Every shipped
  // chart carries its deductions account as liability_current_other.
  payrollDeductions: ["liability_current_other"],
  // Personal charges on a company card are not an expense: the employee owes
  // the company. This is the debit side of that receivable (0171). A plain
  // asset_receivable account keeps the balance inside the AR control family;
  // asset_current_other keeps it visible without entering AR aging.
  employeeReceivable: ["asset_receivable", "asset_current_other"],
  fxUnrealizedGainLoss: ["income", "income_other", "expense", "expense_other"],
  fxRealizedGainLoss: ["income", "income_other", "expense", "expense_other"],
  // Cumulative translation adjustment: the equity reserve consolidation
  // books when intercompany balances eliminated at earlier rates are
  // retranslated at the period's current rate. Equity only — translation
  // differences never pass through profit or loss.
  translationAdjustment: ["equity"],
  retainagePayable: [
    "liability_payable",
    "liability_current_other",
    "liability_long_term",
  ],
  // Customer-side mirror of retainagePayable: withheld progress-billing
  // amounts live in receivables until release (the engine and
  // provisioning already read/write this key, but without a policy role the
  // settings writer silently dropped it and setup showed no slot).
  retainageReceivable: ["asset_receivable", "asset_current_other"],
  laborWip: [
    "asset_current_other",
    "asset_other",
    "cogs",
    "expense",
    "expense_other",
  ],
  mfgWip: ["asset_current_other", "asset_other"],
  mfgMaterialUsageVariance: ["cogs", "expense", "expense_other"],
  // Labor efficiency: actual shop-floor minutes against the frozen standard,
  // settled in-period. A P&L variance like material usage, never WIP.
  mfgLaborEfficiencyVariance: ["cogs", "expense", "expense_other"],
  // Period under/over-applied manufacturing overhead. Idle capacity stays
  // here and hits the period, never inflates inventory.
  mfgOverheadVariance: ["cogs", "expense", "expense_other"],
  // The contra credited when work-order costs absorb overhead. COGS-group
  // only: it must sit beside the overhead it offsets, never in income or
  // on the balance sheet.
  mfgOverheadApplied: ["cogs"],
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
  // Gift card and store credit balances customers have paid for but not yet
  // redeemed. A current liability by nature: it settles in goods, services
  // or refunds, never in cash beyond escheat. Gift card money parked in
  // revenue or payables misstates both, so only liability types qualify.
  storedValueLiability: ["liability_payable", "liability_current_other"],
  // Goods received but not yet billed (GRNI): the clearing account receipts
  // credit and vendor bills debit. A current liability by nature — it holds
  // what is owed for stock already in hand — so a newly mapped company
  // control must be payable-family. Profile accounts keep their own
  // save-time offset validation and are only required live and postable.
  receivedNotBilled: ["liability_payable", "liability_current_other"],
} as const;

export type ControlAccountRole = keyof typeof CONTROL_ACCOUNT_TYPE_POLICY;
export const CONTROL_ACCOUNT_ROLES = Object.keys(
  CONTROL_ACCOUNT_TYPE_POLICY,
) as ControlAccountRole[];

/**
 * Operator-facing name of each role, used in refusals so a rejected mapping
 * names the field the operator sees ("Translation adjustment"), never the
 * storage key. Typed against the policy, so a new role cannot ship without
 * one.
 */
export const CONTROL_ACCOUNT_ROLE_LABELS: Record<ControlAccountRole, string> = {
  ar: "Accounts receivable",
  ap: "Accounts payable",
  bank: "Default bank account",
  taxCollected: "Sales tax collected",
  taxPaid: "Sales tax paid",
  employeePayable: "Employee payable",
  payrollDeductions: "Payroll deductions payable",
  employeeReceivable: "Employee receivable",
  fxUnrealizedGainLoss: "Unrealized FX gain/loss",
  fxRealizedGainLoss: "Realized FX gain/loss",
  translationAdjustment: "Translation adjustment",
  retainagePayable: "Retainage payable",
  retainageReceivable: "Retainage receivable",
  laborWip: "Labor WIP",
  mfgWip: "Manufacturing WIP",
  mfgMaterialUsageVariance: "Material usage variance",
  mfgLaborEfficiencyVariance: "Labor efficiency variance",
  mfgOverheadVariance: "Overhead variance",
  mfgOverheadApplied: "Overhead applied",
  laborClearing: "Labor clearing",
  payrollVariance: "Payroll variance",
  unbilledReceivable: "Unbilled receivable",
  projectRevenue: "Project revenue",
  incomeTaxExpense: "Income tax expense",
  incomeTaxPayable: "Income tax payable",
  deferredTaxAsset: "Deferred tax asset",
  deferredTaxLiability: "Deferred tax liability",
  valuationAllowance: "Valuation allowance",
  storedValueLiability: "Stored value liability",
  receivedNotBilled: "Received not billed",
};

/** Operator-facing chart account-type names for control-account refusals. */
export const CONTROL_ACCOUNT_TYPE_LABELS: Readonly<Record<string, string>> = {
  asset_bank: "Bank",
  asset_receivable: "Accounts receivable",
  asset_current_other: "Other current asset",
  asset_fixed: "Fixed asset",
  asset_other: "Other asset",
  liability_payable: "Accounts payable",
  liability_card: "Credit card",
  liability_current_other: "Other current liability",
  liability_long_term: "Long-term liability",
  equity: "Equity",
  income: "Income",
  income_other: "Other income",
  cogs: "Cost of goods sold",
  expense: "Expense",
  expense_other: "Other expense",
  expense_deferred: "Deferred expense",
};

function accountTypeLabel(type: string): string {
  return CONTROL_ACCOUNT_TYPE_LABELS[type] ?? type;
}

/** The role's accepted account types as prose: "Equity", or
 *  "Other current asset or Other current liability". */
export function controlAccountExpectedTypes(role: ControlAccountRole): string {
  const labels = CONTROL_ACCOUNT_TYPE_POLICY[role].map(accountTypeLabel);
  return labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

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
export type ControlAccountRefusalReason = "missing" | "inactive" | "summary" | "type";

export class ControlAccountsIncompleteError extends Error {
  /** The rejected role and why, when the refusal concerns one mapping, so a
   *  settings surface can name the field in the operator's language. */
  readonly role?: ControlAccountRole;
  readonly reason?: ControlAccountRefusalReason;
  readonly accountType?: string;
  readonly allowedTypes?: readonly string[];
  constructor(
    message: string,
    detail: {
      role?: ControlAccountRole;
      reason?: ControlAccountRefusalReason;
      accountType?: string;
      allowedTypes?: readonly string[];
    } = {},
  ) {
    super(message);
    this.name = "ControlAccountsIncompleteError";
    this.role = detail.role;
    this.reason = detail.reason;
    this.accountType = detail.accountType;
    this.allowedTypes = detail.allowedTypes;
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
    const label = CONTROL_ACCOUNT_ROLE_LABELS[role];
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new ControlAccountsIncompleteError(
        `${label} control account must be a non-empty account id`,
        { role, reason: "missing" },
      );
    }

    const account = accounts.get(accountId);
    if (!account) {
      throw new ControlAccountsIncompleteError(
        `${label} control account ${accountId} does not exist in this organization`,
        { role, reason: "missing" },
      );
    }
    if (!account.isActive) {
      throw new ControlAccountsIncompleteError(
        `${label} control account is inactive — choose an active account`,
        { role, reason: "inactive" },
      );
    }
    if (account.isSummary) {
      throw new ControlAccountsIncompleteError(
        `${label} control account is a summary account — choose a postable account`,
        { role, reason: "summary" },
      );
    }
    const allowedTypes: readonly string[] = CONTROL_ACCOUNT_TYPE_POLICY[role];
    if (!allowedTypes.includes(account.type)) {
      throw new ControlAccountsIncompleteError(
        `${label} control account must be ${controlAccountExpectedTypes(role)}; the selected account is ${accountTypeLabel(account.type)}`,
        { role, reason: "type", accountType: account.type, allowedTypes },
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
      !isUuid(accountId)
    ) {
      throw new ControlAccountsIncompleteError(
        `${CONTROL_ACCOUNT_ROLE_LABELS[role]} control account id is invalid`,
        { role, reason: "missing" },
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

/**
 * One authoritative received-not-billed (GRNI) clearing policy for every
 * reader that posts or promises receipt accounting: the item costing
 * profile's account wins when set; otherwise the company-level
 * receivedNotBilled control account applies. Returns the account with its
 * source, or null when neither is configured — callers refuse with
 * receivedNotBilledMissingMessage, which names both places. The profile
 * account must be a live posting account; the company account is validated
 * against the type policy on read, so a mistyped control mapping fails
 * closed here instead of reaching the posting kernel.
 */
export async function resolveReceivedNotBilledAccount(
  executor: SqlExecutor,
  orgId: string,
  itemId: string,
): Promise<{ accountId: string; source: "profile" | "company" } | null> {
  const profile = (await executor.execute<{ accountId: string | null }>(sql`
    select received_not_billed_account_id as "accountId"
      from item_inventory_profiles
     where org_id = ${orgId} and item_id = ${itemId}`)).rows[0]?.accountId;
  if (profile) {
    const account = (await executor.execute<ControlAccountRecord>(sql`
      select id, type, is_active as "isActive", is_summary as "isSummary"
        from accounts
       where org_id = ${orgId} and id = ${profile}`)).rows[0];
    if (account?.isActive && !account.isSummary) {
      return { accountId: account.id, source: "profile" };
    }
  }
  const company = await loadControlAccountsForRoles(executor, orgId, [
    "receivedNotBilled",
  ]);
  if (company.receivedNotBilled) {
    return { accountId: company.receivedNotBilled, source: "company" };
  }
  return null;
}

/**
 * Validated read of selected control-account roles without re-checking the
 * whole registry: a caller that only needs one role must not inherit
 * another role's legacy-invalid mapping as a posting blocker.
 */
export async function loadControlAccountsForRoles(
  executor: SqlExecutor,
  orgId: string,
  roles: readonly ControlAccountRole[],
): Promise<OrgControlAccounts> {
  const stored = (await executor.execute<{ control: unknown }>(sql`
    select settings->'controlAccounts' as control
      from orgs
     where id = ${orgId}`)).rows[0]?.control;
  const raw =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {};
  const mappings: OrgControlAccounts = {};
  for (const role of roles) {
    const accountId = raw[role];
    if (typeof accountId !== "string" || accountId === "") continue;
    mappings[role] = accountId;
  }
  const ids = [...new Set(Object.values(mappings))];
  if (ids.length === 0) return mappings;
  const records = await executor.execute<ControlAccountRecord>(sql`
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

/**
 * Company-level received-not-billed account id for non-posting readers
 * (drawer proposals): null when unconfigured or invalid. Posting paths use
 * resolveReceivedNotBilledAccount and fail closed instead — a proposal must
 * never block data entry, while the posting refusal names the misconfigured
 * control explicitly.
 */
export async function loadCompanyReceivedNotBilledAccount(
  executor: SqlExecutor,
  orgId: string,
): Promise<string | null> {
  try {
    const controls = await loadControlAccountsForRoles(executor, orgId, [
      "receivedNotBilled",
    ]);
    return controls.receivedNotBilled ?? null;
  } catch (error) {
    if (error instanceof ControlAccountsIncompleteError) return null;
    throw error;
  }
}

/**
 * Fail-closed refusal shared by every received-not-billed reader: names the
 * item and both places that configure the account — the item's costing
 * profile and the company control account — so the operator never has to
 * guess which blank to fill.
 */
export function receivedNotBilledMissingMessage(itemLabel: string): string {
  return (
    `${itemLabel} has no received-not-billed account — set it on the item's ` +
    `costing profile, or set the company Received not billed control account ` +
    `under Company Settings, then retry`
  );
}

/** Control accounts shaped for PostingDeps: ar/ap/bank are mandatory before
 * any document may post. Fails closed on incomplete or invalid configuration
 * instead of letting unsafe account ids reach the posting kernel. */
export async function loadRequiredControlAccounts(
  orgId: string,
): Promise<
  Required<Pick<OrgControlAccounts, "ar" | "ap" | "bank">> &
    Pick<OrgControlAccounts, "taxCollected" | "taxPaid" | "employeePayable" | "employeeReceivable">
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
    employeeReceivable: c.employeeReceivable,
  };
}
