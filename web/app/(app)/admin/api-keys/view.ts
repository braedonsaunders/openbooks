import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import {
  badge,
  column,
  field,
  grid,
  link,
  page,
  pageHeader,
  pagination,
  ref,
  rootRef,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { buildListDrawerHref, isUuid, parseListParams } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { dateTime } from '../../../../lib/format'

/**
 * API keys, split into a loader and a spec.
 *
 * An admin list page: search bar, app-variant table, pagination and a record
 * drawer. Its empty treatment is a spanning row INSIDE the table rather than
 * the table disappearing, which is why `table.emptyRow` exists — several admin
 * lists prefer keeping the headers visible.
 *
 * `key_hash` is never selected, here or in the drawer lookup. The original
 * page was careful about that and the split keeps it: the loader owns the
 * query, so the column list stays in one reviewable place.
 */

export interface ApiKeyRow {
  id: string
  name: string
  href: string
  keyDisplay: string
  ownerName: string
  ownerEmail: string
  scopes: string
  lastUsed: string
  statusLabel: string
  statusVariant: 'success' | 'outline'
}

export interface ApiKeysData {
  title: string
  description: string
  backHref: string
  backLabel: string
  searchPlaceholder: string
  emptyLabel: string
  columnName: string
  columnKey: string
  columnOwner: string
  columnScopes: string
  columnLastUsed: string
  columnStatus: string
  rows: ApiKeyRow[]
  total: number
  currentPage: number
  perPage: number
  /** Present only while a drawer id is in the query. */
  drawerOpen: boolean
  drawerRow: Record<string, unknown> | null
}

export async function loadApiKeys(
  sp: Record<string, string | string[] | undefined>,
): Promise<ApiKeysData> {
  const authz = await requirePermission('api.keys.manage')
  await requireFeatureEnabled(authz.user.orgId, 'apiAccess')
  const t = await getTranslations('admin.apiKeys')
  const tHub = await getTranslations('admin.hub')
  const params = parseListParams(sp, {
    sort: 'created',
    allowedSorts: ['created', 'name'] as const,
    perPage: 50,
  })
  const keyId = sp.key as string | undefined

  const where = sql`k.org_id = ${authz.user.orgId}
    ${params.q ? sql` and (k.name ilike ${'%' + params.q + '%'} or u.name ilike ${'%' + params.q + '%'} or u.email ilike ${'%' + params.q + '%'})` : sql``}`

  const [keys, totalRow] = await Promise.all([
    db.execute(sql`
      select k.id, k.name, k.description, k.key_prefix, k.key_preview, k.scopes,
             k.rate_limit_per_min, k.is_active, k.expires_at, k.last_used_at, k.created_at,
             u.name as owner_name, u.email as owner_email
        from api_keys k
        join users u on u.id = k.user_id
       where ${where}
       order by k.created_at desc
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}`),
    db.execute<{ n: string }>(sql`
      select count(*) as n from api_keys k
        join users u on u.id = k.user_id
       where ${where}`),
  ])

  // Org-scoped, UUID-validated lookup with an explicit column list — key_hash
  // never leaves the server (a non-UUID id is simply treated as not found).
  const open =
    keyId && keyId !== 'new' && isUuid(keyId)
      ? await db.execute(sql`
          select k.id, k.name, k.description, k.key_prefix, k.key_preview, k.scopes,
                 k.rate_limit_per_min, k.is_active, k.expires_at, k.last_used_at, k.created_at,
                 u.name as owner_name, u.email as owner_email
            from api_keys k
            join users u on u.id = k.user_id
           where k.id = ${keyId} and k.org_id = ${authz.user.orgId}`)
      : null

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    searchPlaceholder: t('searchPlaceholder'),
    emptyLabel: t('empty'),
    columnName: t('table.name'),
    columnKey: t('table.key'),
    columnOwner: t('table.owner'),
    columnScopes: t('table.scopes'),
    columnLastUsed: t('table.lastUsed'),
    columnStatus: t('table.status'),
    rows: keys.rows.map((k) => {
      const scopes = k.scopes
      return {
        id: String(k.id),
        name: String(k.name),
        href: buildListDrawerHref('/admin/api-keys', sp, 'key', String(k.id)),
        keyDisplay: `${k.key_prefix}…${k.key_preview}`,
        // The trailing space and the leading bullet are significant: the
        // native cell is `{owner_name} <span>· {owner_email}</span>`, and JSX
        // renders that literal space as part of the preceding text node.
        ownerName: `${k.owner_name ?? ''} `,
        ownerEmail: `· ${k.owner_email}`,
        scopes:
          Array.isArray(scopes) && scopes.length > 0
            ? t('table.scopesCount', { count: scopes.length })
            : t('table.fullScope'),
        lastUsed: k.last_used_at ? dateTime(String(k.last_used_at)) : '—',
        statusLabel: k.is_active ? t('statusActive') : t('statusRevoked'),
        statusVariant: k.is_active ? 'success' : 'outline',
      }
    }),
    total: Number(totalRow.rows[0]?.n ?? 0),
    currentPage: params.page,
    perPage: params.perPage,
    drawerOpen: Boolean(keyId),
    drawerRow: (open?.rows[0] as Record<string, unknown> | undefined) ?? null,
  }
}

const f = ref<ApiKeysData>()
const item = field
const rootF = rootRef<ApiKeysData>()

const MUTED = 'text-slate-500 dark:text-slate-400'

export function apiKeysSpec(data: ApiKeysData): PageSpec {
  return page({
    route: '/admin/api-keys',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
        actions: [widget('new-api-key')],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
      ]),
    ],
    body: [
      table({
        variant: 'app',
        rows: f('rows'),
        rowKey: item('id'),
        emptyRow: { text: f('emptyLabel'), colSpan: 6, className: MUTED },
        columns: [
          column(
            rootF('columnName'),
            link(item('name'), item('href'), 'font-medium text-teal-700 hover:underline dark:text-teal-300'),
          ),
          column(rootF('columnKey'), widgetCell('code-cell', { text: item('keyDisplay') })),
          column(
            rootF('columnOwner'),
            text(item('ownerName'), { suffix: { field: item('ownerEmail'), className: 'text-slate-400' } }),
            { className: MUTED },
          ),
          column(rootF('columnScopes'), text(item('scopes')), { className: MUTED }),
          column(rootF('columnLastUsed'), text(item('lastUsed')), { className: MUTED }),
          column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
        ],
      }),
      pagination({
        basePath: '/admin/api-keys',
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
      }),
      widgetBlock('api-key-drawer', { keyRow: data.drawerRow }, f('drawerOpen')),
    ],
  })
}
