import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./coa";
import { items } from "./documents";
import { auditColumns, id, orgRef } from "./helpers";

export const PROMOTION_KINDS = ["percent", "amount", "free_shipping", "buy_x_get_y"] as const;
export const PROMOTION_STATUSES = ["draft", "active", "archived"] as const;

/** Discount codes and campaigns. Discount lines on sales documents carry the promotion id. */
export const promotions = pgTable(
  "promotions",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind", { enum: PROMOTION_KINDS }).notNull(),
    status: text("status", { enum: PROMOTION_STATUSES }).notNull().default("draft"),
    /** Percent kind: 10.0000 means ten percent. */
    percentValue: numeric("percent_value", { precision: 9, scale: 4 }),
    /** Amount kind: fixed discount in minor units of currency. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    currency: char("currency", { length: 3 }),
    /** buy_x_get_y kind: pay for buyQuantity units, get getQuantity cheapest units free. */
    buyQuantity: integer("buy_quantity"),
    getQuantity: integer("get_quantity"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** Channel scope. No foreign key: the sales channel registry lands
     *  separately and adds the reference; matching compares this id. */
    channelScopeId: uuid("channel_scope_id"),
    usageLimit: integer("usage_limit"),
    usageCount: integer("usage_count").notNull().default(0),
    /** Contra-revenue account the discount lines post against. */
    discountAccountId: uuid("discount_account_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("promotions_org_id_id_unique").on(t.orgId, t.id),
    // One code per organization, matched case-insensitively.
    uniqueIndex("promotions_org_code_ci").on(t.orgId, sql`lower(${t.code})`),
    index("promotions_org_status").on(t.orgId, t.status),
    check("promotions_kind_valid", sql`${t.kind} in ('percent', 'amount', 'free_shipping', 'buy_x_get_y')`),
    check("promotions_status_valid", sql`${t.status} in ('draft', 'active', 'archived')`),
    foreignKey({
      columns: [t.orgId, t.discountAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
      name: "promotions_discount_account_id_fkey",
    }),
  ],
);

/** Restocking fees charged on returns, resolved by scope and return date. */
export const restockingFeePolicies = pgTable(
  "restocking_fee_policies",
  {
    id: id(),
    orgId: orgRef(),
    /** Scope: item, item category, or neither (the default policy). */
    itemCategory: text("item_category"),
    itemId: uuid("item_id"),
    kind: text("kind", { enum: ["percent", "fixed"] }).notNull(),
    /** Percent kind: fee share of the credited line value. */
    feePercent: numeric("fee_percent", { precision: 9, scale: 4 }),
    /** Fixed kind: fee in minor units, denominated per currency below. */
    feeAmountMinor: bigint("fee_amount_minor", { mode: "bigint" }),
    /** Fixed-fee currency. Null means the fee is denominated in the credited
     *  document's currency; a set currency only matches that currency. */
    currency: char("currency", { length: 3 }),
    incomeAccountId: uuid("income_account_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    waivable: boolean("waivable").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("restocking_fee_policies_org_id_id_unique").on(t.orgId, t.id),
    index("restocking_fee_policies_org_scope").on(t.orgId, t.itemId, t.itemCategory),
    check("restocking_fee_policies_kind_valid", sql`${t.kind} in ('percent', 'fixed')`),
    foreignKey({
      columns: [t.orgId, t.itemId],
      foreignColumns: [items.orgId, items.id],
      name: "restocking_fee_policies_item_id_fkey",
    }),
    foreignKey({
      columns: [t.orgId, t.incomeAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
      name: "restocking_fee_policies_income_account_id_fkey",
    }),
  ],
);

