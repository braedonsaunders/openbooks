import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Point-of-sale registers (migration 0734). A register binds a till to a
 * legal entity, a dimension location, a warehouse, a walk-in customer, a
 * price level and the clearing account each accepted tender settles into.
 * A tender kind is accepted exactly when its account is configured.
 */
export const posRegisters = pgTable(
  "pos_registers",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    locationId: uuid("location_id"),
    stockLocationId: uuid("stock_location_id"),
    defaultCustomerId: uuid("default_customer_id"),
    priceLevelId: uuid("price_level_id"),
    cashAccountId: uuid("cash_account_id").notNull(),
    cardAccountId: uuid("card_account_id"),
    otherAccountId: uuid("other_account_id"),
    acceptsStoredValue: boolean("accepts_stored_value").notNull().default(false),
    receiptHeader: text("receipt_header"),
    receiptFooter: text("receipt_footer"),
    denominations: text("denominations")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pos_registers_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("pos_registers_code_unique").on(t.orgId, t.code),
  ],
);

/** Pay-in and pay-out reasons: the account a drawer cash movement posts against. */
export const posCashReasons = pgTable(
  "pos_cash_reasons",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    direction: text("direction", { enum: ["pay_in", "pay_out"] }).notNull(),
    accountId: uuid("account_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pos_cash_reasons_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("pos_cash_reasons_code_unique").on(t.orgId, t.code),
  ],
);

/** Favourite items on a register's quick-key grid; no register means every register. */
export const posQuickKeys = pgTable(
  "pos_quick_keys",
  {
    id: id(),
    orgId: orgRef(),
    registerId: uuid("register_id"),
    itemId: uuid("item_id").notNull(),
    position: integer("position").notNull().default(0),
    label: text("label"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pos_quick_keys_org_id_id_unique").on(t.orgId, t.id),
    index("pos_quick_keys_register").on(t.orgId, t.registerId, t.position),
  ],
);

/** One drawer shift on one register. At most one open session per register. */
export const posSessions = pgTable(
  "pos_sessions",
  {
    id: id(),
    orgId: orgRef(),
    registerId: uuid("register_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    sessionNumber: integer("session_number").notNull(),
    status: text("status", { enum: ["open", "closed"] })
      .notNull()
      .default("open"),
    businessDate: date("business_date").notNull(),
    currency: text("currency").notNull(),
    openingFloatMinor: bigint("opening_float_minor", { mode: "bigint" }).notNull(),
    openingCount: jsonb("opening_count").notNull().default([]),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openedBy: uuid("opened_by").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    expectedCashMinor: bigint("expected_cash_minor", { mode: "bigint" }),
    countedCashMinor: bigint("counted_cash_minor", { mode: "bigint" }),
    overShortMinor: bigint("over_short_minor", { mode: "bigint" }),
    closingCount: jsonb("closing_count"),
    overShortEntryId: uuid("over_short_entry_id"),
    closeNote: text("close_note"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pos_sessions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("pos_sessions_number_unique").on(t.orgId, t.registerId, t.sessionNumber),
    uniqueIndex("pos_sessions_one_open_per_register")
      .on(t.orgId, t.registerId)
      .where(sql`status = 'open'`),
    index("pos_sessions_register_date").on(t.orgId, t.registerId, t.businessDate),
  ],
);

/** Append-only drawer pay-ins and pay-outs, each with its posted journal entry. */
export const posCashMovements = pgTable(
  "pos_cash_movements",
  {
    id: id(),
    orgId: orgRef(),
    sessionId: uuid("session_id").notNull(),
    kind: text("kind", { enum: ["pay_in", "pay_out"] }).notNull(),
    reasonId: uuid("reason_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    note: text("note"),
    journalEntryId: uuid("journal_entry_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("pos_cash_movements_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("pos_cash_movements_idempotency_unique").on(t.orgId, t.idempotencyKey),
    index("pos_cash_movements_session").on(t.orgId, t.sessionId),
  ],
);

/**
 * A posted cash_sale or cash_refund attributed to the session it was rung
 * in, with the cash tendered, change given and the pricing evidence
 * (list prices, discounts and overrides) per document line number.
 */
export const posTransactions = pgTable(
  "pos_transactions",
  {
    id: id(),
    orgId: orgRef(),
    sessionId: uuid("session_id").notNull(),
    registerId: uuid("register_id").notNull(),
    kind: text("kind", { enum: ["sale", "refund"] }).notNull(),
    documentId: uuid("document_id").notNull(),
    refundOfDocumentId: uuid("refund_of_document_id"),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
    cashAppliedMinor: bigint("cash_applied_minor", { mode: "bigint" }).notNull().default(0n),
    cashTenderedMinor: bigint("cash_tendered_minor", { mode: "bigint" }).notNull().default(0n),
    changeMinor: bigint("change_minor", { mode: "bigint" }).notNull().default(0n),
    pricing: jsonb("pricing").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("pos_transactions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("pos_transactions_document_unique").on(t.orgId, t.documentId),
    index("pos_transactions_session").on(t.orgId, t.sessionId, t.createdAt),
  ],
);

/** Carts parked at a register to be resumed later. */
export const posHeldCarts = pgTable(
  "pos_held_carts",
  {
    id: id(),
    orgId: orgRef(),
    registerId: uuid("register_id").notNull(),
    label: text("label").notNull(),
    cart: jsonb("cart").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("pos_held_carts_org_id_id_unique").on(t.orgId, t.id),
    index("pos_held_carts_register").on(t.orgId, t.registerId, t.createdAt),
  ],
);
