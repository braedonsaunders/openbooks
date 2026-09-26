import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

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
    uniqueIndex("list_views_one_live_personal_default").on(t.orgId, t.ownerId, t.recordType).where(sql`${t.scope} = 'user' AND ${t.isDefault} AND ${t.isActive}`),
  ],
);
