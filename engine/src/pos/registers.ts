import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import {
  resolveCurrencyQuantum,
  UnknownCurrencyPrecisionError,
  currencyPrecisionRemedy,
} from "../sales/currency-precision.ts";
import { posRefusal } from "./errors.ts";

/** Account types a register tender may settle into: bank or asset clearing, the native tender set. */
export const POS_TENDER_ACCOUNT_TYPES = ["asset_bank", "asset_current_other"] as const;

/** Tender kinds a register offers. Each is accepted exactly when its settlement is configured. */
export const POS_TENDER_KINDS = ["cash", "card", "stored_value", "other"] as const;
export type PosTenderKind = (typeof POS_TENDER_KINDS)[number];

export interface PosRegister {
  id: string;
  code: string;
  name: string;
  subsidiaryId: string;
  locationId: string | null;
  stockLocationId: string | null;
  defaultCustomerId: string | null;
  priceLevelId: string | null;
  cashAccountId: string;
  cardAccountId: string | null;
  otherAccountId: string | null;
  acceptsStoredValue: boolean;
  receiptHeader: string | null;
  receiptFooter: string | null;
  denominations: string[];
  currency: string;
  currencyDecimals: number;
}

/** Tender kinds the register accepts, in display order. */
export function acceptedTenderKinds(
  register: Pick<PosRegister, "cardAccountId" | "otherAccountId" | "acceptsStoredValue">,
): PosTenderKind[] {
  return POS_TENDER_KINDS.filter((kind) =>
    kind === "cash"
      ? true
      : kind === "card"
        ? register.cardAccountId !== null
        : kind === "other"
          ? register.otherAccountId !== null
          : register.acceptsStoredValue,
  );
}

type RegisterRow = Omit<PosRegister, "currency" | "currencyDecimals"> & {
  isActive: boolean;
  currency: string | null;
};

async function readRegister(
  runner: SqlExecutor,
  orgId: string,
  registerId: string,
  lock: boolean,
): Promise<RegisterRow | null> {
  if (!isUuid(registerId)) return null;
  const rows = await runner.execute<RegisterRow>(
    sql`
    select r.id, r.code, r.name, r.subsidiary_id as "subsidiaryId", r.location_id as "locationId",
           r.stock_location_id as "stockLocationId", r.default_customer_id as "defaultCustomerId",
           r.price_level_id as "priceLevelId", r.cash_account_id as "cashAccountId",
           r.card_account_id as "cardAccountId", r.other_account_id as "otherAccountId",
           r.accepts_stored_value as "acceptsStoredValue", r.receipt_header as "receiptHeader",
           r.receipt_footer as "receiptFooter", r.denominations, r.is_active as "isActive",
           coalesce(nullif(trim(s.base_currency), ''), o.base_currency) as currency
      from pos_registers r
      join orgs o on o.id = r.org_id
      join subsidiaries s on s.org_id = r.org_id and s.id = r.subsidiary_id
     where r.org_id = ${orgId} and r.id = ${registerId}
     ${lock ? sql`for update of r` : sql``}`,
    "objects",
  );
  return rows[0] ?? null;
}

async function assertTenderAccount(
  runner: SqlExecutor,
  orgId: string,
  accountId: string,
  label: string,
): Promise<void> {
  const row = (
    await runner.execute<{ type: string; is_active: boolean; is_summary: boolean }>(
      sql`
    select type, is_active, is_summary from accounts where org_id = ${orgId} and id = ${accountId}`,
      "objects",
    )
  )[0];
  if (
    !row ||
    !row.is_active ||
    row.is_summary ||
    !(POS_TENDER_ACCOUNT_TYPES as readonly string[]).includes(row.type)
  ) {
    throw posRefusal(
      `The register's ${label} account is not an active bank or clearing account.`,
      "register_misconfigured",
      422,
      `Choose an active bank or asset clearing account for ${label} on the register in Setup → Sales → Registers.`,
    );
  }
}

/**
 * Load a register for a sale, refund or drawer action. Fails closed: an
 * unknown or out-of-scope register reads as missing, an inactive one is
 * refused, and every configured settlement account is re-validated at use
 * so a register edited around its setup validation cannot post to an
 * account a tender must never settle into.
 */
export async function loadRegisterForUse(
  runner: SqlExecutor,
  orgId: string,
  registerId: string,
  options: { allowedSubsidiaryIds: ReadonlySet<string> | null; lock?: boolean },
): Promise<PosRegister> {
  const row = await readRegister(runner, orgId, registerId, options.lock === true);
  if (!row || !subsidiaryScopeAllows(options.allowedSubsidiaryIds, row.subsidiaryId)) {
    throw posRefusal(
      "This register does not exist in this organization.",
      "register_not_found",
      404,
      "Choose a register from the register list.",
    );
  }
  if (!row.isActive) {
    throw posRefusal(
      `Register ${row.code} is inactive.`,
      "register_inactive",
      422,
      "Reactivate the register in Setup → Sales → Registers, or choose another register.",
    );
  }
  if (!row.currency) {
    throw posRefusal(
      "The organization has no base currency.",
      "register_misconfigured",
      422,
      "Set the base currency in Company Settings.",
    );
  }
  await assertTenderAccount(runner, orgId, row.cashAccountId, "cash");
  if (row.cardAccountId) await assertTenderAccount(runner, orgId, row.cardAccountId, "card");
  if (row.otherAccountId)
    await assertTenderAccount(runner, orgId, row.otherAccountId, "other tender");
  let currencyDecimals: number;
  try {
    currencyDecimals = await resolveCurrencyQuantum(runner, row.currency);
  } catch (error) {
    if (error instanceof UnknownCurrencyPrecisionError) {
      throw posRefusal(
        error.message,
        "register_misconfigured",
        422,
        currencyPrecisionRemedy(row.currency),
      );
    }
    throw error;
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    subsidiaryId: row.subsidiaryId,
    locationId: row.locationId,
    stockLocationId: row.stockLocationId,
    defaultCustomerId: row.defaultCustomerId,
    priceLevelId: row.priceLevelId,
    cashAccountId: row.cashAccountId,
    cardAccountId: row.cardAccountId,
    otherAccountId: row.otherAccountId,
    acceptsStoredValue: row.acceptsStoredValue,
    receiptHeader: row.receiptHeader,
    receiptFooter: row.receiptFooter,
    denominations: [...(row.denominations ?? [])],
    currency: row.currency,
    currencyDecimals,
  };
}

/** Active registers the actor can use, for the register picker. */
export async function listUsableRegisters(
  runner: SqlExecutor,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<
  Array<{
    id: string;
    code: string;
    name: string;
    subsidiaryId: string;
    openSessionId: string | null;
    openedBy: string | null;
  }>
> {
  const rows = await runner.execute<{
    id: string;
    code: string;
    name: string;
    subsidiaryId: string;
    openSessionId: string | null;
    openedBy: string | null;
  }>(
    sql`
    select r.id, r.code, r.name, r.subsidiary_id as "subsidiaryId",
           s.id as "openSessionId", u.name as "openedBy"
      from pos_registers r
      left join pos_sessions s on s.org_id = r.org_id and s.register_id = r.id and s.status = 'open'
      left join users u on u.org_id = s.org_id and u.id = s.opened_by
     where r.org_id = ${orgId} and r.is_active
     order by r.code`,
    "objects",
  );
  return rows.filter((row) => subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiaryId));
}

/**
 * Setup-time register validation shared by the Setup drawer and imports:
 * settlement accounts must be active bank or clearing accounts, the walk-in
 * customer must hold an active customer role, and denominations must be
 * distinct positive amounts. Returns the refusal text, or null.
 */
export async function registerSetupRefusal(
  runner: SqlExecutor,
  orgId: string,
  body: Record<string, unknown>,
  rowId: string | undefined,
): Promise<string | null> {
  const current = rowId
    ? (
        await runner.execute<{
          cash_account_id: string;
          card_account_id: string | null;
          other_account_id: string | null;
          default_customer_id: string | null;
        }>(
          sql`
        select cash_account_id, card_account_id, other_account_id, default_customer_id
          from pos_registers where org_id = ${orgId} and id = ${rowId}`,
          "objects",
        )
      )[0]
    : undefined;
  if (rowId && !current) return "not found";
  const pick = (key: string, column: string | null | undefined): string | null => {
    if (Object.hasOwn(body, key)) {
      const value = body[key];
      return typeof value === "string" && value !== "" ? value : null;
    }
    return column ?? null;
  };
  const accounts: Array<[string, string | null]> = [
    ["cash", pick("cashAccountId", current?.cash_account_id)],
    ["card", pick("cardAccountId", current?.card_account_id)],
    ["other tender", pick("otherAccountId", current?.other_account_id)],
  ];
  if (!accounts[0]![1]) return "Choose the cash account the register's drawer takes cash into.";
  for (const [label, accountId] of accounts) {
    if (!accountId) continue;
    if (!isUuid(accountId)) return `Choose a valid ${label} account.`;
    const row = (
      await runner.execute<{ type: string; is_active: boolean; is_summary: boolean }>(
        sql`
      select type, is_active, is_summary from accounts where org_id = ${orgId} and id = ${accountId}`,
        "objects",
      )
    )[0];
    if (
      !row ||
      !row.is_active ||
      row.is_summary ||
      !(POS_TENDER_ACCOUNT_TYPES as readonly string[]).includes(row.type)
    ) {
      return `The ${label} account must be an active bank or asset clearing account — tenders never settle into income, receivable or payable accounts.`;
    }
  }
  const customerId = pick("defaultCustomerId", current?.default_customer_id);
  if (customerId) {
    if (!isUuid(customerId)) return "Choose a valid walk-in customer.";
    const customer = (
      await runner.execute<{ party_id: string }>(
        sql`
      select party_id from customer_roles where org_id = ${orgId} and party_id = ${customerId} and is_active`,
        "objects",
      )
    )[0];
    if (!customer) return "The walk-in customer must be an active customer.";
  }
  if (Object.hasOwn(body, "denominations")) {
    const raw = body.denominations;
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set<string>();
    for (const value of list) {
      if (
        typeof value !== "string" ||
        !/^\d{1,9}(\.\d{1,4})?$/.test(value.trim()) ||
        Number(value) <= 0
      ) {
        return "Enter each denomination as a positive amount, for example 20 or 0.25.";
      }
      const key = value
        .trim()
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, "");
      if (seen.has(key)) return `Denomination ${value} is listed twice.`;
      seen.add(key);
    }
  }
  return null;
}

/** Setup-time pay-in/pay-out reason validation: the account must be an active posting account. */
export async function cashReasonSetupRefusal(
  runner: SqlExecutor,
  orgId: string,
  body: Record<string, unknown>,
  rowId: string | undefined,
): Promise<string | null> {
  if (!Object.hasOwn(body, "accountId"))
    return rowId ? null : "Choose the account this reason posts against.";
  const accountId = body.accountId;
  if (typeof accountId !== "string" || !isUuid(accountId))
    return "Choose the account this reason posts against.";
  const row = (
    await runner.execute<{ is_active: boolean; is_summary: boolean; type: string }>(
      sql`
    select is_active, is_summary, type from accounts where org_id = ${orgId} and id = ${accountId}`,
      "objects",
    )
  )[0];
  if (!row || !row.is_active || row.is_summary)
    return "The reason's account must be an active posting account.";
  if (row.type === "asset_receivable" || row.type === "liability_payable") {
    return "A drawer cash movement cannot post to a receivable or payable control account — record customer and vendor money through their own documents.";
  }
  return null;
}
