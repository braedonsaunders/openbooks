import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { defaultListView, recordTypeFeatureKey } from '@openbooks/customization'
import { can, type Authz } from './authz'
import { featureEnabled, resolvedFeatureState, subsidiaryFeatureEnabled, type FeatureState } from './features'
import { visibleNavigationHref } from './nav/access'
import { entityListSource } from './list/entity-sources'
import { subsidiaryVisibleFilter } from './subsidiaries'
import { fileReadPredicate } from './file-cabinet/visibility'
import { documentsPageViewer } from './file-cabinet/page-viewer'
import { insightVisibilitySql } from './insight-access'
import { inTypeAudience, recordVisibleInSubsidiaryFenceSql, subsidiaryDeclaredTypeIds } from './records'
import { lintRecordFields, listableFields } from './record-schema'
import { SETUP_ENTITY_BY_KEY, resolveSetupEntityGate } from './setup/registry'
import { setupEntitySubsidiaryFilter } from './setup/subsidiary-scope'
import type { RecentRef, SearchGroup, SearchHit, SearchRecordType } from './search-types'

/**
 * Global search over the operational records beyond the core ledger
 * entities (lib/search.ts): fixed assets, equipment, opportunities,
 * activities, timesheets, subscriptions, custom records, files, dashboards,
 * locations and warehouses.
 *
 * Every leg answers to the page that opens its result. A result is offered
 * only when that page is in the reader's navigation (permission and
 * Features switch, through the same rule the menu uses), and rows are
 * fenced exactly like that page's list: list-backed records run the list
 * source's own WHERE builder, and the rest reuse the visibility helper their
 * page reads through. Search never shows a row its list would hide.
 */

const PER_GROUP = 5

type Match = { kind: 'text'; q: string; like: string } | { kind: 'ids'; ids: string[] }

type Context = {
  authz: Authz
  orgId: string
  features: FeatureState
  /** Whether the page owning `href` is in this reader's navigation. */
  navigable: (href: string) => boolean
}

type Leg = {
  type: SearchRecordType
  labelKey: string
  /** Whether a recent reference id is well-formed for this leg. */
  validId: (id: string) => boolean
  run: (ctx: Context, match: Match) => Promise<SearchHit[]>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (id: string) => UUID.test(id)

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(',')}}`}::uuid[]`
}

/**
 * A list-backed record type. Title and subtitle name built-in column keys of
 * the list source, so they read through the same expressions (and joins)
 * the list renders.
 */
type ListSourceSearch = {
  type: SearchRecordType
  labelKey: string
  recordType: string
  title: string
  subtitle: string
  iconKey: string
  validId?: (id: string) => boolean
}

const LIST_SOURCE_SEARCHES: ListSourceSearch[] = [
  { type: 'opportunity', labelKey: 'opportunities', recordType: 'opportunity', title: 'title', subtitle: 'account_name', iconKey: 'activity' },
  { type: 'activity', labelKey: 'activities', recordType: 'activity', title: 'subject', subtitle: 'customer_name', iconKey: 'timer' },
  { type: 'asset', labelKey: 'assets', recordType: 'fixed_asset', title: 'name', subtitle: 'asset_number', iconKey: 'building' },
  { type: 'equipment', labelKey: 'equipment', recordType: 'equipment_unit', title: 'name', subtitle: 'unit_number', iconKey: 'truck' },
  // A timesheet is one employee's week; its id is `<employee>:<week start>`.
  {
    type: 'timesheet',
    labelKey: 'timesheets',
    recordType: 'timesheet_week',
    title: 'employee_name',
    subtitle: 'week_start',
    iconKey: 'timer',
    validId: (id) => /^[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/i.test(id) && isUuid(id.slice(0, 36)),
  },
]

function listSourceLeg(config: ListSourceSearch): Leg {
  return {
    type: config.type,
    labelKey: config.labelKey,
    validId: config.validId ?? isUuid,
    async run(ctx, match) {
      const source = entityListSource(config.recordType)
      const titleExpr = source?.builtInExpr[config.title]
      const subtitleExpr = source?.builtInExpr[config.subtitle]
      if (!source || !titleExpr || !subtitleExpr) return []
      const featureKey = recordTypeFeatureKey(config.recordType)
      if (featureKey && !featureEnabled(ctx.features, featureKey)) return []
      if (source.readPermission && !can(ctx.authz, source.readPermission)) return []
      if (!ctx.navigable(source.basePath)) return []

      const scope = ctx.authz.allowedSubsidiaryIds
      const view = defaultListView(config.recordType, { multiSubsidiary: await subsidiaryFeatureEnabled(ctx.orgId) })
      const listWhere = source.where(view, { q: match.kind === 'text' ? match.q : undefined, filters: {} }, ctx.orgId, scope)
      const idExpr = source.idExpr ?? sql.raw(`${source.alias}.id`)
      const tableSql = typeof source.table === 'function'
        ? sql`${source.table(ctx.orgId)} ${sql.raw(source.alias)}`
        : sql.raw(`${source.table} ${source.alias}`)
      const joins = typeof source.baseJoins === 'function'
        ? source.baseJoins(scope, await businessToday(ctx.orgId))
        : source.baseJoins
      const where = match.kind === 'ids'
        ? sql`(${listWhere}) and (${idExpr})::text = any(${`{${match.ids.join(',')}}`}::text[])`
        : listWhere
      // Best name match first, then the newest (latest week, highest number).
      const order = match.kind === 'text'
        ? sql`similarity(coalesce((${titleExpr})::text, ''), ${match.q}) desc, ${source.defaultSort} desc`
        : sql`${source.defaultSort} desc`
      const r = await db.execute<{ id: string; title: string | null; subtitle: string | null }>(sql`
        select (${idExpr})::text as id, (${titleExpr})::text as title, (${subtitleExpr})::text as subtitle
          from ${tableSql} ${joins}
         where ${where}
         order by ${order}
         limit ${PER_GROUP}`)
      return r.rows.map((row): SearchHit => ({
        id: row.id,
        type: config.type,
        title: row.title ?? row.subtitle ?? '',
        subtitle: row.title != null ? row.subtitle ?? undefined : undefined,
        href: `${source.basePath}?${source.drawerParam}=${encodeURIComponent(row.id)}`,
        iconKey: config.iconKey,
      }))
    },
  }
}

/**
 * Subscriptions belong to their customer's legal entity and customers are
 * master data, so the fence is the subscriptions list's: an unassigned
 * customer is org-wide and a reader with no subsidiaries sees none. They
 * open in the Recurring & Collections drawer, which needs that page, the
 * receivables read grant and Subscription billing.
 */
const subscriptionLeg: Leg = {
  type: 'subscription',
  labelKey: 'subscriptions',
  validId: isUuid,
  async run(ctx, match) {
    if (!can(ctx.authz, 'ar.read') || !featureEnabled(ctx.features, 'subscriptionBilling')) return []
    if (!ctx.navigable('/collections')) return []
    const allowed = ctx.authz.allowedSubsidiaryIds
    const customerScope = allowed !== null && allowed.size === 0
      ? sql` and false`
      : subsidiaryVisibleFilter(sql`c.subsidiary_id`, allowed, { orgWideNull: true })
    const predicate = match.kind === 'ids'
      ? sql`s.id = any(${uuidArray(match.ids)})`
      : sql`(c.display_name ilike ${match.like} or p.name ilike ${match.like} or s.memo ilike ${match.like})`
    const r = await db.execute<{ id: string; customer_name: string | null; plan_name: string; status: string }>(sql`
      select s.id, c.display_name as customer_name, p.name as plan_name, s.status
        from subscriptions s
        join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
        left join parties c on c.id = s.customer_id and c.org_id = s.org_id
       where s.org_id = ${ctx.orgId}${customerScope}
         and ${predicate}
       order by c.display_name, s.created_at desc
       limit ${PER_GROUP}`)
    return r.rows.map((row): SearchHit => ({
      id: row.id,
      type: 'subscription',
      title: row.customer_name ?? row.plan_name,
      subtitle: row.customer_name ? row.plan_name : undefined,
      href: `/collections?view=subscriptions&subscription=${row.id}`,
      iconKey: 'history',
      badge: { kind: 'status', value: row.status },
    }))
  },
}

type RecordTypeRow = {
  id: string
  key: string
  name: string
  icon_key: string
  fields: unknown
  allowed_roles: string[] | null
}

/**
 * Custom records: published types in the reader's audience, fenced by the
 * same JSON subsidiary rule the record drawer applies. A record reads by
 * its first text column when it has one, else by its number.
 */
const customRecordLeg: Leg = {
  type: 'record',
  labelKey: 'records',
  validId: isUuid,
  async run(ctx, match) {
    if (!can(ctx.authz, 'records.read')) return []
    const types = (await db.execute<RecordTypeRow>(sql`
      select id, key, name, icon_key, fields, allowed_roles
        from custom_record_types
       where org_id = ${ctx.orgId} and status = 'published'`)).rows
    const roleKeys = ctx.authz.user.roles.map(({ key }) => key)
    const visible = types.filter((type) => inTypeAudience(roleKeys, type.allowed_roles))
    if (visible.length === 0) return []

    const declared = new Set(subsidiaryDeclaredTypeIds(visible))
    const fence = ctx.authz.allowedSubsidiaryIds
    const typeScopes = [true, false].flatMap((declares) => {
      const ids = visible.filter((type) => declared.has(type.id) === declares).map((type) => type.id)
      if (ids.length === 0) return []
      const subsidiary = recordVisibleInSubsidiaryFenceSql(fence, declares)
      return [sql`(type_id = any(${uuidArray(ids)})${subsidiary ? sql` and ${subsidiary}` : sql``})`]
    })
    const titleFieldByType = new Map(visible.flatMap((type) => {
      const lint = lintRecordFields(type.fields, type.name)
      const field = lint.success ? listableFields(lint.sections).find((candidate) => candidate.type === 'text') : undefined
      return field ? [[type.id, field.id] as const] : []
    }))
    const label = titleFieldByType.size === 0
      ? sql`null`
      : sql`case ${sql.join([...titleFieldByType].map(([typeId, fieldId]) => sql`when type_id = ${typeId} then nullif(data ->> ${fieldId}, '')`), sql` `)} end`
    const predicate = match.kind === 'ids'
      ? sql`id = any(${uuidArray(match.ids)})`
      : sql`(search_text ilike ${match.like.toLowerCase()} or record_number ilike ${match.like})`
    const r = await db.execute<{ id: string; type_id: string; record_number: string; label: string | null }>(sql`
      select id, type_id, record_number, ${label} as label
        from custom_records
       where org_id = ${ctx.orgId} and status <> 'inactive'
         and (${sql.join(typeScopes, sql` or `)})
         and ${predicate}
       order by created_at desc
       limit ${PER_GROUP}`)
    const typeById = new Map(visible.map((type) => [type.id, type]))
    return r.rows.flatMap((row): SearchHit[] => {
      const type = typeById.get(row.type_id)
      if (!type) return []
      return [{
        id: row.id,
        type: 'record',
        title: row.label ?? row.record_number,
        subtitle: row.label ? `${type.name} · ${row.record_number}` : type.name,
        href: `/records/${encodeURIComponent(type.key)}?rec=${row.id}`,
        iconKey: type.icon_key || 'grid',
      }]
    })
  },
}

/** File Cabinet files, through the Documents page's own read fence. */
const fileLeg: Leg = {
  type: 'file',
  labelKey: 'files',
  validId: isUuid,
  async run(ctx, match) {
    if (!ctx.navigable('/documents')) return []
    const visibility = await fileReadPredicate(ctx.orgId, documentsPageViewer(ctx.authz))
    const predicate = match.kind === 'ids'
      ? sql`fi.id = any(${uuidArray(match.ids)})`
      : sql`fi.name ilike ${match.like}`
    const order = match.kind === 'text' ? sql`similarity(fi.name, ${match.q}) desc, fi.name` : sql`fi.name`
    const r = await db.execute<{ id: string; name: string; folder_name: string | null }>(sql`
      select fi.id, fi.name, fo.name as folder_name
        from files fi
        left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
       where ${visibility}
         and ${predicate}
       order by ${order}
       limit ${PER_GROUP}`)
    return r.rows.map((row): SearchHit => ({
      id: row.id,
      type: 'file',
      title: row.name,
      subtitle: row.folder_name ?? undefined,
      href: `/documents?file=${row.id}`,
      iconKey: 'file',
    }))
  },
}

/** Insight dashboards under the shared insight visibility rule. */
const dashboardLeg: Leg = {
  type: 'dashboard',
  labelKey: 'dashboards',
  validId: isUuid,
  async run(ctx, match) {
    if (!ctx.navigable('/insights/dashboards')) return []
    const predicate = match.kind === 'ids'
      ? sql`d.id = any(${uuidArray(match.ids)})`
      : sql`d.name ilike ${match.like}`
    const r = await db.execute<{ id: string; name: string; description: string | null }>(sql`
      select d.id, d.name, d.description
        from insight_dashboards d
       where ${insightVisibilitySql(ctx.authz, 'd')}
         and ${predicate}
       order by d.name
       limit ${PER_GROUP}`)
    return r.rows.map((row): SearchHit => ({
      id: row.id,
      type: 'dashboard',
      title: row.name,
      subtitle: row.description || undefined,
      href: `/insights/dashboards/${row.id}`,
      iconKey: 'sparkles',
    }))
  },
}

/**
 * Setup records that open in a Setup section drawer: the reader needs Setup
 * access and the entity's Features gate, and rows carry the setup list's
 * own subsidiary fence.
 */
function setupRecordLeg(config: {
  type: SearchRecordType
  labelKey: string
  entityKey: string
  title: string
  subtitle: string
  activeOnly: SQL
  navigablePath: string
  href: (id: string) => string
  iconKey: string
}): Leg {
  return {
    type: config.type,
    labelKey: config.labelKey,
    validId: isUuid,
    async run(ctx, match) {
      const entity = SETUP_ENTITY_BY_KEY.get(config.entityKey)
      if (!entity || !can(ctx.authz, 'admin.setup.manage')) return []
      if (!resolveSetupEntityGate(entity, ctx.features).enabled) return []
      if (!ctx.navigable(config.navigablePath)) return []
      const id = sql.raw(entity.idColumn ?? 'id')
      const title = sql.raw(config.title)
      const subtitle = sql.raw(config.subtitle)
      const predicate = match.kind === 'ids'
        ? sql`${id} = any(${uuidArray(match.ids)})`
        : sql`(${title} ilike ${match.like} or ${subtitle} ilike ${match.like})`
      const r = await db.execute<{ id: string; title: string; subtitle: string | null }>(sql`
        select ${id} as id, ${title} as title, ${subtitle} as subtitle
          from ${sql.raw(entity.table)}
         where org_id = ${ctx.orgId} ${config.activeOnly}
           ${setupEntitySubsidiaryFilter(entity, ctx.authz.allowedSubsidiaryIds)}
           and ${predicate}
         order by ${title}
         limit ${PER_GROUP}`)
      return r.rows.map((row): SearchHit => ({
        id: row.id,
        type: config.type,
        title: row.title,
        subtitle: row.subtitle || undefined,
        href: config.href(row.id),
        iconKey: config.iconKey,
      }))
    },
  }
}

const LEGS: Leg[] = [
  ...LIST_SOURCE_SEARCHES.slice(0, 2).map(listSourceLeg),
  subscriptionLeg,
  ...LIST_SOURCE_SEARCHES.slice(2).map(listSourceLeg),
  customRecordLeg,
  fileLeg,
  dashboardLeg,
  setupRecordLeg({
    type: 'location',
    labelKey: 'locations',
    entityKey: 'locations',
    title: 'name',
    subtitle: 'code',
    activeOnly: sql`and is_active`,
    navigablePath: '/admin/setup/locations',
    href: (id) => `/admin/setup/locations?row=${id}`,
    iconKey: 'pin',
  }),
  // Warehouses live on the Warehouse workspace, whose setup drawer opens for
  // Setup managers; the entity's id column is the warehouse's stock location.
  setupRecordLeg({
    type: 'warehouse',
    labelKey: 'warehouses',
    entityKey: 'warehouses',
    title: 'name',
    subtitle: 'city',
    activeOnly: sql`and status <> 'retired'`,
    navigablePath: '/warehouse',
    href: (id) => `/warehouse?warehouse=${id}`,
    iconKey: 'package',
  }),
]

const LEG_BY_TYPE = new Map(LEGS.map((leg) => [leg.type, leg]))

async function context(authz: Authz): Promise<Context> {
  const features = await resolvedFeatureState(authz.user.orgId)
  return {
    authz,
    orgId: authz.user.orgId,
    features,
    navigable: (href) => visibleNavigationHref(href, (permission) => permission === undefined || can(authz, permission), features),
  }
}

/** Search every operational record group the reader may open. */
export async function searchOperationalRecords(authz: Authz, rawQ: string): Promise<SearchGroup[]> {
  const q = rawQ.trim().slice(0, 80)
  if (q.length < 2) return []
  const match: Match = { kind: 'text', q, like: `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` }
  const ctx = await context(authz)
  const results = await Promise.all(LEGS.map((leg) => leg.run(ctx, match)))
  return LEGS.flatMap((leg, index) => {
    const hits = results[index] ?? []
    return hits.length > 0 ? [{ type: leg.type, labelKey: leg.labelKey, hits }] : []
  })
}

/** Whether a recent reference names an operational record this module resolves. */
export function isOperationalRecentRef(ref: RecentRef): boolean {
  const leg = LEG_BY_TYPE.get(ref.type as SearchRecordType)
  return Boolean(leg && leg.validId(ref.id))
}

/**
 * Re-resolve recently opened operational records under the reader's current
 * permissions, Features switches and subsidiary scope.
 */
export async function resolveRecentOperationalRecords(authz: Authz, refs: readonly RecentRef[]): Promise<SearchHit[]> {
  const idsByType = new Map<SearchRecordType, string[]>()
  for (const ref of refs) {
    if (!isOperationalRecentRef(ref)) continue
    const type = ref.type as SearchRecordType
    idsByType.set(type, [...(idsByType.get(type) ?? []), ref.id])
  }
  if (idsByType.size === 0) return []
  const ctx = await context(authz)
  const results = await Promise.all([...idsByType].map(([type, ids]) => LEG_BY_TYPE.get(type)!.run(ctx, { kind: 'ids', ids })))
  return results.flat()
}
