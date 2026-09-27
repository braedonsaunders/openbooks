import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgs } from "./core";
import { items } from "./documents";
import { parties } from "./parties";
import { subscriptions } from "./subscriptions";
import { id, orgRef } from "./helpers";

export const USAGE_AGGREGATIONS = ["sum", "count", "max", "last", "unique_count"] as const;
export const USAGE_RECORD_SOURCES = ["api", "import", "connector_stripe", "manual"] as const;

export const usageMeters = pgTable(
  "usage_meters",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull(),
    aggregation: text("aggregation", { enum: USAGE_AGGREGATIONS }).notNull(),
    itemId: uuid("item_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("usage_meters_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("usage_meters_org_key_unique").on(t.orgId, t.key),
    index("usage_meters_org_active").on(t.orgId, t.isActive),
    check("usage_meters_key_nonblank", sql`length(btrim(${t.key})) > 0`),
    check("usage_meters_name_nonblank", sql`length(btrim(${t.name})) > 0`),
    check("usage_meters_unit_nonblank", sql`length(btrim(${t.unit})) > 0`),
    check(
      "usage_meters_aggregation_valid",
      sql`${t.aggregation} in ('sum', 'count', 'max', 'last', 'unique_count')`,
    ),
    foreignKey({ name: "usage_meters_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "usage_meters_item_org_fk",
      columns: [t.orgId, t.itemId],
      foreignColumns: [items.orgId, items.id],
    }),
  ],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    orgId: orgRef(),
    meterId: uuid("meter_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    subscriptionId: uuid("subscription_id"),
    occurredOn: date("occurred_on").notNull(),
    quantity: numeric("quantity", { precision: 28, scale: 8 }).notNull(),
    distinctKey: text("distinct_key"),
    source: text("source", { enum: USAGE_RECORD_SOURCES }).notNull(),
    sourceRef: text("source_ref"),
    idempotencyKey: text("idempotency_key").notNull(),
    reversesId: uuid("reverses_id"),
    reversalReason: text("reversal_reason"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_records_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("usage_records_org_meter_idempotency_unique").on(t.orgId, t.meterId, t.idempotencyKey),
    uniqueIndex("usage_records_one_reversal").on(t.orgId, t.reversesId).where(sql`${t.reversesId} is not null`),
    index("usage_records_window").on(t.orgId, t.meterId, t.customerId, t.occurredOn, t.id),
    check(
      "usage_records_source_valid",
      sql`${t.source} in ('api', 'import', 'connector_stripe', 'manual')`,
    ),
    check(
      "usage_records_quantity_valid",
      sql`(${t.reversesId} is null and ${t.quantity} > 0) or (${t.reversesId} is not null and ${t.quantity} < 0)`,
    ),
    check(
      "usage_records_reversal_reason",
      sql`(${t.reversesId} is null and ${t.reversalReason} is null) or (${t.reversesId} is not null and ${t.reversalReason} is not null and length(btrim(${t.reversalReason})) > 0)`,
    ),
    foreignKey({ name: "usage_records_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "usage_records_meter_org_fk",
      columns: [t.orgId, t.meterId],
      foreignColumns: [usageMeters.orgId, usageMeters.id],
    }),
    foreignKey({
      name: "usage_records_customer_org_fk",
      columns: [t.orgId, t.customerId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "usage_records_subscription_org_fk",
      columns: [t.orgId, t.subscriptionId],
      foreignColumns: [subscriptions.orgId, subscriptions.id],
    }),
    foreignKey({
      name: "usage_records_reverses_org_fk",
      columns: [t.orgId, t.reversesId],
      foreignColumns: [t.orgId, t.id],
    }),
  ],
);
