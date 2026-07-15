import { boolean, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Per-user and per-role dashboard widget layouts. The home page resolves a
 * layout via: the user's saved row → their role's saved row → shipped tier
 * defaults (see _role-defaults.ts). This is separate from insight_dashboards
 * (the BI card builder) — the home dashboard is a bespoke widget grid.
 */

export type DashboardQuickAction = {
  id: string;
  label: string;
  href: string;
  iconKey: string;
  tone: string;
};

export type DashboardLayoutData = {
  widgets: Array<{ id: string; x: number; y: number; w: number; h: number }>;
  quickActions?: DashboardQuickAction[];
};

/** One row per (org, user) — the user's personalised widget layout. */
export const userDashboardLayouts = pgTable(
  "user_dashboard_layouts",
  {
    id: id(),
    orgId: orgRef(),
    userId: uuid("user_id").notNull(),
    layout: jsonb("layout").$type<DashboardLayoutData>().notNull().default({ widgets: [] }),
    /** Tracks which default the user customised from — a role change lets the
     *  new default win again (sourceRole mismatch → fall back to default). */
    sourceRole: text("source_role").notNull(),
    isCustomised: boolean("is_customised").notNull().default(false),
    ...auditColumns,
  },
  (t) => [uniqueIndex("user_dashboard_layouts_unique").on(t.orgId, t.userId)],
);

/** One row per (org, role key) — an admin-set default layout for a role. */
export const roleDashboardLayouts = pgTable(
  "role_dashboard_layouts",
  {
    id: id(),
    orgId: orgRef(),
    roleKey: text("role_key").notNull(),
    layout: jsonb("layout").$type<DashboardLayoutData>().notNull().default({ widgets: [] }),
    ...auditColumns,
  },
  (t) => [uniqueIndex("role_dashboard_layouts_unique").on(t.orgId, t.roleKey)],
);

/*
 * Foreign keys (add to schema/migrations/referential-integrity.sql):
 *
 *   alter table user_dashboard_layouts
 *     add foreign key (org_id) references orgs(id),
 *     add foreign key (user_id) references users(id) on delete cascade;
 *   alter table role_dashboard_layouts
 *     add foreign key (org_id) references orgs(id);
 */
