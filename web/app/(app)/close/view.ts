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
import { featureEnabled, resolvedFeatureState, subsidiaryFeatureEnabled } from '../../../lib/features'
import type { CloseWizard } from './CloseWizard'

/**
 * Period close, split into a loader and a spec.
 *
 * The page has two server branches: `?run=<uuid>` renders the CloseWizard,
 * and everything else renders the period list. They are two DOCUMENTS, not
 * one document with a `when` on it — `when` omits a block, it cannot change
 * the page's shell, and these two need different ones. The wizard is a client
 * component (~1100 lines: six stage bodies, run actions, evidence uploads)
 * that owns a full-height `WizardLayout`, so its spec is `layout: 'bare'` and
 * places the wizard whole. Decomposing it into blocks would reimplement it
 * rather than compose it.
 *
 * An earlier conversion left this branch on the native path and a later one
 * deleted that path, so the page answered `null` for every run and "Resume"
 * led to a blank screen. The lesson is in the shape of the fix: the loader
 * now LOADS the wizard rather than probing whether a run exists, so the page
 * cannot know it is on the run branch and have nothing to render it with.
 *
 * The wizard's props are plain data — rows and resolved booleans, no bound
 * action and no `Authz` — which is what lets them travel through a spec at
 * all. Its own writes go through API routes that authorize themselves.
 *
 * An id that names no run falls through to the LIST, as the native page did:
 * a stale bookmark should show the periods rather than an error.
 *
 * Query, permission and formatting logic below are verbatim from page.tsx.
 */

const PER_PAGE = 20
const BASE = '/close'

/**
 * The wizard's props, resolved by the loader.
 *
 * Every field is DATA — rows and booleans — which is why it can travel
 * through a spec at all. There is no server action here, no `Authz`, no
 * callback: the wizard's own writes go through API routes that authorize
 * themselves, and the four `can*` flags are the same resolved-permission
 * booleans every other page binds.
 */
export type CloseWizardData = Omit<Parameters<typeof CloseWizard>[0], never>

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
  /** Everything the run wizard renders. Null on the list branch. */
  wizard: CloseWizardData | null
  rows: ClosePeriodRow[]
  total: number
  currentPage: number
  perPage: number
}

/**
 * Everything the run wizard needs, or null when the id names no run.
 *
 * Queries lifted verbatim from the page this replaced. Returning null for an
 * unknown id is what makes the list the fallback: a stale bookmark shows the
 * period list rather than an error, which is the behaviour the native page
 * had and the one a reader can act on.
 */
async function loadCloseWizard(
  runId: string,
  stage: string | undefined,
  authz: Awaited<ReturnType<typeof requirePermission>>,
): Promise<CloseWizardData | null> {
  const { orgId } = authz.user
  const [runRes, tasksRes, exceptionsRes, evidenceRes, signoffsRes, eventsRes, locksRes, historyRes] =
    await Promise.all([
      db.execute(sql`
        select r.*, p.name as period_name, p.starts_on, p.ends_on, p.fiscal_year,
               b.name as book_name, b.code as book_code,
               bp.name as blueprint_name, bp.version as blueprint_version,
               pkg.name as package_name, pkg.reports as package_reports,
               starter.name as starter_name, approver.name as approver_name,
               closer.name as closer_name, publisher.name as publisher_name
          from close_runs r
          join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
          join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
          join close_blueprints bp on bp.id = r.blueprint_id and bp.org_id = r.org_id
          left join close_reporting_packages pkg on pkg.id = r.reporting_package_id and pkg.org_id = r.org_id
          left join users starter on starter.id = r.started_by
          left join users approver on approver.id = r.approved_by
          left join users closer on closer.id = r.closed_by
          left join users publisher on publisher.id = r.published_by
         where r.id = ${runId} and r.org_id = ${orgId}`),
      db.execute(sql`
        select t.*, owner.name as owner_name, reviewer.name as reviewer_name,
               coalesce(jsonb_agg(distinct dep.key) filter (where dep.id is not null), '[]'::jsonb) as dependencies,
               count(distinct ev.id) as evidence_count
          from close_run_tasks t
          left join users owner on owner.id = t.owner_id
          left join users reviewer on reviewer.id = t.reviewer_id
          left join close_blueprint_dependencies d on d.step_id = t.blueprint_step_id and d.org_id = t.org_id
          left join close_run_tasks dep on dep.run_id = t.run_id and dep.blueprint_step_id = d.depends_on_step_id and dep.org_id = t.org_id
          left join close_task_evidence ev on ev.task_id = t.id and ev.org_id = t.org_id
         where t.run_id = ${runId} and t.org_id = ${orgId}
         group by t.id, owner.name, reviewer.name order by t.sort_order`),
      db.execute(
        sql`select * from close_exceptions where run_id = ${runId} and org_id = ${orgId} order by status, case severity when 'critical' then 1 when 'error' then 2 when 'warning' then 3 else 4 end, created_at`,
      ),
      db.execute(
        sql`select * from close_task_evidence where run_id = ${runId} and org_id = ${orgId} order by created_at desc`,
      ),
      db.execute(
        sql`select s.*, u.name as signed_by_name from close_signoffs s join users u on u.id = s.signed_by where s.run_id = ${runId} and s.org_id = ${orgId} order by s.signed_at desc`,
      ),
      db.execute(
        sql`select e.*, u.name as actor_name from close_events e left join users u on u.id = e.actor_id where e.run_id = ${runId} and e.org_id = ${orgId} order by e.at desc limit 100`,
      ),
      db.execute(
        sql`select * from period_locks where org_id = ${orgId} and period_id = (select period_id from close_runs where id = ${runId} and org_id = ${orgId}) and book_id = (select book_id from close_runs where id = ${runId} and org_id = ${orgId}) order by subsidiary_id nulls first, module`,
      ),
      db.execute(sql`
        select t.key,
               avg(extract(epoch from (t.completed_at - r.started_at)) / 86400.0)::numeric(10,1) as average_days
          from close_run_tasks t join close_runs r on r.id = t.run_id and r.org_id = t.org_id
         where t.org_id = ${orgId} and t.completed_at is not null and r.id <> ${runId}
         group by t.key`),
    ])

  const run = runRes.rows[0]
  if (!run) return null

  const history = new Map(
    (historyRes.rows as { key: string; average_days: string }[]).map((row) => [
      row.key,
      Number(row.average_days),
    ]),
  )
  const [subsidiaryEnabled, featureState] = await Promise.all([
    subsidiaryFeatureEnabled(orgId),
    resolvedFeatureState(orgId),
  ])
  return {
    // The requested stage, so `?stage=publish` deep links land where they
    // say. The wizard falls back to the run's current stage when it is
    // absent, which is why dropping it looked harmless and was not.
    stage,
    run: run as CloseWizardData['run'],
    tasks: (tasksRes.rows as { key: string }[]).map((task) => ({
      ...task,
      predicted_days: history.get(task.key) ?? null,
    })) as CloseWizardData['tasks'],
    exceptions: exceptionsRes.rows as CloseWizardData['exceptions'],
    evidence: evidenceRes.rows as CloseWizardData['evidence'],
    signoffs: signoffsRes.rows as CloseWizardData['signoffs'],
    events: eventsRes.rows as CloseWizardData['events'],
    locks: locksRes.rows as CloseWizardData['locks'],
    canRun: can(authz, 'close.run'),
    canApprove: can(authz, 'close.approve'),
    canReopen: can(authz, 'close.reopen'),
    canManageFlows: can(authz, 'flows.manage'),
    subsidiaryEnabled,
    multiCurrency: featureEnabled(featureState, 'multiCurrency'),
    advancedClose: featureEnabled(featureState, 'advancedClose'),
  }
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
  // The wizard's data is loaded HERE rather than probed for existence and
  // then loaded elsewhere: `onRun` used to be a bare "does this row exist"
  // check, which meant the page knew it was on the run branch and still had
  // nothing to render it with.
  const wizard =
    runId && isUuid(runId) ? await loadCloseWizard(runId, pickString(sp.stage), authz) : null
  const onRun = wizard !== null
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
    wizard,
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
  // The run branch is its own document, not a `when` inside the list's.
  //
  // `when` omits a block; it cannot change the page's SHELL, and these two
  // branches need different ones: the list is a `list` layout, and the wizard
  // owns its own full-height `WizardLayout`, so wrapping it in a second page
  // shell would nest the chrome. `bare` is precisely the value for a page
  // that brings its own outer element — it exists for the setup workspace,
  // which has the same property.
  //
  // Choosing between two documents here is ordinary TypeScript over loader
  // data, not a conditional inside a spec. The spec this returns still only
  // names blocks and binds resolved fields.
  if (data.wizard) {
    return page({
      route: '/close',
      layout: 'bare',
      header: [],
      body: [widgetBlock('close-wizard', { wizard: data.wizard })],
    })
  }
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
    ],
  })
}
