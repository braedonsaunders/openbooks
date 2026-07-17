import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Tenant-owned accounting segment registry.
 *
 * Built-in segments describe columns whose values have richer domain models
 * (subsidiaries, departments, projects, locations, and classes). Custom
 * segments use `segment_values` and are assigned through the `extra_dims`
 * JSON object on documents and journal lines. Consumers use `key` as the
 * stable identifier, never the user-editable label.
 */
export const segmentDefinitions = pgTable(
  "segment_definitions",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    pluralName: text("plural_name").notNull(),
    sourceKind: text("source_kind", { enum: ["builtin", "custom"] })
      .notNull()
      .default("custom"),
    /** Physical *_id field for built-ins; null means extra_dims[key]. */
    storageColumn: text("storage_column"),
    isHierarchical: boolean("is_hierarchical").notNull().default(false),
    showOnHeader: boolean("show_on_header").notNull().default(true),
    showOnLines: boolean("show_on_lines").notNull().default(true),
    showInReports: boolean("show_in_reports").notNull().default(true),
    allowAccountRequirement: boolean("allow_account_requirement").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("segment_definitions_org_key").on(t.orgId, t.key),
    index("segment_definitions_org_order").on(t.orgId, t.sortOrder, t.name),
  ],
);

/** Values for custom segment definitions. Built-in values stay authoritative
 * in their domain tables and are resolved through `storage_column`. */
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
