import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Views — the source platform Saved Search analogue, under the Knowledge menu. A view
 * is a named, shareable query over the same entity catalog as
 * @openbooks/reports (ledger_lines, documents, parties, accounts): detail rows
 * OR a grouped summary, with a nested and/or filter tree, sort, and a row cap.
 * The query plan is THE SAME ReportCustomQuery type the report studio stores —
 * executed by the SAME compiler/executor (runCustomQuery) — so views and custom
 * reports share one proven, injection-safe query engine instead of a duplicate.
 *
 * View-specific metadata (absent from report_definitions): an OWNER and a SCOPE.
 * `private` views are visible only to their owner; `shared` views are visible
 * org-wide (optionally gated to a set of roles via allowedRoles, mirroring
 * insight_cards).
 *
 *   saved_views
 *     └─ (runs are ad-hoc; an export produces a fresh result — there is no
 *        saved_runs table, unlike report_runs, because a view is meant to be
 *        browsed live, not archived)
 */

export const SAVED_VIEW_SCOPES = ["private", "shared"] as const;

export const savedViews = pgTable(
  "saved_views",
  {
    id: id(),
    orgId: orgRef(),
    /** Stable per-org slug (deep links + idempotent seeding). */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * The ReportCustomQuery plan (@openbooks/reports types.ts): entity, mode,
     * columns, breakouts, measures, filters (nested and/or tree), sort, limit.
     * Validated by validateCustomQuery on every write.
     */
    query: jsonb("query").$type<Record<string, unknown>>().notNull(),
    /**
     * ReportLayoutConfig (paper/orientation/margins/density) for PDF export.
     * Null ⇒ engine default. Consumed by the export route (resolveReportLayout).
     */
    layout: jsonb("layout").$type<Record<string, unknown>>(),
    /** private = owner-only; shared = org-wide (subject to allowedRoles). */
    scope: text("scope", { enum: SAVED_VIEW_SCOPES }).notNull().default("private"),
    /** The owner. Private views are scoped to this user. */
    ownerId: uuid("owner_id").notNull(),
    /**
     * Role gating for shared views. Empty/null ⇒ every reader may see it;
     * non-empty ⇒ only these role keys (plus admins).
     */
    allowedRoles: jsonb("allowed_roles").$type<string[]>(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("saved_views_org_slug").on(t.orgId, t.slug),
    index("saved_views_org_scope").on(t.orgId, t.scope),
    index("saved_views_org_owner").on(t.orgId, t.ownerId),
    index("saved_views_org_name").on(t.orgId, t.name),
  ],
);

/*
FOREIGN KEYS (added by the integrator's migration pass to
schema/migrations/referential-integrity.sql):
  saved_views.org_id     → orgs.id
  saved_views.owner_id   → users.id
  saved_views.created_by → users.id
  saved_views.updated_by → users.id
*/
