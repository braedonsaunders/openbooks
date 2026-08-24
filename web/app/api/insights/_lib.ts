import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  INSIGHT_VIZ_TYPES,
  validateInsightQuery,
  type VizSettings,
  type VizType,
} from '@openbooks/analytics'

/** Trimmed string or null. */
export function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

export function isVizType(v: unknown): v is VizType {
  return typeof v === 'string' && (INSIGHT_VIZ_TYPES as readonly string[]).includes(v)
}

/** Validate + normalize an incoming query plan; throws on a bad shape. */
export function normalizeQuery(v: unknown) {
  return validateInsightQuery(v ?? { source: 'ledger_lines' })
}

/** Coerce an unknown viz-settings blob to a plain object (studio owns the keys;
 *  we persist what it sends but reject non-objects). */
export function normalizeVizSettings(v: unknown): VizSettings {
  if (v == null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('viz_settings must be an object')
  return v as VizSettings
}

/** Sanitize allowedRoles jsonb (string[] | null). */
export function normalizeAllowedRoles(v: unknown): string[] | null {
  if (v == null) return null
  if (!Array.isArray(v)) throw new Error('allowedRoles must be a list of role keys')
  const roles = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
  return roles.length ? roles : null
}

export type CardRow = {
  id: string
  name: string
  description: string | null
  query: unknown
  viz_type: VizType
  viz_settings: VizSettings
  status: 'draft' | 'published'
  allowed_roles: string[] | null
  updated_at: string
}

export async function loadCard(id: string, orgId: string): Promise<CardRow | null> {
  const res = (await db.execute<CardRow>(sql`
    select id, name, description, query, viz_type, viz_settings, status, allowed_roles, updated_at
      from insight_cards
     where id = ${id} and org_id = ${orgId}
  `))
  return res.rows[0] ?? null
}

export type DashboardRow = {
  id: string
  name: string
  description: string | null
  layout: { cardId: string; x: number; y: number; w: number; h: number }[]
  status: 'draft' | 'published'
  allowed_roles: string[] | null
  updated_at: string
}

export async function loadDashboard(id: string, orgId: string): Promise<DashboardRow | null> {
  const res = (await db.execute<DashboardRow>(sql`
    select id, name, description, layout, status, allowed_roles, updated_at
      from insight_dashboards
     where id = ${id} and org_id = ${orgId}
  `))
  return res.rows[0] ?? null
}

export type DashboardCard = {
  id: string
  name: string
  description: string | null
  query: unknown
  viz_type: VizType
  viz_settings: VizSettings
  status: 'draft' | 'published'
}

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
): Promise<{ dashboard: DashboardRow; cards: DashboardCard[]; layout: DashboardRow['layout'] } | null> {
  const dashboard = await loadDashboard(dashboardId, orgId)
  if (!dashboard) return null
  const publishedOnly = opts.publishedOnly !== false

  const cardIds = [...new Set(dashboard.layout.map((w) => w.cardId))]
  if (cardIds.length === 0) return { dashboard, cards: [], layout: [] }

  const res = (await db.execute<DashboardCard>(sql`
    select id, name, description, query, viz_type, viz_settings, status
      from insight_cards
     where org_id = ${orgId} and id = any(${`{${cardIds.join(',')}}`}::uuid[])
       ${publishedOnly ? sql`and status = 'published'` : sql``}
  `))

  const present = new Set(res.rows.map((r) => r.id))
  const layout = dashboard.layout.filter((w) => present.has(w.cardId))
  return { dashboard, cards: res.rows, layout }
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
export type HomeResolution = { dashboardId: string; source: 'personal' | 'role' | 'system' }

export async function resolveHomeDashboard(
  orgId: string,
  userId: string,
  role: string,
): Promise<HomeResolution | null> {
  // One query resolves all three tiers: the user's personal pointer, their role
  // default, and the system default — restricted to PUBLISHED boards so a draft
  // can't become someone's home. We keep the highest-priority present.
  const res = (await db.execute<{ id: string; source: HomeResolution['source'] }>(sql`
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
       and (
         d.id = (select home_dashboard_id from u)
         or d.home_for_role = ${role}
         or d.is_home = true
       )
     order by priority asc
     limit 1
  `))

  const row = res.rows[0]
  return row ? { dashboardId: row.id, source: row.source } : null
}

/** Normalize a dashboard layout array — clamp geometry, drop malformed entries. */
export function normalizeLayout(v: unknown): { cardId: string; x: number; y: number; w: number; h: number }[] {
  if (v == null) return []
  if (!Array.isArray(v)) throw new Error('layout must be a list of placements')
  const out: { cardId: string; x: number; y: number; w: number; h: number }[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const cardId = ((item)).cardId
    if (typeof cardId !== 'string' || cardId === '') continue
    const clamp = (n: unknown, min: number, max: number, dflt: number) => {
      const num = Number(n)
      if (!Number.isFinite(num)) return dflt
      return Math.max(min, Math.min(max, Math.trunc(num)))
    }
    out.push({
      cardId,
      x: clamp(((item)).x, 0, 11, 0),
      y: clamp(((item)).y, 0, 999, 0),
      w: clamp(((item)).w, 1, 12, 6),
      h: clamp(((item)).h, 1, 24, 4),
    })
  }
  return out
}
