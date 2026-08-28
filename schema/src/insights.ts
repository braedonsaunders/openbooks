import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Insights — the enterprise card and dashboard builder. Users
 * build chart/table CARDS from a query over the ledger (the query model lives in
 * @openbooks/analytics; the plan is stored as jsonb on `query`), then arrange
 * PUBLISHED cards on DASHBOARDS.
 *
 *   insight_cards        — a saved query + viz spec (draft → published)
 *   insight_dashboards   — a named grid of card placements
 *   insight_dashboard_pins — a user's personal pins (order the home shows them)
 *
 * Everything is org-scoped. `query` / `viz_settings` / `layout` are validated at
 * the edge by @openbooks/analytics before persistence; the DB stores the vetted
 * shape. FKs live at the bottom of referential-integrity.sql.
 */

export const INSIGHT_STATUSES = ["draft", "published"] as const;

/** The chart/table shapes a card can render (mirrors analytics `VizType`). */
export const INSIGHT_VIZ_TYPES = ["table", "bar", "line", "area", "pie"] as const;

export const insightCards = pgTable(
  "insight_cards",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    description: text("description"),
    /** The serializable InsightQuery (see @openbooks/analytics `InsightQuery`). */
    query: jsonb("query").notNull().default({}),
    vizType: text("viz_type", { enum: INSIGHT_VIZ_TYPES }).notNull().default("table"),
    /** Per-card display settings (see analytics `VizSettings`). */
    vizSettings: jsonb("viz_settings").notNull().default({}),
    status: text("status", { enum: INSIGHT_STATUSES }).notNull().default("draft"),
    /**
     * Role gating for the shared library. Empty/null ⇒ every insights reader may
     * see a published card; non-empty ⇒ only these role keys (plus admins).
     */
    allowedRoles: jsonb("allowed_roles").$type<string[]>(),
    ...auditColumns,
  },
  (t) => [
    index("insight_cards_org_status").on(t.orgId, t.status),
    index("insight_cards_org_name").on(t.orgId, t.name),
  ],
);

export const insightDashboards = pgTable(
  "insight_dashboards",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Grid placement of cards: [{ cardId, x, y, w, h }] on a 12-column grid.
     * Card visibility is still governed by each card's own status/allowedRoles.
     */
    layout: jsonb("layout").$type<
      { cardId: string; x: number; y: number; w: number; h: number }[]
    >().notNull().default([]),
    status: text("status", { enum: INSIGHT_STATUSES }).notNull().default("draft"),
    allowedRoles: jsonb("allowed_roles").$type<string[]>(),
    /**
     * Home-surface resolution (see web/app/(app)/page.tsx). A dashboard can be:
     *   - the org's seeded system default home  (`isHome = true`, at most one),
     *   - a role's default home                 (`homeForRole = <role key>`),
     * and, orthogonally, a user's personal home (users.homeDashboardId → this id).
     * Resolution order for a given user: personal → their role's → the system
     * default. All three are just pointers at a normal dashboard, so a home board
     * is edited with the same builder as any other.
     */
    isHome: boolean("is_home").notNull().default(false),
    homeForRole: text("home_for_role"),
    ...auditColumns,
  },
  (t) => [
    index("insight_dashboards_org_status").on(t.orgId, t.status),
    index("insight_dashboards_org_name").on(t.orgId, t.name),
    // Only true is_home rows claim the org-wide default pointer; every
    // dashboard remains free to carry the ordinary false value.
    uniqueIndex("insight_dashboards_org_home")
      .on(t.orgId)
      .where(sql`${t.isHome}`),
    // Null means that a dashboard is not a role default, so it must not
    // collide with another unassigned dashboard.
    uniqueIndex("insight_dashboards_org_role_home")
      .on(t.orgId, t.homeForRole)
      .where(sql`${t.homeForRole} IS NOT NULL`),
  ],
);

/** A user's personal pins — the dashboards (and their order) the home surface
 *  offers them. One row per (user, dashboard). */
export const insightDashboardPins = pgTable(
  "insight_dashboard_pins",
  {
    id: id(),
    orgId: orgRef(),
    userId: uuid("user_id").notNull(),
    dashboardId: uuid("dashboard_id").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("insight_pins_user").on(t.orgId, t.userId, t.sortOrder),
    index("insight_pins_dashboard").on(t.dashboardId),
    uniqueIndex("insight_pins_unique").on(t.userId, t.dashboardId),
  ],
);

/*
 * Foreign keys (add to schema/migrations/referential-integrity.sql):
 *
 *   alter table insight_cards add foreign key (org_id) references orgs(id);
 *   alter table insight_dashboards add foreign key (org_id) references orgs(id);
 *   alter table insight_dashboard_pins
 *     add foreign key (org_id) references orgs(id),
 *     add foreign key (user_id) references users(id) on delete cascade,
 *     add foreign key (dashboard_id) references insight_dashboards(id) on delete cascade;
 *
 * (Card placements inside insight_dashboards.layout reference insight_cards.id
 *  by value in jsonb — not a column FK; the dashboard API filters out missing
 *  or unpublished cards at read time so a deleted card can't break a board.)
 */
