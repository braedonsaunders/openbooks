import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Product families with ordered options (Size × Color). Each variant stays
 * an ordinary `items` row (items.family_id + items.option_values), so stock,
 * costing, pricing, tax, documents, barcodes and reports work unchanged.
 * A later storefront connector maps storefront product → family and
 * storefront variant → variant item through `external_links`.
 */
export const itemFamilies = pgTable(
  "item_families",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    /** Default item kind for generated variants: stocked/sellable kinds only. */
    kind: text("kind", {
      enum: ["inventory", "non_inventory", "service", "kit", "assembly"],
    }).notNull(),
    defaultUnit: text("default_unit"),
    defaultRate: money("default_rate"),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("item_families_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("item_families_org_code").on(t.orgId, t.code),
  ],
);

/** Ordered options per family, each with ordered values. Position is 1-based. */
export const itemFamilyOptions = pgTable(
  "item_family_options",
  {
    id: id(),
    orgId: orgRef(),
    familyId: uuid("family_id").notNull(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    values: text("values").array().notNull().default(sql`'{}'`),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("item_family_options_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.familyId],
      foreignColumns: [itemFamilies.orgId, itemFamilies.id],
      name: "item_family_options_family_fkey",
    }),
    uniqueIndex("item_family_options_org_family_name").on(t.orgId, t.familyId, t.name),
    uniqueIndex("item_family_options_org_family_position").on(t.orgId, t.familyId, t.position),
    index("item_family_options_org_family").on(t.orgId, t.familyId, t.position),
    check("item_family_options_position_positive", sql`${t.position} > 0`),
  ],
);

/** Option values chosen for one variant item: { "Size": "M", "Color": "Red" }. */
export interface ItemOptionValues {
  [optionName: string]: string;
}

export function optionValuesJson(values: ItemOptionValues): string {
  return JSON.stringify(values);
}
