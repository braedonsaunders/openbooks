import { boolean, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Per-user and per-role dashboard widget layouts. The home page resolves a
 * layout via: the user's saved row → their role's saved row → shipped tier
 * defaults below. This is separate from insight_dashboards
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

export const DASHBOARD_ROLE_KEYS = [
  "admin",
  "controller",
  "accountant",
  "approver",
  "viewer",
] as const;

export type DashboardRole = (typeof DASHBOARD_ROLE_KEYS)[number];

/**
 * Product-owned home layouts. These are shared by the web fallback and the
 * database seeder so a tenant-persisted default can never drift from what a
 * newly provisioned tenant sees before seeding.
 */
export const DEFAULT_DASHBOARD_LAYOUTS: Record<DashboardRole, DashboardLayoutData> = {
  admin: {
    widgets: [
      { id: "kpi-cash-balance", x: 0, y: 0, w: 3, h: 2 },
      { id: "kpi-open-receivables", x: 3, y: 0, w: 3, h: 2 },
      { id: "kpi-open-payables", x: 6, y: 0, w: 3, h: 2 },
      { id: "kpi-pending-approvals", x: 9, y: 0, w: 3, h: 2 },
      { id: "personal-actions", x: 0, y: 2, w: 12, h: 3 },
      { id: "list-pending-approvals", x: 0, y: 5, w: 6, h: 5 },
      { id: "personal-in-progress", x: 6, y: 5, w: 6, h: 5 },
      { id: "list-recent-entries", x: 0, y: 10, w: 12, h: 5 },
    ],
  },
  controller: {
    widgets: [
      { id: "kpi-cash-balance", x: 0, y: 0, w: 3, h: 2 },
      { id: "kpi-overdue-receivables", x: 3, y: 0, w: 3, h: 2 },
      { id: "kpi-overdue-payables", x: 6, y: 0, w: 3, h: 2 },
      { id: "kpi-pending-approvals", x: 9, y: 0, w: 3, h: 2 },
      { id: "personal-actions", x: 0, y: 2, w: 12, h: 3 },
      { id: "list-pending-approvals", x: 0, y: 5, w: 6, h: 5 },
      { id: "list-recent-entries", x: 6, y: 5, w: 6, h: 5 },
      { id: "personal-in-progress", x: 0, y: 10, w: 12, h: 5 },
    ],
  },
  accountant: {
    widgets: [
      { id: "kpi-cash-balance", x: 0, y: 0, w: 3, h: 2 },
      { id: "kpi-open-receivables", x: 3, y: 0, w: 3, h: 2 },
      { id: "kpi-open-payables", x: 6, y: 0, w: 3, h: 2 },
      { id: "kpi-entries-today", x: 9, y: 0, w: 3, h: 2 },
      { id: "personal-actions", x: 0, y: 2, w: 12, h: 3 },
      { id: "personal-in-progress", x: 0, y: 5, w: 6, h: 5 },
      { id: "list-recent-entries", x: 6, y: 5, w: 6, h: 5 },
    ],
  },
  approver: {
    widgets: [
      { id: "kpi-pending-approvals", x: 0, y: 0, w: 4, h: 2 },
      { id: "kpi-overdue-receivables", x: 4, y: 0, w: 4, h: 2 },
      { id: "kpi-overdue-payables", x: 8, y: 0, w: 4, h: 2 },
      { id: "personal-inbox", x: 0, y: 2, w: 6, h: 5 },
      { id: "list-pending-approvals", x: 6, y: 2, w: 6, h: 5 },
      { id: "list-recent-entries", x: 0, y: 7, w: 12, h: 5 },
    ],
  },
  viewer: {
    widgets: [
      { id: "kpi-cash-balance", x: 0, y: 0, w: 4, h: 2 },
      { id: "kpi-open-receivables", x: 4, y: 0, w: 4, h: 2 },
      { id: "kpi-open-payables", x: 8, y: 0, w: 4, h: 2 },
      { id: "kpi-overdue-receivables", x: 0, y: 2, w: 6, h: 2 },
      { id: "kpi-overdue-payables", x: 6, y: 2, w: 6, h: 2 },
      { id: "list-recent-entries", x: 0, y: 4, w: 12, h: 5 },
    ],
  },
};

export function defaultDashboardLayoutForRole(roleKey: string): DashboardLayoutData {
  return DEFAULT_DASHBOARD_LAYOUTS[roleKey as DashboardRole] ?? DEFAULT_DASHBOARD_LAYOUTS.viewer;
}

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
