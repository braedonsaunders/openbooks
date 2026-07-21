import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/** Reusable, tenant-owned item rate books. Equipment is the first rich
 * consumer, but labor and other T&M items use the same pricing system. */
export const itemRateBooks = pgTable(
  "item_rate_books",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    currency: currencyCode("currency").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("item_rate_books_org_code").on(t.orgId, t.code)],
);

/** Activated versions are immutable in the application; charges retain the
 * exact version used so later price changes never rewrite history. */
export const itemRateVersions = pgTable(
  "item_rate_versions",
  {
    id: id(),
    orgId: orgRef(),
    rateBookId: uuid("rate_book_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    status: text("status", { enum: ["draft", "active", "retired"] }).notNull().default("draft"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("item_rate_versions_book_from").on(t.rateBookId, t.effectiveFrom),
    index("item_rate_versions_effective").on(t.orgId, t.effectiveFrom, t.effectiveTo),
    check("item_rate_versions_valid_range", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/** Item-level behavior shared by every rate book. A tier's base_quantity is
 * expressed in this base unit (for example day=1, week=4, month=12). */
export const itemRateProfiles = pgTable(
  "item_rate_profiles",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    baseUnit: text("base_unit").notNull(),
    pricingPolicy: text("pricing_policy", {
      enum: ["explicit", "capped_ladder", "lowest_cost"],
    }).notNull().default("capped_ladder"),
    invoicePresentation: text("invoice_presentation", {
      enum: ["summary", "rate_components"],
    }).notNull().default("rate_components"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("item_rate_profiles_item").on(t.orgId, t.itemId)],
);

/** N addable rate units per item/version. Cost and bill prices are independent:
 * zero internal cost with a positive customer price is valid. */
export const itemRateLines = pgTable(
  "item_rate_lines",
  {
    id: id(),
    orgId: orgRef(),
    versionId: uuid("version_id").notNull(),
    itemId: uuid("item_id").notNull(),
    unitCode: text("unit_code").notNull(),
    unitName: text("unit_name").notNull(),
    baseQuantity: money("base_quantity").notNull(),
    costRate: money("cost_rate"),
    billRate: money("bill_rate"),
    /** Explicit bill rates by time-type id (reg/OT/DT card): overrides
     * billRate × timeType.billMultiplier for that tier. */
    timeTypeBillRates: jsonb("time_type_bill_rates").$type<Record<string, string>>().notNull().default({}),
    sortOrder: integer("sort_order").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("item_rate_lines_version_item_unit").on(t.versionId, t.itemId, t.unitCode),
    index("item_rate_lines_item").on(t.orgId, t.itemId),
    check("item_rate_lines_positive_quantity", sql`${t.baseQuantity} > 0`),
    check("item_rate_lines_nonnegative_cost", sql`${t.costRate} is null or ${t.costRate} >= 0`),
    check("item_rate_lines_nonnegative_bill", sql`${t.billRate} is null or ${t.billRate} >= 0`),
  ],
);

/** Customer/project rate-book selection. Both null means organization scope. */
export const itemRateBookAssignments = pgTable(
  "item_rate_book_assignments",
  {
    id: id(),
    orgId: orgRef(),
    rateBookId: uuid("rate_book_id").notNull(),
    customerId: uuid("customer_id"),
    projectId: uuid("project_id"),
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("item_rate_assignments_customer").on(t.orgId, t.customerId),
    index("item_rate_assignments_project").on(t.orgId, t.projectId),
    check("item_rate_assignment_one_scope", sql`not (${t.customerId} is not null and ${t.projectId} is not null)`),
    check("item_rate_assignment_valid_range", sql`${t.effectiveTo} is null or ${t.effectiveFrom} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/** Auditable decomposition of a snapshotted project-charge line. */
export const chargeRateComponents = pgTable(
  "charge_rate_components",
  {
    id: id(),
    orgId: orgRef(),
    documentLineId: uuid("document_line_id").notNull(),
    role: text("role", { enum: ["cost", "bill"] }).notNull(),
    rateLineId: uuid("rate_line_id"),
    unitCode: text("unit_code").notNull(),
    unitName: text("unit_name").notNull(),
    quantity: money("quantity").notNull(),
    rate: money("rate").notNull(),
    amount: money("amount").notNull(),
    sequence: integer("sequence").notNull(),
    ...auditColumns,
  },
  (t) => [
    index("charge_rate_components_line").on(t.documentLineId, t.role, t.sequence),
    check("charge_rate_components_positive_quantity", sql`${t.quantity} > 0`),
    check("charge_rate_components_nonnegative_rate", sql`${t.rate} >= 0`),
    check("charge_rate_components_nonnegative_amount", sql`${t.amount} >= 0`),
  ],
);
