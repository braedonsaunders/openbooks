import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { businessTimeZone } from '@openbooks/engine/src/business-date.ts'
import {
  badge,
  column,
  field,
  grid,
  heading,
  link,
  money,
  number,
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
import { requirePermission, can } from '../../../../lib/authz'
import { isUuid, parsePrefixedListParams, pickString } from '../../../../lib/list-params'
import type { StatementDrawer as StatementDrawerComponent } from './StatementDrawer'

/**
 * A reconcilable bank/card account, split into a loader and a spec.
 *
 * Two independent prefixed lists — statements (`stmt*`) and reconciliations
 * (`recon*`) — each with its own search, filter, sort and pager, plus a
 * statement-lines drawer (`sl*`, `?statement=<id>`) that stays a widget. The
 * prefixed `sortParamKey`/`dirParamKey`/`pageParamKey` on the table sorting
 * configs exist for exactly this page: without them both tables would bind
 * their headers to `sort`/`dir`/`page` and sorting one would reorder the
 * other.
 *
 * The four header stat tiles are one `account-stats` widget rather than
 * `stat-tile` blocks: the native tiles are plain bordered divs with
 * conditional content (a "never" placeholder, a warning/secondary badge pair),
 * and `stat-tile` renders the cockpit `HomeStatTile` — different markup. The
 * unmatched-count and reconcile-workspace cells are likewise conditional
 * pairs, so they live as small components in ./sections shared with the
 * native render path.
 */

const RECON_VARIANT: Record<string, 'success' | 'secondary' | 'warning'> = {
  signed_off: 'success',
  balanced: 'warning',
  in_progress: 'secondary',
}

// Enum values with translated labels — unknown values render as the raw code
// with underscores spaced out.
const TYPE_KEYS = ['asset_bank', 'liability_card']
const RECON_STATUS_KEYS = ['signed_off', 'balanced', 'in_progress']

const STMT_SORTS = {
  date: sql`s.statement_date`,
  source: sql`s.source`,
  lines: sql`coalesce(lc.n, 0)`,
  imported: sql`s.imported_at`,
} as const

const RECON_SORTS = {
  through: sql`r.through_date`,
  balance: sql`r.statement_balance`,
  status: sql`r.status`,
  created: sql`r.created_at`,
} as const

interface AccountRow extends Record<string, unknown> {
  id: string
  number: string | null
  name: string
  type: string
  currency_restriction: string | null
  balance: string
  reconciled_through: string | null
  unmatched_lines: string | number
  open_reconciliation_id: string | null
}
interface StatementRow extends Record<string, unknown> {
  id: string
  source: string
  statement_date: string
  opening_balance: string | null
  closing_balance: string | null
  imported_at: string
  line_count: string | number
  unmatched_count: string | number
}
interface ReconciliationRow extends Record<string, unknown> {
  id: string
  through_date: string
  statement_balance: string
  status: string
  signed_off_at: string | null
  created_at: string
}
interface CountRow extends Record<string, unknown> { n: string | number }
interface SourceCountRow extends CountRow { source: string }
interface StatusCountRow extends CountRow { status: string }
type DrawerProps = Parameters<typeof StatementDrawerComponent>[0]
type StatementDetailRow = DrawerProps['statement'] & Record<string, unknown>
type StatementLineRow = DrawerProps['lines'][number] & Record<string, unknown>

export interface StatementListRow {
  id: string
  dateHref: string
  dateLabel: string
  sourceLabel: string
  lineCount: string
  unmatchedCount: string
  unmatchedIsZero: boolean
  openingBalance: string
  closingBalance: string
  importedAt: string
}

export interface ReconciliationListRow {
  id: string
  throughDate: string
  statementBalance: string
  statusLabel: string
  statusVariant: 'success' | 'secondary' | 'warning'
  createdAt: string
  signedOffAt: string
  actionHref: string
  actionLabel: string
}

export interface DrawerLineParams {
  page: number
  perPage: number
  sort: string
  dir: 'asc' | 'desc'
}

export interface BankingAccountData {
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  headerTitle: string
  headerDescription: string
  backHref: string
  backLabel: string
  canReconcile: boolean
  accountId: string
  openReconciliationId: string | null
  glBalance: string
  glBalanceDisplay: string
  glBalanceLabel: string
  reconciledThroughLabel: string
  reconciledThrough: string | null
  unmatchedLinesLabel: string
  reconciliationLabel: string
  neverLabel: string
  unmatchedLinesDisplay: string
  reconBadgeLabel: string
  reconBadgeVariant: 'warning' | 'secondary'
  statementsTitle: string
  statementsSearchPlaceholder: string
  sourceLabel: string
  sourceOptions: { value: string; label: string; count: number }[]
  statementsEmptyTitle: string
  statementsEmptyDescription: string
  stmtIsEmpty: boolean
  stmtShowTable: boolean
  columnStatementDate: string
  columnSource: string
  columnLines: string
  columnUnmatched: string
  columnOpening: string
  columnClosing: string
  columnImported: string
  statementRows: StatementListRow[]
  stmtTotal: number
  stmtPage: number
  stmtPerPage: number
  stmtSort: string
  stmtDir: string
  reconciliationsTitle: string
  reconciliationsSearchPlaceholder: string
  reconStatusLabel: string
  reconStatusOptions: { value: string; label: string; count: number }[]
  reconIsEmpty: boolean
  reconShowTable: boolean
  reconciliationsEmptyTitle: string
  reconciliationsEmptyDescription: string
  columnThroughDate: string
  columnStatementBalance: string
  columnStatus: string
  columnStarted: string
  columnSignedOff: string
  reconRows: ReconciliationListRow[]
  reconTotal: number
  reconPage: number
  reconPerPage: number
  reconSort: string
  reconDir: string
  drawerOpen: boolean
  drawer: {
    basePath: string
    currentParams: Record<string, string | string[] | undefined>
    statement: DrawerProps['statement']
    lines: DrawerProps['lines']
    lineTotal: number
    page: number
    perPage: number
    sort: string
    dir: 'asc' | 'desc'
  } | null
}

export async function loadBankingAccount(
  accountId: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<BankingAccountData> {
  const { money } = await getMoneyFormatter()
  const authz = await requirePermission('banking.read')
  const canReconcile = can(authz, 'banking.reconcile')
  const t = await getTranslations('banking')
  const tCommon = await getTranslations('common')
  const locale = await getLocale()
  const reconStatusLabel = (status: string) =>
    RECON_STATUS_KEYS.includes(status) ? t(`reconStatus.${status}`) : String(status).replace(/_/g, ' ')
  if (!isUuid(accountId)) notFound()
  const orgId = authz.user.orgId
  const basePath = `/banking/${accountId}`
  const timeZone = await businessTimeZone(orgId)
  const timestampFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone })
  const formatTimestamp = (value: string) => timestampFormatter.format(new Date(value))

  const accountRes = (await db.execute<AccountRow>(sql`
    select a.id, a.number, a.name, a.type, a.currency_restriction,
           coalesce((select sum(jl.amount) from journal_lines jl
                      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
                     where jl.account_id = a.id and jl.org_id = a.org_id), 0) as balance,
           (select max(r.through_date) from reconciliations r
             where r.account_id = a.id and r.org_id = a.org_id and r.status = 'signed_off') as reconciled_through,
           (select count(*) from bank_statement_lines l
             join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
            where s.account_id = a.id and l.org_id = a.org_id and l.match_status = 'unmatched') as unmatched_lines,
           (select r.id from reconciliations r
             where r.account_id = a.id and r.org_id = a.org_id and r.status <> 'signed_off'
             order by r.created_at desc limit 1) as open_reconciliation_id
      from accounts a
     where a.id = ${accountId} and a.org_id = ${orgId} and a.reconcilable
  `))
  const account = accountRes.rows[0]
  if (!account) notFound()

  // -- statements list (prefixed: stmt*) ------------------------------------
  const stmtParams = parsePrefixedListParams(sp, 'stmt', {
    sort: 'date',
    dir: 'desc',
    perPage: 10,
    allowedSorts: ['date', 'source', 'lines', 'imported'] as const,
  })
  const source = pickString(sp.source)
  const stmtWhere = sql`s.account_id = ${accountId} and s.org_id = ${orgId}
    ${source ? sql` and s.source = ${source}` : sql``}
    ${stmtParams.q ? sql` and (s.statement_date::text ilike ${'%' + stmtParams.q + '%'} or s.source ilike ${'%' + stmtParams.q + '%'})` : sql``}`

  // -- reconciliations list (prefixed: recon*) -------------------------------
  const reconParams = parsePrefixedListParams(sp, 'recon', {
    sort: 'created',
    dir: 'desc',
    perPage: 10,
    allowedSorts: ['through', 'balance', 'status', 'created'] as const,
  })
  const reconStatus = pickString(sp.reconStatus)
  const reconWhere = sql`r.account_id = ${accountId} and r.org_id = ${orgId}
    ${reconStatus ? sql` and r.status = ${reconStatus}` : sql``}
    ${reconParams.q ? sql` and (r.through_date::text ilike ${'%' + reconParams.q + '%'} or r.statement_balance::text ilike ${'%' + reconParams.q + '%'})` : sql``}`

  const openStatementId = pickString(sp.statement)

  const [statements, stmtCount, sourceCounts, recons, reconCount, reconStatusCounts] = (await Promise.all([
    db.execute<StatementRow>(sql`
      select s.id, s.source, s.statement_date, s.opening_balance, s.closing_balance, s.imported_at,
             coalesce(lc.n, 0) as line_count, coalesce(lc.unmatched, 0) as unmatched_count
        from bank_statements s
        left join lateral (
          select count(*) as n, count(*) filter (where l.match_status = 'unmatched') as unmatched
            from bank_statement_lines l where l.statement_id = s.id and l.org_id = s.org_id) lc on true
       where ${stmtWhere}
       order by ${STMT_SORTS[stmtParams.sort]} ${stmtParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${stmtParams.perPage} offset ${(stmtParams.page - 1) * stmtParams.perPage}
    `),
    db.execute<CountRow>(sql`select count(*) as n from bank_statements s where ${stmtWhere}`),
    db.execute<SourceCountRow>(sql`select s.source, count(*) as n from bank_statements s where s.account_id = ${accountId} and s.org_id = ${orgId} group by s.source order by s.source`),
    db.execute<ReconciliationRow>(sql`
      select r.id, r.through_date, r.statement_balance, r.status, r.signed_off_at, r.created_at
        from reconciliations r
       where ${reconWhere}
       order by ${RECON_SORTS[reconParams.sort]} ${reconParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${reconParams.perPage} offset ${(reconParams.page - 1) * reconParams.perPage}
    `),
    db.execute<CountRow>(sql`select count(*) as n from reconciliations r where ${reconWhere}`),
    db.execute<StatusCountRow>(sql`select r.status, count(*) as n from reconciliations r where r.account_id = ${accountId} and r.org_id = ${orgId} group by r.status`),
  ]))

  // -- statement drawer (?statement=<id>) ------------------------------------
  let drawer: BankingAccountData['drawer'] = null
  if (openStatementId && isUuid(openStatementId)) {
    const s = (await db.execute<StatementDetailRow>(sql`
      select s.id, s.source, s.statement_date, s.opening_balance, s.closing_balance, s.imported_at
        from bank_statements s where s.id = ${openStatementId} and s.account_id = ${accountId} and s.org_id = ${orgId}
    `))
    if (s.rows[0]) {
      const lineParams = parsePrefixedListParams(sp, 'sl', {
        sort: 'line',
        dir: 'asc',
        perPage: 25,
        allowedSorts: ['line', 'date', 'amount'] as const,
      })
      const lineSorts = { line: sql`l.line_number`, date: sql`l.posted_on`, amount: sql`l.amount` } as const
      const lineWhere = sql`l.statement_id = ${openStatementId} and l.org_id = ${orgId}
        ${lineParams.q ? sql` and (l.description ilike ${'%' + lineParams.q + '%'} or l.counterparty_ref ilike ${'%' + lineParams.q + '%'})` : sql``}`
      const [lines, lineCount] = (await Promise.all([
        db.execute<StatementLineRow>(sql`
          select l.id, l.line_number, l.posted_on, l.amount, l.description, l.counterparty_ref, l.match_status
            from bank_statement_lines l
           where ${lineWhere}
           order by ${lineSorts[lineParams.sort]} ${lineParams.dir === 'asc' ? sql`asc` : sql`desc`}
           limit ${lineParams.perPage} offset ${(lineParams.page - 1) * lineParams.perPage}
        `),
        db.execute<CountRow>(sql`select count(*) as n from bank_statement_lines l where ${lineWhere}`),
      ]))
      drawer = {
        basePath,
        currentParams: sp,
        statement: s.rows[0],
        lines: lines.rows,
        lineTotal: Number(lineCount.rows[0]?.n ?? 0),
        page: lineParams.page,
        perPage: lineParams.perPage,
        sort: lineParams.sort,
        dir: lineParams.dir,
      }
    }
  }

  const sourceOptions = sourceCounts.rows.map((r) => ({ value: r.source, label: r.source, count: Number(r.n) }))
  const reconStatusOptions = reconStatusCounts.rows.map((r) => ({
    value: r.status,
    label: reconStatusLabel(r.status),
    count: Number(r.n),
  }))

  const typeLabel = TYPE_KEYS.includes(account.type)
    ? t(`types.${account.type}`)
    : String(account.type).replace(/_/g, ' ')
  const accountDetails = account.currency_restriction
    ? `${typeLabel} · ${account.currency_restriction}`
    : typeLabel

  // The native page shows the empty state only when the list is truly empty —
  // a filter that matches nothing renders the table with zero body rows.
  const stmtTotal = Number(stmtCount.rows[0]?.n ?? 0)
  const stmtIsEmpty = stmtTotal === 0 && !stmtParams.q && !source
  const reconTotal = Number(reconCount.rows[0]?.n ?? 0)
  const reconIsEmpty = reconTotal === 0 && !reconParams.q && !reconStatus

  return {
    basePath,
    currentParams: sp,
    headerTitle: [account.number, account.name].filter(Boolean).join(' · '),
    headerDescription: t('account.description', { details: accountDetails }),
    backHref: '/banking',
    backLabel: t('home.title'),
    canReconcile,
    accountId: account.id,
    openReconciliationId: account.open_reconciliation_id,
    glBalance: String(account.balance),
    glBalanceDisplay: money(account.balance),
    glBalanceLabel: t('account.stats.glBalance'),
    reconciledThroughLabel: t('account.stats.reconciledThrough'),
    reconciledThrough: account.reconciled_through,
    unmatchedLinesLabel: t('account.stats.unmatchedLines'),
    reconciliationLabel: t('account.stats.reconciliation'),
    neverLabel: t('labels.never'),
    unmatchedLinesDisplay: Number(account.unmatched_lines).toLocaleString(),
    reconBadgeLabel: account.open_reconciliation_id ? t('account.badges.inProgress') : t('account.badges.noneOpen'),
    reconBadgeVariant: account.open_reconciliation_id ? 'warning' : 'secondary',
    statementsTitle: t('account.statementsTitle'),
    statementsSearchPlaceholder: t('account.searchStatements'),
    sourceLabel: t('labels.source'),
    sourceOptions,
    statementsEmptyTitle: t('account.statementsEmptyTitle'),
    statementsEmptyDescription: t('account.statementsEmptyDescription'),
    stmtIsEmpty,
    stmtShowTable: !stmtIsEmpty,
    columnStatementDate: t('labels.statementDate'),
    columnSource: t('labels.source'),
    columnLines: tCommon('labels.lines'),
    columnUnmatched: t('account.columns.unmatched'),
    columnOpening: t('account.columns.opening'),
    columnClosing: t('account.columns.closing'),
    columnImported: t('account.columns.imported'),
    statementRows: statements.rows.map((s) => ({
      id: s.id,
      dateHref: `${basePath}?statement=${s.id}`,
      dateLabel: s.statement_date,
      sourceLabel: s.source,
      lineCount: Number(s.line_count).toLocaleString(),
      unmatchedCount: Number(s.unmatched_count).toLocaleString(),
      unmatchedIsZero: Number(s.unmatched_count) === 0,
      openingBalance: money(s.opening_balance),
      closingBalance: money(s.closing_balance),
      importedAt: formatTimestamp(s.imported_at),
    })),
    stmtTotal,
    stmtPage: stmtParams.page,
    stmtPerPage: stmtParams.perPage,
    stmtSort: stmtParams.sort,
    stmtDir: stmtParams.dir,
    reconciliationsTitle: t('account.reconciliationsTitle'),
    reconciliationsSearchPlaceholder: t('account.searchReconciliations'),
    reconStatusLabel: tCommon('labels.status'),
    reconStatusOptions,
    reconIsEmpty,
    reconShowTable: !reconIsEmpty,
    reconciliationsEmptyTitle: t('account.reconciliationsEmptyTitle'),
    reconciliationsEmptyDescription: t('account.reconciliationsEmptyDescription'),
    columnThroughDate: t('account.columns.throughDate'),
    columnStatementBalance: t('labels.statementBalance'),
    columnStatus: tCommon('labels.status'),
    columnStarted: t('account.columns.started'),
    columnSignedOff: t('account.columns.signedOff'),
    reconRows: recons.rows.map((r) => ({
      id: r.id,
      throughDate: r.through_date,
      statementBalance: money(r.statement_balance),
      statusLabel: reconStatusLabel(r.status),
      statusVariant: RECON_VARIANT[r.status] ?? 'secondary',
      createdAt: formatTimestamp(r.created_at),
      // The native cell renders a bare em-dash, not a styled placeholder.
      signedOffAt: r.signed_off_at ? formatTimestamp(r.signed_off_at) : '—',
      actionHref: `${basePath}/reconcile/${r.id}`,
      actionLabel: r.status === 'signed_off' ? tCommon('actions.view') : t('account.openWorkspace'),
    })),
    reconTotal,
    reconPage: reconParams.page,
    reconPerPage: reconParams.perPage,
    reconSort: reconParams.sort,
    reconDir: reconParams.dir,
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<BankingAccountData>()
const item = field
const rootF = rootRef<BankingAccountData>()

const MUTED = 'text-slate-500 dark:text-slate-400'

export function bankingAccountSpec(data: BankingAccountData): PageSpec {
  return page({
    route: '/banking/[accountId]',
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('headerTitle'),
        description: f('headerDescription'),
        actionsClassName: 'flex items-center gap-2',
        actions: [
          widget('import-statement', { accountId: data.accountId }, f('canReconcile')),
          widget(
            'start-reconciliation',
            {
              accountId: data.accountId,
              openReconciliationId: data.openReconciliationId,
              glBalance: data.glBalance,
            },
            f('canReconcile'),
          ),
        ],
      }),
      widgetBlock('account-stats', {
        glBalanceLabel: data.glBalanceLabel,
        glBalanceValue: data.glBalanceDisplay,
        reconciledThroughLabel: data.reconciledThroughLabel,
        reconciledThrough: data.reconciledThrough,
        neverLabel: data.neverLabel,
        unmatchedLinesLabel: data.unmatchedLinesLabel,
        unmatchedLinesValue: data.unmatchedLinesDisplay,
        reconciliationLabel: data.reconciliationLabel,
        reconBadgeLabel: data.reconBadgeLabel,
        reconBadgeVariant: data.reconBadgeVariant,
      }),
    ],
    body: [
      grid('space-y-8', [
        grid('space-y-2', [
          grid('flex flex-wrap items-center gap-2', [
            heading(2, f('statementsTitle'), 'mr-auto text-sm font-semibold text-slate-900 dark:text-slate-100'),
            widgetBlock('search-input', {
              placeholder: data.statementsSearchPlaceholder,
              paramKey: 'stmtQ',
              pageParamKey: 'stmtPage',
            }),
            widgetBlock('filter-chips', {
              basePath: data.basePath,
              currentParams: data.currentParams,
              paramKey: 'source',
              label: data.sourceLabel,
              options: data.sourceOptions,
              pageParamKey: 'stmtPage',
            }),
          ]),
          {
            ...widgetBlock('empty-state', {
              title: data.statementsEmptyTitle,
              description: data.statementsEmptyDescription,
              action: data.canReconcile ? 'import-statement' : null,
              actionProps: data.canReconcile ? { accountId: data.accountId } : null,
            }),
            when: f('stmtIsEmpty'),
          },
          {
            ...table({
              variant: 'app',
              rows: f('statementRows'),
              rowKey: item('id'),
              sorting: {
                basePath: data.basePath,
                sort: f('stmtSort'),
                dir: f('stmtDir'),
                sortParamKey: 'stmtSort',
                dirParamKey: 'stmtDir',
                pageParamKey: 'stmtPage',
              },
              columns: [
                column(
                  rootF('columnStatementDate'),
                  link(item('dateLabel'), item('dateHref'), 'text-teal-700 hover:underline dark:text-teal-300'),
                  { sort: 'date', className: 'font-medium' },
                ),
                column(rootF('columnSource'), badge(item('sourceLabel'), { variant: 'outline' }), { sort: 'source' }),
                column(rootF('columnLines'), number(item('lineCount')), { sort: 'lines', align: 'right' }),
                column(
                  rootF('columnUnmatched'),
                  widgetCell('unmatched-count-cell', {
                    display: item('unmatchedCount'),
                    isZero: item('unmatchedIsZero'),
                  }),
                  // A widget cell is not a `money`/`number` cell, so the
                  // figure alignment has to be named explicitly.
                  { align: 'right', className: 'tabular-nums' },
                ),
                column(rootF('columnOpening'), money(item('openingBalance')), { align: 'right' }),
                column(rootF('columnClosing'), money(item('closingBalance')), { align: 'right' }),
                column(rootF('columnImported'), text(item('importedAt')), {
                  sort: 'imported',
                  className: MUTED,
                }),
              ],
            }),
            when: f('stmtShowTable'),
          },
          {
            ...pagination({
              basePath: data.basePath,
              total: f('stmtTotal'),
              page: f('stmtPage'),
              perPage: f('stmtPerPage'),
              pageParamKey: 'stmtPage',
              // The native pagers sit flush inside their section; the `mt-3`
              // spacer belongs to list pages that wrap them.
              bare: true,
            }),
            when: f('stmtShowTable'),
          },
        ], { as: 'section' }),
        grid('space-y-2', [
          grid('flex flex-wrap items-center gap-2', [
            heading(2, f('reconciliationsTitle'), 'mr-auto text-sm font-semibold text-slate-900 dark:text-slate-100'),
            widgetBlock('search-input', {
              placeholder: data.reconciliationsSearchPlaceholder,
              paramKey: 'reconQ',
              pageParamKey: 'reconPage',
            }),
            widgetBlock('filter-chips', {
              basePath: data.basePath,
              currentParams: data.currentParams,
              paramKey: 'reconStatus',
              label: data.reconStatusLabel,
              options: data.reconStatusOptions,
              pageParamKey: 'reconPage',
            }),
          ]),
          {
            ...widgetBlock('empty-state', {
              title: data.reconciliationsEmptyTitle,
              description: data.reconciliationsEmptyDescription,
              action: data.canReconcile ? 'start-reconciliation' : null,
              actionProps: data.canReconcile
                ? {
                    accountId: data.accountId,
                    openReconciliationId: data.openReconciliationId,
                    glBalance: data.glBalance,
                  }
                : null,
            }),
            when: f('reconIsEmpty'),
          },
          {
            ...table({
              variant: 'app',
              rows: f('reconRows'),
              rowKey: item('id'),
              sorting: {
                basePath: data.basePath,
                sort: f('reconSort'),
                dir: f('reconDir'),
                sortParamKey: 'reconSort',
                dirParamKey: 'reconDir',
                pageParamKey: 'reconPage',
              },
              columns: [
                column(rootF('columnThroughDate'), text(item('throughDate')), {
                  sort: 'through',
                  className: 'font-medium',
                }),
                column(rootF('columnStatementBalance'), money(item('statementBalance')), {
                  sort: 'balance',
                  align: 'right',
                }),
                column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') }), {
                  sort: 'status',
                }),
                column(rootF('columnStarted'), text(item('createdAt')), { sort: 'created', className: MUTED }),
                column(rootF('columnSignedOff'), text(item('signedOffAt')), { className: MUTED }),
                column(
                  '',
                  widgetCell('recon-action-cell', { href: item('actionHref'), label: item('actionLabel') }),
                ),
              ],
            }),
            when: f('reconShowTable'),
          },
          {
            ...pagination({
              basePath: data.basePath,
              total: f('reconTotal'),
              page: f('reconPage'),
              perPage: f('reconPerPage'),
              pageParamKey: 'reconPage',
              // The native pagers sit flush inside their section; the `mt-3`
              // spacer belongs to list pages that wrap them.
              bare: true,
            }),
            when: f('reconShowTable'),
          },
        ], { as: 'section' }),
      ]),
      widgetBlock('statement-drawer', { drawer: data.drawer }, f('drawerOpen')),
    ],
  })
}
