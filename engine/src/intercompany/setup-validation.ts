import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { transferPricingPolicyRefusal } from "./transfer-pricing.ts";

/**
 * Setup-time validation for intercompany configuration. Each function
 * returns the refusal to show the administrator, or null. Storage guards
 * enforce the same invariants again; these name the remedy before a write.
 */

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * A representing customer/vendor pair for one subsidiary: the subsidiary is
 * an active operating entity; each party holds the matching active role,
 * does not already transact with the entity it represents, represents no
 * other entity, and trades in a currency that is functional for one side of
 * the trade.
 */
export async function representingPartiesRefusal(
  runner: SqlExecutor,
  orgId: string,
  body: Record<string, unknown>,
  current: {
    subsidiary_id?: unknown;
    customer_party_id?: unknown;
    vendor_party_id?: unknown;
    is_active?: unknown;
  } | null,
  rowId: string | null,
): Promise<string | null> {
  const pick = (key: string, column: string): string | null =>
    body[key] !== undefined ? text(body[key]) : text(current?.[column as keyof typeof current]);
  const subsidiaryId = pick("subsidiaryId", "subsidiary_id");
  const customerPartyId = pick("customerPartyId", "customer_party_id");
  const vendorPartyId = pick("vendorPartyId", "vendor_party_id");
  const active =
    body.isActive !== undefined ? body.isActive !== false : current?.is_active !== false;
  if (!subsidiaryId || !isUuid(subsidiaryId))
    return "Choose the subsidiary these parties represent";
  if (!customerPartyId && !vendorPartyId)
    return "Choose a representing customer, a representing vendor, or both";
  if (!active) return null;
  const subsidiary = (
    await runner.execute<{
      name: string;
      base_currency: string;
      is_active: boolean;
      is_elimination: boolean;
    }>(
      sql`
    select name, base_currency, is_active, is_elimination from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}`,
      "objects",
    )
  )[0];
  if (!subsidiary) return "Choose a subsidiary of this organization";
  if (!subsidiary.is_active || subsidiary.is_elimination)
    return `${subsidiary.name} is not an active operating subsidiary`;
  const duplicateSubsidiary = (
    await runner.execute(
      sql`
    select 1 from intercompany_representing_parties
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId} and is_active and id is distinct from ${rowId}::uuid`,
      "objects",
    )
  )[0];
  if (duplicateSubsidiary)
    return `${subsidiary.name} already has representing parties; edit that record instead`;
  const root =
    (
      await runner.execute<{ id: string }>(
        sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null`,
        "objects",
      )
    )[0]?.id ?? null;
  for (const [partyId, role] of [
    [customerPartyId, "customer"],
    [vendorPartyId, "vendor"],
  ] as const) {
    if (!partyId) continue;
    if (!isUuid(partyId)) return `Choose a valid representing ${role}`;
    const party = (
      await runner.execute<{
        name: string;
        subsidiary_id: string | null;
        is_active: boolean;
        role_active: boolean | null;
        currency: string | null;
      }>(
        role === "customer"
          ? sql`select p.display_name as name, p.subsidiary_id, p.is_active, r.is_active as role_active, r.currency
              from parties p left join customer_roles r on r.org_id = p.org_id and r.party_id = p.id
             where p.org_id = ${orgId} and p.id = ${partyId}`
          : sql`select p.display_name as name, p.subsidiary_id, p.is_active, r.is_active as role_active, r.currency
              from parties p left join vendor_roles r on r.org_id = p.org_id and r.party_id = p.id
             where p.org_id = ${orgId} and p.id = ${partyId}`,
        "objects",
      )
    )[0];
    if (!party) return `The representing ${role} does not exist in this organization`;
    if (!party.is_active || party.role_active !== true)
      return `${party.name} is not an active ${role}`;
    const transacting = new Set<string>([party.subsidiary_id ?? root ?? ""]);
    for (const row of await runner.execute<{ subsidiary_id: string }>(
      sql`
      select subsidiary_id from party_subsidiaries where org_id = ${orgId} and party_id = ${partyId}`,
      "objects",
    )) {
      transacting.add(row.subsidiary_id);
    }
    if (transacting.has(subsidiaryId)) {
      return `${party.name} transacts with ${subsidiary.name}; a subsidiary cannot be its own ${role}. Remove ${subsidiary.name} from the ${role}'s subsidiaries or choose another ${role}`;
    }
    const duplicateParty = (
      await runner.execute(
        role === "customer"
          ? sql`select 1 from intercompany_representing_parties
             where org_id = ${orgId} and customer_party_id = ${partyId} and is_active and id is distinct from ${rowId}::uuid`
          : sql`select 1 from intercompany_representing_parties
             where org_id = ${orgId} and vendor_party_id = ${partyId} and is_active and id is distinct from ${rowId}::uuid`,
        "objects",
      )
    )[0];
    if (duplicateParty) return `${party.name} already represents another subsidiary`;
    if (party.currency) {
      const functional = (
        await runner.execute<{ base_currency: string }>(
          sql`
        select base_currency from subsidiaries
         where org_id = ${orgId} and id = any(${uuidArray([...transacting].filter(isUuid))}::uuid[])`,
          "objects",
        )
      ).map((row) => row.base_currency);
      if (party.currency !== subsidiary.base_currency && !functional.includes(party.currency)) {
        return `${party.name} trades in ${party.currency}, which is not the functional currency of ${subsidiary.name} or of a subsidiary it transacts with; change the ${role}'s currency`;
      }
    }
  }
  return null;
}

/** Transfer pricing policy validation before the storage guard. */
export async function transferPricingPolicySetupRefusal(
  runner: SqlExecutor,
  orgId: string,
  body: Record<string, unknown>,
  current: Record<string, unknown> | null,
): Promise<string | null> {
  const merged = (key: string, column: string): unknown =>
    body[key] !== undefined ? body[key] : current?.[column];
  const refusal = transferPricingPolicyRefusal({
    sellerSubsidiaryId: merged("sellerSubsidiaryId", "seller_subsidiary_id"),
    buyerSubsidiaryId: merged("buyerSubsidiaryId", "buyer_subsidiary_id"),
    method: merged("method", "method"),
    priceLevelId: merged("priceLevelId", "price_level_id"),
    markupPercent: merged("markupPercent", "markup_percent"),
    effectiveFrom: dateText(merged("effectiveFrom", "effective_from")),
    effectiveTo: dateText(merged("effectiveTo", "effective_to")),
  });
  if (refusal) return refusal;
  for (const [key, column, types, label] of [
    ["revenueAccountId", "revenue_account_id", ["income", "income_other"], "intercompany revenue"],
    ["costAccountId", "cost_account_id", ["cogs", "expense", "expense_other"], "intercompany cost"],
  ] as const) {
    const accountId = text(merged(key, column));
    if (!accountId || !isUuid(accountId)) return `Choose the ${label} account`;
    const account = (
      await runner.execute<{
        name: string;
        type: string;
        eliminate: boolean;
        is_active: boolean;
        is_summary: boolean;
      }>(
        sql`
      select name, type, eliminate, is_active, is_summary from accounts where org_id = ${orgId} and id = ${accountId}`,
        "objects",
      )
    )[0];
    if (!account || !account.is_active || account.is_summary)
      return `Choose an active posting account for ${label}`;
    if (!(types as readonly string[]).includes(account.type))
      return `${account.name} cannot carry ${label}; choose an account of type ${types.join(" or ")}`;
    if (!account.eliminate)
      return `${account.name} is not eliminated in consolidation; mark it Eliminate on consolidation in Chart of accounts`;
  }
  return null;
}

function dateText(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}
