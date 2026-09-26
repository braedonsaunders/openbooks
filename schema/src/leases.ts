import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgTable,
  text,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Inventory NRV write-downs — IAS 2.28-33 / ASC 330-10-35.
 *
 * A write-down remeasures VALUE only: on-hand quantity is untouched, remaining
 * cost layers are revalued down so the carrying amount equals net realisable
 * value, and the loss posts immediately. Rows are the evidence trail that makes
 * the reversal rules enforceable:
 *
 *  - IFRS (IAS 2.33): a later recovery reverses the write-down, capped so
 *    cumulative reversals never exceed the cumulative write-down — carrying
 *    amount can never rise above original cost through this path.
 *  - US GAAP (ASC 330-10-35-14): the written-down amount is a new cost basis;
 *    reversal is refused.
 *
 * `kind = 'reversal'` rows reference the write-down they release via
 * `reverses_writedown_id`; the write-down's `reversed_amount` accumulates.
 */
export const inventoryWritedowns = pgTable(
  "inventory_writedowns",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    kind: text("kind", { enum: ["writedown", "reversal"] }).notNull().default("writedown"),
    date: date("date").notNull(),
    /** On-hand quantity at measurement (unchanged by the remeasurement). */
    quantity: money("quantity").notNull(),
    previousValue: money("previous_value").notNull(),
    newValue: money("new_value").notNull(),
    /** Positive magnitude of the value change. */
    amount: money("amount").notNull(),
    /** Write-downs only: cumulative amount released by later reversals. */
    reversedAmount: money("reversed_amount").notNull().default("0"),
    reversesWritedownId: uuid("reverses_writedown_id"),
    /** Reporting framework in force when recorded ('us_gaap' | 'ifrs'). */
    framework: text("framework").notNull(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    index("inventory_writedowns_item").on(t.orgId, t.itemId, t.stockLocationId),
    check("inventory_writedowns_amount_positive", sql`${t.amount} > 0`),
    check(
      "inventory_writedowns_reversed_bounds",
      sql`${t.reversedAmount} >= 0 and ${t.reversedAmount} <= ${t.amount}`,
    ),
  ],
);
