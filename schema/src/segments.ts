import { boolean, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/** Values for custom segment definitions. Built-in values stay authoritative
 * in their domain tables and are resolved through `storage_column`. The
 * storage guard serializes hierarchy mutations per tenant and custom segment
 * before rechecking parentage, so concurrent reparents cannot create a cycle
 * from individually valid snapshots. */
export const segmentValues = pgTable(
  "segment_values",
  {
    id: id(),
    orgId: orgRef(),
    segmentId: uuid("segment_id").notNull(),
    parentId: uuid("parent_id"),
    code: text("code"),
    name: text("name").notNull(),
    description: text("description"),
    /** Optional legal-entity restriction, consistent with built-in dimensions. */
    subsidiaryId: uuid("subsidiary_id"),
    subsidiaryIncludeChildren: boolean("subsidiary_include_children").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("segment_values_org_segment").on(t.orgId, t.segmentId, t.name),
    index("segment_values_parent").on(t.parentId),
  ],
);
