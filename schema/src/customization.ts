import { boolean, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Per-tenant + per-user transaction-form and record-list customization — the
 * NetSuite "Custom Form" + "Preferred Form" model and the saved-list-view
 * model. The config blobs (FormLayoutConfig / ListViewConfig) are validated by
 * @openbooks/customization; this module only stores them.
 *
 * Form layouts (custom transaction forms):
 *   form_layouts (org-scoped)          — 1..N named forms per record type
 *   user_form_preferences (per-user)    — which form a user prefers per type
 *
 * List views (saved searches):
 *   list_views (org-scoped, scope org|user) — named, shareable or personal
 *   user_list_preferences (per-user)       — which view a user defaults to
 *
 * Custom field VALUES remain in each table's `custom` jsonb (see web/lib/
 * custom-fields + custom_field_defs). Layouts reference custom fields by the
 * stable `cf_<def.key>`, discovered at render time — so a layout never breaks
 * when a custom field is deactivated (the renderer skips unknown cf_ keys).
 */

export const FORM_LAYOUT_SCOPE = ["org"] as const;

/** Org-level custom transaction/entity form. */
export const formLayouts = pgTable(
  "form_layouts",
  {
    id: id(),
    orgId: orgRef(),
    /** Record-type key from @openbooks/customization (e.g. 'vendor_bill'). */
    recordType: text("record_type").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** The org-wide default form for this record type (≤1 per org+type). */
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Role keys allowed to use this form (empty/null ⇒ everyone). Admins
     * always see every form. The default form is used for anyone not granted
     * any available form, so a user is never left without a form.
     */
    allowedRoles: jsonb("allowed_roles").$type<string[]>(),
    /** FormLayoutConfig (validated on write by the API). */
    layout: jsonb("layout").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("form_layouts_org_type_name").on(t.orgId, t.recordType, t.name),
    index("form_layouts_org_type").on(t.orgId, t.recordType, t.isDefault),
  ],
);

/** A user's preferred form per record type (null layoutId ⇒ org default). */
export const userFormPreferences = pgTable(
  "user_form_preferences",
  {
    id: id(),
    orgId: orgRef(),
    userId: uuid("user_id").notNull(),
    recordType: text("record_type").notNull(),
    layoutId: uuid("layout_id"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("user_form_prefs_user_type").on(t.orgId, t.userId, t.recordType)],
);

export const LIST_VIEW_SCOPE = ["org", "user"] as const;

/**
 * A saved list view. `scope='org'` rows are shared org-wide (ownerId null);
 * `scope='user'` rows are personal (ownerId = the user). ListViewConfig in
 * `config`. One org default + one personal default per (user, recordType).
 */
export const listViews = pgTable(
  "list_views",
  {
    id: id(),
    orgId: orgRef(),
    recordType: text("record_type").notNull(),
    name: text("name").notNull(),
    scope: text("scope", { enum: LIST_VIEW_SCOPE }).notNull(),
    /** users.id for 'user' scope; null for 'org' scope. */
    ownerId: uuid("owner_id"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    /** ListViewConfig (validated on write by the API). */
    config: jsonb("config").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("list_views_org_scope_type_name").on(t.orgId, t.scope, t.recordType, t.name),
    index("list_views_org_type").on(t.orgId, t.recordType, t.scope),
  ],
);

/** A user's default list view per record type (null viewId ⇒ org default). */
export const userListPreferences = pgTable(
  "user_list_preferences",
  {
    id: id(),
    orgId: orgRef(),
    userId: uuid("user_id").notNull(),
    recordType: text("record_type").notNull(),
    viewId: uuid("view_id"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("user_list_prefs_user_type").on(t.orgId, t.userId, t.recordType)],
);

/*
FOREIGN KEYS (added by the integrator's migration pass):
  form_layouts.org_id          → orgs.id
  form_layouts.created_by/updated_by → users.id
  user_form_preferences.org_id → orgs.id
  user_form_preferences.user_id → users.id ON DELETE CASCADE
  user_form_preferences.layout_id → form_layouts.id ON DELETE SET NULL
  list_views.org_id            → orgs.id
  list_views.owner_id          → users.id ON DELETE CASCADE
  list_views.created_by/updated_by → users.id
  user_list_preferences.org_id → orgs.id
  user_list_preferences.user_id → users.id ON DELETE CASCADE
  user_list_preferences.view_id → list_views.id ON DELETE SET NULL
*/
