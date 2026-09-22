import { sql } from "drizzle-orm";
import { boolean, check, date, index, numeric, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

export const priceLevels = pgTable("price_levels", {
  id: id(), orgId: orgRef(), code: text("code").notNull(), name: text("name").notNull(),
  pricingMethod: text("pricing_method", { enum: ["explicit", "markup_discount", "cost_plus"] }).notNull().default("explicit"),
  percentage: numeric("percentage", { precision: 9, scale: 4 }),
  costBasis: text("cost_basis", { enum: ["item_cost", "standard_cost", "average_cost"] }),
  isBase: boolean("is_base").notNull().default(false), isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
}, (t) => [
  uniqueIndex("price_levels_org_id_id_unique").on(t.orgId, t.id), uniqueIndex("price_levels_org_code_unique").on(t.orgId, t.code),
  index("price_levels_org_active").on(t.orgId, t.name),
  check("price_levels_formula_shape", sql`(${t.pricingMethod}='explicit' and ${t.percentage} is null and ${t.costBasis} is null) or (${t.pricingMethod}='markup_discount' and ${t.percentage} is not null and ${t.costBasis} is null) or (${t.pricingMethod}='cost_plus' and ${t.percentage} is not null and ${t.costBasis} in ('item_cost','standard_cost','average_cost'))`),
]);

export const customerPriceLevelAssignments = pgTable("customer_price_level_assignments", {
  id: id(), orgId: orgRef(), customerId: uuid("customer_id").notNull(), priceLevelId: uuid("price_level_id").notNull(),
  effectiveFrom: date("effective_from").notNull(), effectiveTo: date("effective_to"), isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
}, (t) => [uniqueIndex("customer_price_level_org_id_id_unique").on(t.orgId, t.id), index("customer_price_level_lookup").on(t.orgId, t.customerId, t.effectiveFrom)]);

export const itemPriceSchedules = pgTable("item_price_schedules", {
  id: id(), orgId: orgRef(), itemId: uuid("item_id").notNull(), priceLevelId: uuid("price_level_id"), customerId: uuid("customer_id"),
  currency: currencyCode("currency").notNull(), quantityBasis: text("quantity_basis", { enum: ["line_quantity", "overall_item_quantity"] }).notNull().default("line_quantity"),
  effectiveFrom: date("effective_from").notNull(), effectiveTo: date("effective_to"), isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
}, (t) => [
  uniqueIndex("item_price_schedules_org_id_id_unique").on(t.orgId, t.id), index("item_price_schedule_lookup").on(t.orgId, t.itemId, t.currency, t.effectiveFrom),
  check("item_price_schedule_scope", sql`(${t.customerId} is null and ${t.priceLevelId} is not null) or (${t.customerId} is not null and ${t.priceLevelId} is null)`),
]);

export const itemPriceBreaks = pgTable("item_price_breaks", {
  id: id(), orgId: orgRef(), scheduleId: uuid("schedule_id").notNull(), minimumQuantity: numeric("minimum_quantity", { precision: 19, scale: 4 }).notNull(), unitPrice: money("unit_price").notNull(), ...auditColumns,
}, (t) => [unique("item_price_break_unique").on(t.orgId, t.scheduleId, t.minimumQuantity), index("item_price_break_lookup").on(t.orgId, t.scheduleId, t.minimumQuantity), check("item_price_break_quantity_positive", sql`${t.minimumQuantity}>0`), check("item_price_break_price_nonnegative", sql`${t.unitPrice}>=0`)]);
