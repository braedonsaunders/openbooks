import { id } from "./helpers";

/**
 * Per-user and per-role dashboard widget layouts. The home page resolves a
 * layout via: the user's saved row → their role's saved row → shipped tier
 * defaults below. This is separate from insight_dashboards
 * (the BI card builder) — the home dashboard is a bespoke widget grid.
 */

export type DashboardQuickAction = {
  id: string;
  /** User-authored label for custom actions and legacy curated rows. */
  label?: string;
  /** Product-owned label key; resolve through dashboard.quickActions.labels. */
  labelKey?: string;
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
      { id: "kpi-revenue-mtd", x: 0, y: 2, w: 3, h: 2 },
      { id: "kpi-net-income-mtd", x: 3, y: 2, w: 3, h: 2 },
      { id: "kpi-gross-margin-mtd", x: 6, y: 2, w: 3, h: 2 },
      { id: "kpi-cash-runway", x: 9, y: 2, w: 3, h: 2 },
      { id: "personal-actions", x: 0, y: 4, w: 12, h: 3 },
      { id: "list-pending-approvals", x: 0, y: 7, w: 6, h: 5 },
      { id: "list-top-customers", x: 6, y: 7, w: 6, h: 5 },
      { id: "list-top-vendors", x: 0, y: 12, w: 6, h: 5 },
      { id: "personal-in-progress", x: 6, y: 12, w: 6, h: 5 },
      { id: "list-recent-entries", x: 0, y: 17, w: 12, h: 5 },
    ],
  },
  controller: {
    widgets: [
      { id: "kpi-cash-balance", x: 0, y: 0, w: 3, h: 2 },
      { id: "kpi-overdue-receivables", x: 3, y: 0, w: 3, h: 2 },
      { id: "kpi-overdue-payables", x: 6, y: 0, w: 3, h: 2 },
      { id: "kpi-pending-approvals", x: 9, y: 0, w: 3, h: 2 },
      { id: "kpi-expected-receipts-30d", x: 0, y: 2, w: 3, h: 2 },
      { id: "kpi-bills-due-30d", x: 3, y: 2, w: 3, h: 2 },
      { id: "kpi-revenue-mtd", x: 6, y: 2, w: 3, h: 2 },
      { id: "kpi-cash-runway", x: 9, y: 2, w: 3, h: 2 },
      { id: "personal-actions", x: 0, y: 4, w: 12, h: 3 },
      { id: "list-pending-approvals", x: 0, y: 7, w: 6, h: 5 },
      { id: "list-top-customers", x: 6, y: 7, w: 6, h: 5 },
      { id: "list-recent-entries", x: 0, y: 12, w: 6, h: 5 },
      { id: "list-top-vendors", x: 6, y: 12, w: 6, h: 5 },
      { id: "personal-in-progress", x: 0, y: 17, w: 12, h: 5 },
    ],
  },
  accountant: {
    widgets: [
      { id: "kpi-cash-balance", x: 0, y: 0, w: 3, h: 2 },
      { id: "kpi-open-receivables", x: 3, y: 0, w: 3, h: 2 },
      { id: "kpi-open-payables", x: 6, y: 0, w: 3, h: 2 },
      { id: "kpi-entries-today", x: 9, y: 0, w: 3, h: 2 },
      { id: "kpi-expected-receipts-30d", x: 0, y: 2, w: 3, h: 2 },
      { id: "kpi-bills-due-30d", x: 3, y: 2, w: 3, h: 2 },
      { id: "kpi-revenue-mtd", x: 6, y: 2, w: 3, h: 2 },
      { id: "kpi-net-income-mtd", x: 9, y: 2, w: 3, h: 2 },
      { id: "personal-actions", x: 0, y: 4, w: 12, h: 3 },
      { id: "personal-in-progress", x: 0, y: 7, w: 6, h: 5 },
      { id: "list-top-customers", x: 6, y: 7, w: 6, h: 5 },
      { id: "list-recent-entries", x: 0, y: 12, w: 12, h: 5 },
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
      { id: "kpi-revenue-mtd", x: 0, y: 4, w: 6, h: 2 },
      { id: "kpi-net-income-mtd", x: 6, y: 4, w: 6, h: 2 },
      { id: "list-recent-entries", x: 0, y: 6, w: 12, h: 5 },
    ],
  },
};

export function defaultDashboardLayoutForRole(roleKey: string): DashboardLayoutData {
  return DEFAULT_DASHBOARD_LAYOUTS[roleKey as DashboardRole] ?? DEFAULT_DASHBOARD_LAYOUTS.viewer;
}

/*
 * Foreign keys (add to schema/migrations/referential-integrity.sql):
 *
 *   alter table user_dashboard_layouts
 *     add foreign key (org_id) references orgs(id),
 *     add foreign key (user_id) references users(id) on delete cascade;
 *   alter table role_dashboard_layouts
 *     add foreign key (org_id) references orgs(id);
 */

/**
 * Per-user page layout preferences — reorder + show/hide of a page's panels
 * (cockpits, module homes). One row per (org, user, page); `page` is a stable
 * key like "banking-cash". Deliberately generic so every cockpit shares one
 * store instead of growing bespoke tables.
 */
export type PageLayoutPrefs = {
  /** Panel keys in display order; panels absent from the list append in
   *  default order (new panels ship visible without migrations). */
  order?: string[];
  /** Panel keys the user hid. */
  hidden?: string[];
};
