import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Saved searches — the NetSuite Saved Search analogue, under the Knowledge
 * menu. A saved search is a named, shareable query over the same entity
 * catalog as @openbooks/reports (ledger_lines, documents, parties, accounts):
 * detail rows OR a grouped summary, with a nested and/or filter tree, sort,
 * and a row cap. The query plan is THE SAME ReportCustomQuery type the report
 * studio stores — executed by the SAME compiler/executor (runCustomQuery) —
 * so saved searches and custom reports share one proven, injection-safe query
 * engine instead of a duplicate.
 *
 * Saved-search-specific metadata (absent from report_definitions): an OWNER and
 * a SCOPE. `private` searches are visible only to their owner; `shared` searches
 * are visible org-wide (optionally gated to a set of roles via allowedRoles,
 * mirroring insight_cards).
 *
 *   saved_searches
 *     └─ (runs are ad-hoc; an export produces a fresh result — there is no
 *        saved_runs table, unlike report_runs, because a saved search is meant
 *        to be browsed live, not archived)
 */

export const SAVED_SEARCH_SCOPES = ["private", "shared"] as const;

export const savedSearches = pgTable(
  "saved_searches",
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
    scope: text("scope", { enum: SAVED_SEARCH_SCOPES }).notNull().default("private"),
    /** The owner. Private searches are scoped to this user. */
    ownerId: uuid("owner_id").notNull(),
    /**
     * Role gating for shared searches. Empty/null ⇒ every reader may see it;
     * non-empty ⇒ only these role keys (plus admins).
     */
    allowedRoles: jsonb("allowed_roles").$type<string[]>(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("saved_searches_org_slug").on(t.orgId, t.slug),
    index("saved_searches_org_scope").on(t.orgId, t.scope),
    index("saved_searches_org_owner").on(t.orgId, t.ownerId),
    index("saved_searches_org_name").on(t.orgId, t.name),
  ],
);

/*
FOREIGN KEYS (added by the integrator's migration pass to
schema/migrations/referential-integrity.sql):
  saved_searches.org_id     → orgs.id
  saved_searches.owner_id   → users.id
  saved_searches.created_by → users.id
  saved_searches.updated_by → users.id
*/
