import { can, getAuthz, type Authz } from "@/lib/authz";
import { isUuid } from "../../../lib/list-params";
import { insightVisibilitySql } from "@/lib/insight-access";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { allowedSources, getSource, sourcePermission } from "@openbooks/analytics";
import { REPORT_ENTITY_MAP } from "@openbooks/reports";
import { featureEnabled, isFeatureEnabled, orgFeatureState } from "@/lib/features";
import { NextResponse } from "next/server";
import {
  INSIGHT_VIZ_TYPES,
  validateInsightQuery,
  type VizSettings,
  type VizType,
} from "@openbooks/analytics";

/** Trimmed string or null. */
export function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

export function isVizType(v: unknown): v is VizType {
  return typeof v === "string" && (INSIGHT_VIZ_TYPES as readonly string[]).includes(v);
}

/** Validate + normalize an incoming query plan; throws on a bad shape. */
export function normalizeQuery(v: unknown) {
  return validateInsightQuery(v ?? { source: "ledger_lines" });
}

/** Refuse a stored or incoming card query whose source is not readable by this caller. */
export async function guardInsightCardQuery(
  authz: Authz,
  query: unknown,
): Promise<NextResponse | null> {
  const source = (query as { source?: unknown } | null)?.source;
  if (typeof source !== "string" || !getSource(source)) {
    return NextResponse.json({ error: "you do not have access to this data" }, { status: 403 });
  }
  const permission = sourcePermission(source);
  if (permission && !can(authz, permission)) {
    return NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 });
  }
  const feature = REPORT_ENTITY_MAP[source]?.featureKey;
  if (feature && !(await isFeatureEnabled(authz.user.orgId, feature))) {
    return NextResponse.json({ error: `${feature} feature is disabled` }, { status: 403 });
  }
  return null;
}

/** One allowlist for the cards catalog and dashboard palette. */
export async function visibleInsightSourceKeys(authz: Authz): Promise<string[]> {
  const features = await orgFeatureState(authz.user.orgId);
  return allowedSources(
    (permission) => can(authz, permission),
    (feature) => featureEnabled(features, feature),
  ).map((source) => source.key);
}

export function insightSourceFilter(sourceKeys: string[]) {
  if (sourceKeys.length === 0) return sql`false`;
  return sql`query->>'source' in (${sql.join(
    sourceKeys.map((key) => sql`${key}`),
    sql`, `,
  )})`;
}

/** Coerce an unknown viz-settings blob to a plain object (studio owns the keys;
 *  we persist what it sends but reject non-objects). */
export function normalizeVizSettings(v: unknown): VizSettings {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("viz_settings must be an object");
  return v as VizSettings;
}

/** Sanitize allowedRoles jsonb (string[] | null). */
export function normalizeAllowedRoles(v: unknown): string[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new Error("allowedRoles must be a list of role keys");
  if (v.some((role) => typeof role !== "string" || role.trim() === "")) {
    throw new Error("allowedRoles must contain non-empty role keys");
  }
  const roles = [...new Set((v as string[]).map((role) => role.trim()))];
  return roles.length ? roles : null;
}

export type CardRow = {
  id: string;
  name: string;
  description: string | null;
  query: unknown;
  viz_type: VizType;
  viz_settings: VizSettings;
  status: "draft" | "published";
  allowed_roles: string[] | null;
  updated_at: string;
};

export async function loadCard(
  id: string,
  orgId: string,
  resolvedAuthz?: Authz,
): Promise<CardRow | null> {
  const authz = resolvedAuthz ?? (await getAuthz());
  if (!authz || authz.user.orgId !== orgId) return null;
  const res = await db.execute<CardRow>(
    sql`
    select id, name, description, query, viz_type, viz_settings, status, allowed_roles,
      to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
      from insight_cards
     where id = ${id} and org_id = ${orgId} and ${insightVisibilitySql(authz)}
  `,
    "objects",
  );
  const card = res[0];
  if (!card || (await guardInsightCardQuery(authz, card.query))) return null;
  return card;
}

export type DashboardRow = {
  id: string;
  name: string;
  description: string | null;
  layout: { cardId: string; x: number; y: number; w: number; h: number }[];
  status: "draft" | "published";
  allowed_roles: string[] | null;
  updated_at: string;
};

export async function loadDashboard(
  id: string,
  orgId: string,
  resolvedAuthz?: Authz,
): Promise<DashboardRow | null> {
  const authz = resolvedAuthz ?? (await getAuthz());
  if (!authz || authz.user.orgId !== orgId) return null;
  const res = await db.execute<DashboardRow>(
    sql`
    select id, name, description, layout, status, allowed_roles,
      to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
      from insight_dashboards
     where id = ${id} and org_id = ${orgId} and ${insightVisibilitySql(authz)}
  `,
    "objects",
  );
  return res[0] ?? null;
}

export async function listInsightCardsForAuthz(
  authz: Authz,
  input: {
    query?: string;
    status?: "draft" | "published";
    limit: number;
    offset: number;
    sort: "name" | "updated";
    direction: "asc" | "desc";
  },
): Promise<CardRow[]> {
  const sourceKeys = await visibleInsightSourceKeys(authz);
  const sourceFilter = insightSourceFilter(sourceKeys);
  const like = input.query ? `%${input.query}%` : null;
  const sort = input.sort === "name" ? sql.raw("name") : sql.raw("updated_at");
  const direction = input.direction === "asc" ? sql.raw("asc") : sql.raw("desc");
  return db.execute<CardRow>(
    sql`
      select id, name, description, viz_type, status, query, allowed_roles, viz_settings,
             to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
        from insight_cards
       where org_id = ${authz.user.orgId} and ${insightVisibilitySql(authz)} and ${sourceFilter}
         ${like ? sql`and name ilike ${like}` : sql``}
         ${input.status ? sql`and status = ${input.status}` : sql``}
       order by ${sort} ${direction} nulls last
       limit ${input.limit} offset ${input.offset}
    `,
    "objects",
  );
}

export async function listInsightDashboardsForAuthz(
  authz: Authz,
  input: {
    query?: string;
    status?: "draft" | "published";
    limit: number;
    offset: number;
    sort: "name" | "updated";
    direction: "asc" | "desc";
  },
): Promise<Array<DashboardRow & { card_count: number }>> {
  const like = input.query ? `%${input.query}%` : null;
  const sort = input.sort === "name" ? sql.raw("name") : sql.raw("updated_at");
  const direction = input.direction === "asc" ? sql.raw("asc") : sql.raw("desc");
  return db.execute<DashboardRow & { card_count: number }>(
    sql`
      select id, name, description, layout, status, allowed_roles,
             jsonb_array_length(layout) as card_count,
             to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
        from insight_dashboards
       where org_id = ${authz.user.orgId} and ${insightVisibilitySql(authz)}
         ${like ? sql`and name ilike ${like}` : sql``}
         ${input.status ? sql`and status = ${input.status}` : sql``}
       order by ${sort} ${direction} nulls last
       limit ${input.limit} offset ${input.offset}
    `,
    "objects",
  );
}

export type DashboardCard = {
  id: string;
  name: string;
  description: string | null;
  query: unknown;
  viz_type: VizType;
  viz_settings: VizSettings;
  status: "draft" | "published";
};

/**
 * Resolve a dashboard + its placed cards for embedding (dashboards page, and
 * later the home surface). Returns only cards that still exist; when
 * `publishedOnly` is set (the default for viewers) draft cards are dropped so a
 * board never surfaces an unpublished card. Missing/removed cards fall out of
 * the returned layout so a deleted card can't break the grid.
 */
export async function loadDashboardEmbed(
  dashboardId: string,
  orgId: string,
  opts: { publishedOnly?: boolean } = {},
): Promise<{
  dashboard: DashboardRow;
  cards: DashboardCard[];
  layout: DashboardRow["layout"];
} | null> {
  const authz = await getAuthz();
  if (!authz || authz.user.orgId !== orgId) return null;
  const dashboard = await loadDashboard(dashboardId, orgId);
  if (!dashboard) return null;
  const publishedOnly = opts.publishedOnly !== false;
  const sourceFilter = insightSourceFilter(await visibleInsightSourceKeys(authz));

  // Well-formed ids only. A layout is user data, and a widget pointing at
  // something that is not a uuid — a hand-edited board, an import, a seed —
  // used to reach `any(…::uuid[])` and 500 the whole page. This function
  // already tolerates a card id that resolves to nothing (see the `present`
  // filter below); tolerating one that never could is the same promise.
  const cardIds = [...new Set(dashboard.layout.map((w) => w.cardId))].filter(isUuid);
  if (cardIds.length === 0) return { dashboard, cards: [], layout: [] };

  const res = await db.execute<DashboardCard>(
    sql`
    select id, name, description, query, viz_type, viz_settings, status
      from insight_cards
     where org_id = ${orgId} and id = any(${`{${cardIds.join(",")}}`}::uuid[])
       and ${insightVisibilitySql(authz)}
       and ${sourceFilter}
       ${publishedOnly ? sql`and status = 'published'` : sql``}
  `,
    "objects",
  );

  const present = new Set(res.map((r) => r.id));
  const layout = dashboard.layout.filter((w) => present.has(w.cardId));
  return { dashboard, cards: res, layout };
}

/**
 * Resolve the home dashboard for a given user, honoring the three-tier pointer
 * model (see schema/src/insights.ts + extension.ts):
 *
 *   1. the user's personal home       (users.home_dashboard_id)
 *   2. their role's default home       (insight_dashboards.home_for_role = <role>)
 *   3. the org's seeded system default (insight_dashboards.is_home = true)
 *
 * Every pointer is tolerated as dangling: a personal/role board that was deleted
 * or unpublished simply falls through to the next tier, so a bad pointer can
 * never lock a user out of their home. Returns the dashboard id + which tier it
 * came from (the home page uses `source` to label the Customize control), or
 * null when the org has seeded no home board at all.
 */
export type HomeResolution = { dashboardId: string; source: "personal" | "role" | "system" };

export async function resolveHomeDashboard(
  orgId: string,
  userId: string,
  role: string,
): Promise<HomeResolution | null> {
  const authz = await getAuthz();
  if (!authz || authz.user.orgId !== orgId || authz.user.id !== userId) return null;
  // One query resolves all three tiers: the user's personal pointer, their role
  // default, and the system default — restricted to PUBLISHED boards so a draft
  // can't become someone's home. We keep the highest-priority present.
  const res = await db.execute<{ id: string; source: HomeResolution["source"] }>(
    sql`
    with u as (select home_dashboard_id from users where id = ${userId} and org_id = ${orgId})
    select d.id,
           case
             when d.id = (select home_dashboard_id from u) then 'personal'
             when d.home_for_role = ${role} then 'role'
             else 'system'
           end as source,
           case
             when d.id = (select home_dashboard_id from u) then 1
             when d.home_for_role = ${role} then 2
             when d.is_home then 3
             else 9
           end as priority
      from insight_dashboards d
     where d.org_id = ${orgId}
       and d.status = 'published'
       and ${insightVisibilitySql(authz, "d")}
       and (
         d.id = (select home_dashboard_id from u)
         or d.home_for_role = ${role}
         or d.is_home = true
       )
     order by priority asc, d.id asc
     limit 1
  `,
    "objects",
  );

  const row = res[0];
  return row ? { dashboardId: row.id, source: row.source } : null;
}

/**
 * Every card a layout places must exist in this org and be visible to the
 * caller — the same predicate the dashboard PATCH applies and the embed
 * loader re-checks. A layout naming a missing or foreign card is refused
 * here so a create can never commit an audited 201 whose board renders
 * empty. Runs inside the caller's transaction (the check and the insert
 * commit atomically).
 */
export async function layoutCardsVisible(
  runner: Pick<typeof db, "execute">,
  authz: Authz,
  layout: { cardId: string }[],
): Promise<boolean> {
  if (layout.length === 0) return true;
  const ids = [...new Set(layout.map((widget) => widget.cardId))];
  const sourceFilter = insightSourceFilter(await visibleInsightSourceKeys(authz));
  const cards = await runner.execute<{ id: string }>(
    sql`
    select id from insight_cards where id = any(${`{${ids.join(",")}}`}::uuid[])
      and ${insightVisibilitySql(authz)}
      and ${sourceFilter}
  `,
    "objects",
  );
  return cards.length === ids.length;
}

/** Normalize a dashboard layout array — clamp geometry, drop malformed entries. */
export function normalizeLayout(
  v: unknown,
): { cardId: string; x: number; y: number; w: number; h: number }[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Error("layout must be a list of placements");
  const out: { cardId: string; x: number; y: number; w: number; h: number }[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const cardId = item.cardId;
    if (!isUuid(cardId)) throw new Error("layout must reference valid card ids");
    const clamp = (n: unknown, min: number, max: number, dflt: number) => {
      const num = Number(n);
      if (!Number.isFinite(num)) return dflt;
      return Math.max(min, Math.min(max, Math.trunc(num)));
    };
    out.push({
      cardId,
      x: clamp(item.x, 0, 11, 0),
      y: clamp(item.y, 0, 999, 0),
      w: clamp(item.w, 1, 12, 6),
      h: clamp(item.h, 1, 24, 4),
    });
  }
  return out;
}
