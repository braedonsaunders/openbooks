import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Custom record types — the app-builder's "define your own master data"
 * subsystem (the NetSuite custom-record equivalent). Lifecycle:
 *
 *   custom_record_types (org-scoped definition: key slug + FormSection[] jsonb)
 *     └─ custom_records (instances: per-type numbered rows with a data jsonb
 *        payload validated against the type's sections)
 *
 * The `fields` jsonb is a FormSection[] — an ordered list of sections, each a
 * non-repeating HEADER group or a REPEATING line list (a sublist/table). It
 * uses the SAME runtime-validated model as the app-builder forms
 * (@openbooks/forms-core: zod validators, conditional-visibility rules, typed
 * formula trees incl. line-item rollups, gl_account/party entity pickers).
 * Record types deliberately reuse it rather than inventing a second field
 * language; the column keeps its historical `fields` name and still accepts a
 * legacy flat FormField[] (normalized into one header section on read — see
 * web/lib/record-schema.ts). A record's `data` jsonb is one merged map: header
 * values keyed by field id, plus each repeating section's rows keyed by section
 * id (data[sectionId] = [{ rowFieldId: value }, …]).
 *
 * Unlike form templates, record types are NOT versioned: records are living
 * master data (equipment, sites, contracts, …), not point-in-time
 * submissions, so edits to a published type apply to every record's editor
 * immediately. Values already stored under a removed field simply stop
 * rendering; the write path re-validates against the current fields.
 *
 * Record numbering reuses number_sequences with
 * `document_kind = 'custrec:' + typeKey` (e.g. EQU-00001).
 */

export const CUSTOM_RECORD_TYPE_STATUSES = ["draft", "published", "archived"] as const;

export const customRecordTypes = pgTable(
  "custom_record_types",
  {
    id: id(),
    orgId: orgRef(),
    /**
     * Stable slug, unique per org — the module URL (/records/<key>) and the
     * number-sequence kind key off it. Lowercase [a-z0-9-], editable only
     * while the type is a draft (records + sequences pin it after publish).
     */
    key: text("key").notNull(),
    name: text("name").notNull(),
    pluralName: text("plural_name").notNull(),
    /** Sidebar icon key (web/components/sidebar-nav.tsx ICONS registry). */
    iconKey: text("icon_key").notNull().default("grid"),
    description: text("description"),
    /** FormSection[] from @openbooks/forms-core (see module docblock). */
    fields: jsonb("fields").$type<Array<Record<string, unknown>>>().notNull().default([]),
    status: text("status", { enum: CUSTOM_RECORD_TYPE_STATUSES }).notNull().default("draft"),
    /** Published types with this flag get a dynamic sidebar entry ("Records" group). */
    showInNav: boolean("show_in_nav").notNull().default(false),
    /**
     * Role gating for the generated module. Empty/null ⇒ every records.read
     * holder; non-empty ⇒ only these app_roles keys (plus admins). Type
     * AUTHORING is always records.manage_types regardless of this list.
     */
    allowedRoles: jsonb("allowed_roles").$type<string[]>(),
    /** Ordering of dynamic nav entries and of the type list. */
    sortOrder: integer("sort_order").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("custom_record_types_org_key").on(t.orgId, t.key),
    index("custom_record_types_org_status").on(t.orgId, t.status),
  ],
);

export const CUSTOM_RECORD_STATUSES = ["draft", "active", "inactive"] as const;

export const customRecords = pgTable(
  "custom_records",
  {
    id: id(),
    orgId: orgRef(),
    typeId: uuid("type_id").notNull(),
    /** Denormalized type slug for cheap per-module listing (mirrors form_responses.template_key). */
    typeKey: text("type_key").notNull(),
    /** Per-type sequence via number_sequences ('custrec:'+typeKey), e.g. EQU-00001. */
    recordNumber: text("record_number").notNull(),
    /**
     * Field values keyed by field id. Formula field values are recomputed
     * server-side on every save and persisted here so lists/reports read
     * them without re-evaluating trees.
     */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Space-joined lowercase haystack recomputed on every save from the
     * type's current fields: raw text/number values, choice labels, and the
     * display names behind gl_account/party refs — what the module list's
     * search ILIKEs against.
     */
    searchText: text("search_text").notNull().default(""),
    /**
     * Records are master data, not postable documents: they stay editable
     * while active. draft → active is the explicit "this row is real" step
     * (enforces required fields); inactive rows are read-only and hidden
     * from pickers until reactivated.
     */
    status: text("status", { enum: CUSTOM_RECORD_STATUSES }).notNull().default("draft"),
    ...auditColumns, // includes created_by / updated_by
  },
  (t) => [
    uniqueIndex("custom_records_type_number").on(t.typeId, t.recordNumber),
    index("custom_records_org_type_status").on(t.orgId, t.typeKey, t.status),
    index("custom_records_org_type_created").on(t.orgId, t.typeKey, t.createdAt),
  ],
);

/*
FOREIGN KEYS (added by the integrator's migration pass — referential-integrity.sql):
  custom_record_types.org_id                 → orgs.id
  custom_record_types.created_by/updated_by  → users.id
  custom_records.org_id                      → orgs.id
  custom_records.type_id                     → custom_record_types.id ON DELETE RESTRICT
  custom_records.created_by/updated_by       → users.id
*/
