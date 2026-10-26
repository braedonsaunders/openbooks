import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { Badge, Button, PageHeader } from '@openbooks/ui'
import { db } from '@openbooks/engine/platform/db'
import { fromUnits } from '@openbooks/engine/money/money'
import { listSessions, listUsableRegisters, type SessionListRow } from '@openbooks/engine/pos'
import { ListPageLayout } from '@/components/page-layout'
import { ListFilterSelect } from '@/components/list-filter-select'
import { PagedTable } from '@/components/paged-table'
import { PosSessionHost, SessionOpenLink } from '@/components/pos/session-history'
import { requirePermission } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'
import { dateLabel } from '@/lib/format'
import { isUuid, parseListParams, pickString } from '@/lib/list-params'
import { getMoneyFormatter } from '@/lib/money-server'

export const dynamic = 'force-dynamic'

const BASE_PATH = '/pos/sessions'

export async function generateMetadata() {
  const t = await getTranslations('pos')
  return { title: t('session.historyTitle') }
}

/**
 * Drawer session history: every register session in the operator's legal
 * entities, newest first, with its sales, refunds and cash over/short. A
 * session opens its X report (still open) or Z report (closed) in the
 * drawer. Reading session reports is the drawer permission, the same gate
 * the session API enforces.
 */
export default async function PosSessionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const authz = await requirePermission('pos.drawer')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'posRegister')
  const [t, locale, formatter] = await Promise.all([getTranslations('pos'), getLocale(), getMoneyFormatter(orgId)])
  const scope = authz.allowedSubsidiaryIds ?? null
  const { page, perPage } = parseListParams(sp, { sort: 'opened', allowedSorts: ['opened'] })
  const registerParam = pickString(sp.register)
  const registerId = registerParam && isUuid(registerParam) ? registerParam : null
  const statusParam = pickString(sp.status)
  const status = statusParam === 'open' || statusParam === 'closed' ? statusParam : null
  const [registers, list] = await Promise.all([
    listUsableRegisters(db, orgId, scope),
    listSessions(db, orgId, { registerId, status, limit: perPage, offset: (page - 1) * perPage }, scope),
  ])
  const money = (row: SessionListRow, minor: string | null) => (minor === null ? '' : formatter.money(fromUnits(BigInt(minor)), { currency: row.currency }))
  const overShort = (row: SessionListRow) => {
    if (row.overShortMinor === null) return <span className="text-slate-400">—</span>
    const units = BigInt(row.overShortMinor)
    if (units === 0n) return <Badge variant="success">{t('report.balanced')}</Badge>
    const amount = formatter.money(fromUnits(units < 0n ? -units : units), { currency: row.currency })
    return <Badge variant="warning">{units > 0n ? t('history.overAmount', { amount }) : t('history.shortAmount', { amount })}</Badge>
  }

  return (
    <ListPageLayout
      header={(
        <PageHeader
          title={t('session.historyTitle')}
          description={t('history.description')}
          actions={(
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline"><Link href="/reports">{t('history.reports')}</Link></Button>
              <Button asChild variant="outline"><Link href="/pos">{t('history.registers')}</Link></Button>
            </div>
          )}
        />
      )}
    >
      <PagedTable
        prepared
        source="pos_sessions"
        rows={list.rows}
        rowKey={(row) => row.id}
        empty={t('history.empty')}
        basePath={BASE_PATH}
        currentParams={sp}
        serverWindow={{ total: list.total, page, perPage }}
        searchable={false}
        toolbarAfter={(
          <div className="flex flex-wrap items-center gap-3">
            <ListFilterSelect
              basePath={BASE_PATH}
              currentParams={sp}
              paramKey="register"
              label={t('history.register')}
              allLabel={t('history.allRegisters')}
              options={registers.map((register) => ({ value: register.id, label: `${register.code} · ${register.name}` }))}
            />
            <ListFilterSelect
              basePath={BASE_PATH}
              currentParams={sp}
              paramKey="status"
              label={t('history.status')}
              allLabel={t('history.allStatuses')}
              options={[{ value: 'open', label: t('history.open') }, { value: 'closed', label: t('history.closed') }]}
            />
          </div>
        )}
        columns={[
          {
            key: 'session',
            header: t('history.session'),
            cell: (row) => <SessionOpenLink sessionId={row.id}>{t('history.sessionNumber', { number: row.sessionNumber })}</SessionOpenLink>,
          },
          { key: 'register', header: t('history.register'), cell: (row) => `${row.registerCode} · ${row.registerName}` },
          { key: 'businessDate', header: t('history.businessDate'), className: 'whitespace-nowrap', cell: (row) => dateLabel(new Date(`${row.businessDate}T00:00:00Z`), locale) },
          {
            key: 'status',
            header: t('history.status'),
            cell: (row) => <Badge variant={row.status === 'open' ? 'success' : 'outline'}>{row.status === 'open' ? t('history.open') : t('history.closed')}</Badge>,
          },
          { key: 'openedBy', header: t('history.openedBy'), cell: (row) => row.openedByName ?? '' },
          { key: 'closedBy', header: t('history.closedBy'), cell: (row) => row.closedByName ?? '' },
          { key: 'sales', header: t('history.sales'), align: 'right', cell: (row) => t('history.salesCell', { count: row.saleCount, amount: money(row, row.salesTotalMinor) }) },
          { key: 'refunds', header: t('history.refunds'), align: 'right', cell: (row) => money(row, row.refundsTotalMinor) },
          { key: 'counted', header: t('report.countedCash'), align: 'right', cell: (row) => money(row, row.countedCashMinor) },
          { key: 'overShort', header: t('history.overShort'), align: 'right', cell: overShort },
        ]}
      />
      <PosSessionHost />
    </ListPageLayout>
  )
}
