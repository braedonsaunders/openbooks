import 'server-only'

import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getFormatter, getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  grid,
  page,
  pageHeader,
  pagination,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { getAuthz } from '../../../lib/authz'
import { mergeHref, parseListParams, pickString } from '../../../lib/list-params'
import type { NotificationRow } from './NotificationsInbox'

/**
 * The in-app inbox, split into a loader and a spec.
 *
 * This is the surface the header bell used to be. It is deliberately
 * ungated: every query filters on the session user AND their org, so the
 * inbox is yours the same way your own password is — a permission key would
 * only be able to take your own mail away from you.
 *
 * Two routed tabs (unread / everything) rather than client state, so a link
 * to "my unread" is a link, and a `kind` chip filter built from the reader's
 * OWN rows — an inbox that offers a filter for a kind you have never
 * received is a filter that only ever returns nothing.
 */

const BASE = '/notifications'

// Kinds the product writes today (engine/src/flows/gates.ts, close.ts,
// payments.ts). Anything else — a user script, an installed app — renders its
// raw code humanized rather than a missing-message crash.
const KNOWN_KINDS = new Set(['approval', 'flow', 'close', 'void_superseded'])

const humanize = (value: string) =>
  value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

type Scope = 'unread' | 'all'

type NotificationSource = {
  id: string
  kind: string
  title: string
  body: string | null
  href: string | null
  readAt: string | null
  createdAt: string
}

export interface NotificationsData {
  title: string
  description: string
  scopeTabs: { href: string; label: string; active: boolean }[]
  kindLabel: string
  kindOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  unread: number
  rows: NotificationRow[]
  hasRows: boolean
  isEmpty: boolean
  emptyTitle: string
  emptyDescription: string
  total: number
  currentPage: number
  perPage: number
}

export async function loadNotifications(
  sp: Record<string, string | string[] | undefined>,
): Promise<NotificationsData> {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const { id: userId, orgId } = authz.user
  const t = await getTranslations('shell.notifications')
  const format = await getFormatter()

  const params = parseListParams(sp, { sort: 'at', allowedSorts: ['at'] as const, perPage: 25 })
  const scope: Scope = pickString(sp.scope) === 'all' ? 'all' : 'unread'
  const kind = pickString(sp.kind)

  const mine = sql`org_id = ${orgId} and user_id = ${userId}`
  const scoped = scope === 'unread' ? sql`${mine} and read_at is null` : mine
  const filtered = kind ? sql`${scoped} and kind = ${kind}` : scoped
  const offset = (params.page - 1) * params.perPage

  const [rows, counts, kinds] = await Promise.all([
    db.execute<NotificationSource>(sql`
      select id, kind, title, body, href, read_at as "readAt", created_at as "createdAt"
        from notifications
       where ${filtered}
       order by created_at desc
       limit ${params.perPage} offset ${offset}`),
    db.execute<{ total: number; unread: number; scoped: number }>(sql`
      select count(*)::int as total,
             count(*) filter (where read_at is null)::int as unread,
             count(*) filter (where ${filtered})::int as scoped
        from notifications
       where ${mine}`),
    // Chip counts follow the scope (unread vs everything) but NOT the chosen
    // kind, so switching between chips never hides the chip you came from.
    db.execute<{ kind: string; n: number }>(sql`
      select kind, count(*)::int as n
        from notifications
       where ${scoped}
       group by kind
       order by count(*) desc, kind asc`),
  ])

  const unread = counts.rows[0]?.unread ?? 0
  const kindText = (code: string) =>
    KNOWN_KINDS.has(code) ? t(`kinds.${code}` as never) : humanize(code)

  return {
    title: t('title'),
    description: t('description'),
    scopeTabs: (['unread', 'all'] as const).map((value) => ({
      href: mergeHref(BASE, sp, { scope: value, page: 1 }),
      label: value === 'unread' ? t('tabs.unread', { count: unread }) : t('tabs.all'),
      active: scope === value,
    })),
    kindLabel: t('kindLabel'),
    kindOptions: kinds.rows.map((row) => ({
      value: row.kind,
      label: kindText(row.kind),
      count: row.n,
    })),
    currentParams: sp,
    unread,
    rows: rows.rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      href: row.href,
      kindLabel: kindText(row.kind),
      when: format.dateTime(new Date(row.createdAt), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
      read: row.readAt !== null,
    })),
    hasRows: rows.rows.length > 0,
    isEmpty: rows.rows.length === 0,
    emptyTitle: scope === 'unread' ? t('emptyUnreadTitle') : t('emptyTitle'),
    emptyDescription: scope === 'unread' ? t('emptyUnreadDescription') : t('emptyDescription'),
    total: counts.rows[0]?.scoped ?? 0,
    currentPage: params.page,
    perPage: params.perPage,
  }
}

const f = ref<NotificationsData>()

export function notificationsSpec(data: NotificationsData): PageSpec {
  return page({
    // A literal, not BASE: the page registry reads this route from source.
    route: '/notifications',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('notifications-mark-all-read', { unread: data.unread })],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('module-home-tabs', { tabs: data.scopeTabs }),
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'kind',
          label: data.kindLabel,
          options: data.kindOptions,
        }),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          icon: 'bell',
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f('isEmpty'),
      },
      {
        // The list owns marking-read and row navigation, which a server
        // component cannot — see ./NotificationsInbox.
        ...widgetBlock('notifications-inbox', { rows: data.rows }),
        when: f('hasRows'),
      },
      {
        ...pagination({
          basePath: BASE,
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
        }),
        when: f('hasRows'),
      },
    ],
  })
}
