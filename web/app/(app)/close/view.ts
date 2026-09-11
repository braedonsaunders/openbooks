import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
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
import { guardCloseScope } from '../../../lib/close-scope'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { currentFiscalYear } from '../../../lib/fiscal'
import { clamp, isUuid, pickString } from '../../../lib/list-params'

/**
 * Period close, split into a loader and a spec.
 *
 * The page has two server branches: `?run=<uuid>` renders the CloseWizard, and
 * everything else renders the period list. The wizard is a client component
 * (~1100 lines: six stage bodies, run actions, evidence uploads) whose shell is
 * `WizardLayout`, not `ListPageLayout` — decomposing it into table blocks
 * would reimplement it badly rather than compose it. The brief anticipates
 * this exactly: when the page needs vocabulary that does not exist, stop and
 * report rather than invent it. So this conversion covers the LIST branch
 * only; the run branch stays native and the spec is gated on the same
 * condition the native page uses (`run` absent, non-UUID, or unknown id).
 *
 * That gate needs care: the native page falls through to the list when the
 * run id names no row, so the loader re-runs the lookup and exposes
 * `onList`/`onRun` presence flags — never the run itself, which is a
 * capability-bearing client-component prop set, not data.
 *
 * Query, permission and formatting logic below are verbatim from page.tsx.
 */

const PER_PAGE = 20
const BASE = '/close'

const STATUS_VALUES = [
  'not_started',
  'in_progress',
  'review',
  'approved',
  'closed',
  'published',
] as const

type BadgeVariant = 'success' | 'warning' | 'outline'

export interface ClosePeriodRow {
  id: string
  name: string
  range: string
  statusLabel: string
  statusVariant: BadgeVariant
  readiness: number
  entries: string
  actionHref: string | null
  canStart: boolean
  startPeriodId: string
  startDefaultBookId: string
}

export interface CloseData {
  title: string
  description: string
  manageBooksLabel: string
  canManageBooks: boolean
  searchPlaceholder: string
  currentParams: Record<string, string | string[] | undefined>
  showBookChips: boolean
  showSingleBook: boolean
  bookLabel: string
  bookOptions: { value: string; label: string }[]
  selectedBookId: string
  singleBookName: string
  fyLabel: string
  fyDefault: string
  fyOptions: { value: string; label: string }[]
  statusLabel: string
  statusOptions: { value: string; label: string }[]
  columnPeriod: string
  columnRange: string
  columnStatus: string
  columnReadiness: string
  columnEntries: string
  columnAction: string
  resumeLabel: string
  actionLinkClassName: string
  startBooks: { id: string; name: string }[]
  onList: boolean
  onRun: boolean
  rows: ClosePeriodRow[]
  total: number
  currentPage: number
  perPage: number
}

export async function loadClose(
  sp: Record<string, string | string[] | undefined>,
): Promise<CloseData> {
  const authz = await requirePermission('close.read')
  if (guardCloseScope(authz)) notFound()
  const { orgId } = authz.user
  // The Continuous Close switch is the authoritative parent gate for the whole
  // /close segment: nav hiding alone leaves direct URLs reachable, which is
  // UI-only enforcement.
  await requireFeatureEnabled(orgId, 'continuousClose')
  const t = await getTranslations('close')
  const runId = pickString(sp.run)
  // The native page renders the wizard only for a UUID run id that names a
  // row; anything else falls through to the list.
  const onRun =
    Boolean(runId && isUuid(runId)) &&
    (await db.execute(sql`
      select 1 from close_runs where id = ${runId} and org_id = ${orgId} limit 1
    `)).rows.length > 0
  const onList = !onRun
  const currentFy = await currentFiscalYear()
  const fy = Number(pickString(sp.fy) ?? currentFy)
  const status = pickString(sp.status)
  const q = pickString(sp.q)?.trim()
  const pageNum = clamp(Number(pickString(sp.page) ?? 1), 1, 10_000)
  const offset = (pageNum - 1) * PER_PAGE
  const books = (await db.execute(
    sql`select id, name, code, is_primary from accounting_books where org_id = ${orgId} and is_active order by is_primary desc, name`,
  )) as any
  const requestedBookId = pickString(sp.book)
  const selectedBookId = (books.rows as any[]).some(
    (book) => book.id === requestedBookId,
  )
    ? requestedBookId!
    : ((books.rows as any[]).find((book) => book.is_primary)?.id ??
      books.rows[0]?.id ??
      '')
  const [periods, count, fys] = ((await Promise.all([
    db.execute(sql`
      select p.id, p.name, p.starts_on, p.ends_on, p.fiscal_year, p.period_number,
             r.id as run_id, r.status, r.current_stage, r.readiness_score, r.target_close_date,
             coalesce(a.entries, 0) as entries,
             coalesce(l.closed_modules, 0) as closed_modules
        from accounting_periods p
        left join close_runs r on r.period_id = p.id and r.org_id = p.org_id
          and r.book_id = ${selectedBookId || null}
        left join lateral (select count(*) as entries from journal_entries e where e.period_id = p.id and e.org_id = p.org_id and e.book_id = ${selectedBookId || null}) a on true
        left join lateral (
          select count(*) as closed_modules from period_locks pl
           where pl.period_id = p.id and pl.org_id = p.org_id and pl.subsidiary_id is null and pl.state = 'closed'
             and pl.book_id = ${selectedBookId || null}
        ) l on true
       where p.org_id = ${orgId} and p.fiscal_year = ${fy}
         ${q ? sql`and p.name ilike ${`%${q}%`}` : sql``}
         ${status && status !== 'all' ? sql`and coalesce(r.status, 'not_started') = ${status}` : sql``}
       order by p.period_number
       limit ${PER_PAGE} offset ${offset}`),
    db.execute(sql`
      select count(*) as count from accounting_periods p
      left join close_runs r on r.period_id = p.id and r.org_id = p.org_id
        and r.book_id = ${selectedBookId || null}
      where p.org_id = ${orgId} and p.fiscal_year = ${fy}
        ${q ? sql`and p.name ilike ${`%${q}%`}` : sql``}
        ${status && status !== 'all' ? sql`and coalesce(r.status, 'not_started') = ${status}` : sql``}`),
    db.execute(
      sql`select distinct fiscal_year from accounting_periods where org_id = ${orgId} order by fiscal_year desc`,
    ),
  ])))
  const canStartClose = can(authz, 'close.run')

  return {
    title: t('title'),
    description: t('workspaceDescription'),
    manageBooksLabel: t('actions.manageBooks'),
    canManageBooks: can(authz, 'admin.setup.manage'),
    searchPlaceholder: t('searchPlaceholder'),
    currentParams: sp,
    showBookChips: books.rows.length > 1,
    showSingleBook: books.rows.length <= 1 && Boolean(books.rows[0]),
    bookLabel: t('filters.book'),
    bookOptions: books.rows.map((row: any) => ({
      value: row.id,
      label: row.name,
    })),
    selectedBookId,
    singleBookName: books.rows[0]?.name ?? '',
    fyLabel: t('filters.fiscalYear'),
    fyDefault: String(currentFy),
    fyOptions: fys.rows.map((row) => ({
      value: String(row.fiscal_year),
      label: t('filters.fyOption', { year: String(row.fiscal_year) }),
    })),
    statusLabel: t('filters.status'),
    statusOptions: STATUS_VALUES.map((value) => ({ value, label: t(`runStatus.${value}`) })),
    columnPeriod: t('table.period'),
    columnRange: t('table.range'),
    columnStatus: t('table.status'),
    columnReadiness: t('table.readiness'),
    columnEntries: t('table.entries'),
    columnAction: t('table.action'),
    resumeLabel: t('actions.resume'),
    actionLinkClassName: 'text-sm font-medium text-teal-700 hover:underline dark:text-teal-300',
    startBooks: books.rows.map((row: any) => ({ id: row.id, name: row.name })),
    onList,
    onRun,
    rows: (periods.rows as any[]).map((period) => ({
      id: period.id,
      name: period.name,
      range: `${period.starts_on} → ${period.ends_on}`,
      statusLabel: t(`runStatus.${period.status ?? 'not_started'}`),
      statusVariant: (
        period.status === 'published' || period.status === 'closed'
          ? 'success'
          : period.status
            ? 'warning'
            : 'outline'
      ) as BadgeVariant,
      readiness: period.readiness_score ?? 0,
      entries: Number(period.entries).toLocaleString(),
      actionHref: period.run_id ? `/close?run=${period.run_id}` : null,
      canStart: !period.run_id && canStartClose,
      startPeriodId: period.id,
      startDefaultBookId: selectedBookId,
    })),
    total: Number(count.rows[0]?.count ?? 0),
    currentPage: pageNum,
    perPage: PER_PAGE,
  }
}

const f = ref<CloseData>()
const item = field
const rootF = rootRef<CloseData>()

export function closeSpec(data: CloseData): PageSpec {
  return page({
    route: '/close',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [
          widget(
            'manage-books-button',
            { href: '/admin/setup/accounting-books', label: data.manageBooksLabel },
            f('canManageBooks'),
          ),
        ],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        {
          ...widgetBlock('filter-chips', {
            basePath: BASE,
            currentParams: data.currentParams,
            paramKey: 'book',
            label: data.bookLabel,
            hideAll: true,
            defaultValue: data.selectedBookId,
            options: data.bookOptions,
          }),
          when: f('showBookChips'),
        },
        {
          ...widgetBlock('single-book-label', {
            label: data.bookLabel,
            name: data.singleBookName,
          }),
          when: f('showSingleBook'),
        },
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'fy',
          label: data.fyLabel,
          hideAll: true,
          defaultValue: data.fyDefault,
          options: data.fyOptions,
        }),
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.statusLabel,
          options: data.statusOptions,
        }),
      ]),
    ],
    body: [
      {
        ...grid(
          'overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
          [
            table({
              variant: 'app',
              rows: f('rows'),
              rowKey: item('id'),
              columns: [
                column(rootF('columnPeriod'), text(item('name')), {
                  className: 'font-medium',
                }),
                column(rootF('columnRange'), text(item('range')), {
                  className: 'text-slate-500',
                }),
                column(
                  rootF('columnStatus'),
                  badge(item('statusLabel'), { variant: item('statusVariant') }),
                ),
                column(
                  rootF('columnReadiness'),
                  widgetCell('close-readiness-cell', { readiness: item('readiness') }),
                ),
                column(rootF('columnEntries'), text(item('entries')), {
                  align: 'right',
                  className: 'tabular-nums',
                }),
                column(
                  rootF('columnAction'),
                  widgetCell('close-action-cell', {
                    actionHref: item('actionHref'),
                    actionLabel: rootF('resumeLabel'),
                    actionLinkClassName: rootF('actionLinkClassName'),
                    canStart: item('canStart'),
                    startPeriodId: item('startPeriodId'),
                    startBooks: rootF('startBooks'),
                    startDefaultBookId: item('startDefaultBookId'),
                  }),
                ),
              ],
            }),
            pagination({
              basePath: BASE,
              total: f('total'),
              page: f('currentPage'),
              perPage: f('perPage'),
              bare: true,
            }),
          ],
        ),
        when: f('onList'),
      },
      // The run branch stays native (see page.tsx): CloseWizard owns its own
      // WizardLayout shell, which no PageLayout value can express. This block
      // is a placeholder for the coordinator — `close-wizard-slot` is NOT in
      // the registry on purpose (an unknown widget fails closed at render),
      // so the run branch must be handled in page.tsx until the vocabulary
      // for it exists. The loader exposes the flag so that handling never
      // branches on the query itself.
      {
        ...widgetBlock('close-wizard-slot', {}),
        when: f('onRun'),
      },
    ],
  })
}
