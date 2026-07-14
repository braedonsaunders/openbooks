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
  const res = (await db.execute(sql`
    select id, name, description, query, viz_type, viz_settings, status, allowed_roles, updated_at
      from insight_cards
     where id = ${id} and org_id = ${orgId}
  `)) as unknown as { rows: CardRow[] }
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
  const res = (await db.execute(sql`
    select id, name, description, layout, status, allowed_roles, updated_at
      from insight_dashboards
     where id = ${id} and org_id = ${orgId}
  `)) as unknown as { rows: DashboardRow[] }
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

  const res = (await db.execute(sql`
    select id, name, description, query, viz_type, viz_settings, status
      from insight_cards
     where org_id = ${orgId} and id = any(${cardIds})
       ${publishedOnly ? sql`and status = 'published'` : sql``}
  `)) as unknown as { rows: DashboardCard[] }

  const present = new Set(res.rows.map((r) => r.id))
  const layout = dashboard.layout.filter((w) => present.has(w.cardId))
  return { dashboard, cards: res.rows, layout }
}

/** Normalize a dashboard layout array — clamp geometry, drop malformed entries. */
export function normalizeLayout(v: unknown): { cardId: string; x: number; y: number; w: number; h: number }[] {
  if (v == null) return []
  if (!Array.isArray(v)) throw new Error('layout must be a list of placements')
  const out: { cardId: string; x: number; y: number; w: number; h: number }[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const cardId = (item as any).cardId
    if (typeof cardId !== 'string' || cardId === '') continue
    const clamp = (n: unknown, min: number, max: number, dflt: number) => {
      const num = Number(n)
      if (!Number.isFinite(num)) return dflt
      return Math.max(min, Math.min(max, Math.trunc(num)))
    }
    out.push({
      cardId,
      x: clamp((item as any).x, 0, 11, 0),
      y: clamp((item as any).y, 0, 999, 0),
      w: clamp((item as any).w, 1, 12, 6),
      h: clamp((item as any).h, 1, 24, 4),
    })
  }
  return out
}
