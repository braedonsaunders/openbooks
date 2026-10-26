import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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
    uniqueIndex("segment_values_org_id_id_unique").on(t.orgId, t.id),
    index("segment_values_org_segment").on(t.orgId, t.segmentId, t.name),
    index("segment_values_parent").on(t.parentId),
  ],
);

/** Tenant-owned definitions for custom and built-in transaction segments. */
export const segmentDefinitions = pgTable(
  "segment_definitions",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    pluralName: text("plural_name").notNull(),
    sourceKind: text("source_kind").notNull().default("custom"),
    storageColumn: text("storage_column"),
    isHierarchical: boolean("is_hierarchical").notNull().default(false),
    showOnHeader: boolean("show_on_header").notNull().default(true),
    showOnLines: boolean("show_on_lines").notNull().default(true),
    showInReports: boolean("show_in_reports").notNull().default(true),
    allowAccountRequirement: boolean("allow_account_requirement").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    isBalancing: boolean("is_balancing").notNull().default(false),
    defaultValueId: uuid("default_value_id"),
    featureKey: text("feature_key"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("segment_definitions_org_key").on(t.orgId, t.key),
    uniqueIndex("segment_definitions_org_id_id_unique").on(t.orgId, t.id),
    check("segment_definition_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_]{0,62}$'`),
    check(
      "segment_definition_source",
      sql`(${t.sourceKind} = 'custom' and ${t.storageColumn} is null) or (${t.sourceKind} = 'builtin' and ${t.storageColumn} in ('subsidiary_id', 'department_id', 'project_id', 'location_id', 'class_id'))`,
    ),
    foreignKey({
      name: "segment_definitions_default_value_fkey",
      columns: [t.orgId, t.defaultValueId],
      foreignColumns: [segmentValues.orgId, segmentValues.id],
    }),
    index("segment_definitions_org_order").on(t.orgId, t.sortOrder, t.name),
  ],
);

/**
 * Segment value dependencies ("filtered by"): the dependent value of
 * `segment_id` is allowed only together with the `controlling_segment_id`
 * values its active rows list, one allowed value per row. Either side may be
 * a custom segment or a built-in dimension; the storage guard keeps every
 * value inside its own segment. Optional effective dates bound when a row
 * applies, and one pairing cannot overlap itself in time. A value with no
 * effective rows is unrestricted. Enforced where documents are saved and
 * journals are posted.
 */
export const segmentValueDependencies = pgTable(
  "segment_value_dependencies",
  {
    id: id(),
    orgId: orgRef(),
    segmentId: uuid("segment_id").notNull(),
    valueId: uuid("value_id").notNull(),
    controllingSegmentId: uuid("controlling_segment_id").notNull(),
    /** One allowed controlling value per row; a value's effective rows form its allowed set. */
    allowedValueId: uuid("allowed_value_id").notNull(),
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    description: text("description"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("segment_value_dependencies_org_id_id_unique").on(t.orgId, t.id),
    index("segment_value_dependencies_segment").on(t.orgId, t.segmentId, t.valueId),
    check(
      "segment_value_dependencies_distinct_segments",
      sql`${t.segmentId} <> ${t.controllingSegmentId}`,
    ),
    check(
      "segment_value_dependencies_window",
      sql`${t.effectiveFrom} is null or ${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    foreignKey({
      name: "segment_value_dependencies_segment_fkey",
      columns: [t.orgId, t.segmentId],
      foreignColumns: [segmentDefinitions.orgId, segmentDefinitions.id],
    }),
    foreignKey({
      name: "segment_value_dependencies_controlling_fkey",
      columns: [t.orgId, t.controllingSegmentId],
      foreignColumns: [segmentDefinitions.orgId, segmentDefinitions.id],
    }),
  ],
);
