'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, UrlDrawer } from '@openbooks/ui'
import type { CompensationRunResult, InterestRunResult } from '@openbooks/engine/equity'
import { RegisteredListTable } from '@/components/registered-list-table'
import { ListFilterSelect } from '@/components/list-filter-select'
import { MoneyProvider, useMoney } from '@/components/money-provider'
import type { RunsViewData } from './view'
import { CELL, HEAD, LINK, NUM_CELL, NUM_HEAD, OpenReport, PendingActions, Refusal, postJson, useShares, withParams } from './shared'

const BASE = '/equity'

/** A posted run, or a run an Equity action Flow holds for approval. */
type GovernedRun<T> = (T & { status: 'applied' }) | { status: 'pending_approval'; throughDate: string }

/**
 * The periodic equity runs, operated like every period posting: pick the
 * accounting period, review what the run would post through its end, and
 * post it. The stock compensation run posts the awards' expense and releases
 * restricted stock as it vests; the note interest run accrues convertible
 * note interest. Both are close tasks of the period; their posted runs open
 * in the run history drawer (`?history=1`).
 */
export function EquityRunsPanel({ view }: { view: RunsViewData | null }) {
  if (!view) return null
  return (
    <MoneyProvider currency={view.context.currency}>
      <RunsBody view={view} />
    </MoneyProvider>
  )
}

function RunsBody({ view }: { view: RunsViewData }) {
  const t = useTranslations('equity')
  const { money } = useMoney()
  const shares = useShares()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const { context } = view
  const compensation = view.run === 'compensation'
  const preview = compensation ? view.compensation : view.interest
  const runs = compensation ? view.compensationRuns : view.interestRuns
  const lastRunThrough = runs[0]?.throughDate ?? null
  const alreadyRun = view.throughDate !== null && runs.some((run) => run.throughDate === view.throughDate)
  const backdated = view.throughDate !== null && lastRunThrough !== null && view.throughDate < lastRunThrough
  const period = view.periods.find((row) => row.id === view.periodId) ?? null

  async function post() {
    if (!view.throughDate) return
    setBusy(true)
    try {
      if (compensation) {
        const run = await postJson<GovernedRun<CompensationRunResult>>('/api/equity/compensation/runs', { subsidiaryId: context.subsidiaryId, throughDate: view.throughDate }, t('compensation.failed'))
        toast.success(run.status === 'pending_approval' ? t('approval.submitted')
          : run.replayed ? t('compensation.replayed', { date: run.throughDate }) : t('compensation.posted', { date: run.throughDate }))
      } else {
        const run = await postJson<GovernedRun<InterestRunResult>>('/api/equity/interest/runs', { subsidiaryId: context.subsidiaryId, throughDate: view.throughDate }, t('interest.failed'))
        toast.success(run.status === 'pending_approval' ? t('approval.submitted')
          : run.replayed ? t('interest.replayed', { date: run.throughDate }) : t('interest.posted', { date: run.throughDate }))
      }
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : compensation ? t('compensation.failed') : t('interest.failed'))
    } finally {
      setBusy(false)
    }
  }

  const toolbar = (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <ListFilterSelect
        basePath={BASE} currentParams={context.params} paramKey="run" pageParamKey={null} label={t('runs.filters.run')}
        options={[{ value: '', label: t('runs.kinds.compensation') }, { value: 'interest', label: t('runs.kinds.interest') }]}
      />
      {view.periods.length > 0 && (
        <ListFilterSelect
          basePath={BASE} currentParams={{ ...context.params, period: view.periodId ?? undefined }} paramKey="period" pageParamKey={null} label={t('runs.filters.period')}
          options={view.periods.map((row) => ({ value: row.id, label: row.name }))}
        />
      )}
      {compensation && (
        <ListFilterSelect
          basePath={BASE} currentParams={context.params} paramKey="lines" pageParamKey={null} label={t('runs.filters.lines')}
          options={[{ value: '', label: t('runs.lines.expense') }, { value: 'releases', label: t('compensation.releases') }]}
        />
      )}
      <div className="ml-auto flex items-center gap-2">
        <OpenReport href={view.reportHref} label={t('compensation.report')} />
        <Button asChild variant="outline" size="sm"><Link href={view.historyHref}>{t('runs.history')}</Link></Button>
        {context.canManage && view.throughDate && preview && (
          <Button size="sm" onClick={post} disabled={busy || alreadyRun || backdated}>
            {compensation ? t('runs.postCompensation', { period: period?.name ?? view.throughDate }) : t('runs.postInterest', { period: period?.name ?? view.throughDate })}
          </Button>
        )}
      </div>
    </div>
  )

  const summary = preview ? (
    <p className="text-sm text-slate-500 dark:text-slate-400">
      {t('runs.through', { date: view.throughDate ?? '' })} · {lastRunThrough ? t('compensation.lastRun', { date: lastRunThrough }) : t('compensation.noRuns')} ·{' '}
      {t('compensation.total')}: <strong>{money(compensation && view.lines === 'releases' ? view.compensation!.releaseTotal : preview.total, { currency: preview.currency })}</strong>
      {alreadyRun ? ` · ${t('runs.alreadyPosted')}` : backdated ? ` · ${t('runs.backdated', { date: lastRunThrough ?? '' })}` : ` · ${t('runs.closeTask')}`}{' '}
      {!alreadyRun && !backdated && <Link className={LINK} href="/close">{t('runs.openClose')}</Link>}
    </p>
  ) : null

  return (
    <div className="space-y-3">
      <PendingActions pending={context.pending} filter={(request) => request.action === (compensation ? 'compensation_run' : 'interest_run')} />
      {view.periods.length === 0 ? (
        <>
          {toolbar}
          <Refusal refusal={{ message: t('runs.noPeriods'), remedy: t('runs.noPeriodsRemedy') }} action={{ href: view.periodsSetupHref, label: t('runs.setUpPeriods') }} />
        </>
      ) : view.refusal ? (
        <>
          {toolbar}
          <Refusal refusal={view.refusal} />
        </>
      ) : (
        <>
          {summary}
          {compensation && view.compensation && view.lines === 'expense' && (
            <RegisteredListTable
              source="equity_compensation_lines"
              rows={view.compensation.lines}
              rowKey={(row) => row.securityId}
              empty={t('compensation.empty')}
              toolbarAfter={toolbar}
              columns={[
                {
                  key: 'security', header: <>{t('securities.columns.number')}</>, headerClassName: HEAD, className: CELL,
                  cell: (row) => <Link className={`font-mono ${LINK}`} href={withParams(BASE, context.params, { view: 'securities', security: row.securityId, run: undefined, period: undefined, lines: undefined })}>{row.securityNumber}</Link>,
                  search: (row) => `${row.securityNumber} ${view.parties[row.holderPartyId] ?? ''}`,
                },
                { key: 'kind', header: <>{t('securities.columns.kind')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{t(`kind.${row.kind}`)}</> },
                { key: 'holder', header: <>{t('securities.columns.holder')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{view.parties[row.holderPartyId] ?? '—'}</> },
                { key: 'cumulative', header: <>{t('compensation.columns.cumulative')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.cumulative)}</> },
                { key: 'previous', header: <>{t('compensation.columns.previous')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.previous)}</> },
                { key: 'period', header: <>{t('compensation.columns.period')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <strong>{money(row.period)}</strong> },
              ]}
            />
          )}
          {compensation && view.compensation && view.lines === 'releases' && (
            <RegisteredListTable
              source="equity_compensation_releases"
              rows={view.compensation.releases}
              rowKey={(row) => row.securityId}
              empty={t('compensation.releasesEmpty')}
              toolbarAfter={toolbar}
              columns={[
                {
                  key: 'security', header: <>{t('securities.columns.number')}</>, headerClassName: HEAD, className: CELL,
                  cell: (row) => <Link className={`font-mono ${LINK}`} href={withParams(BASE, context.params, { view: 'securities', security: row.securityId, run: undefined, period: undefined, lines: undefined })}>{row.securityNumber}</Link>,
                  search: (row) => `${row.securityNumber} ${view.parties[row.holderPartyId] ?? ''}`,
                },
                { key: 'holder', header: <>{t('securities.columns.holder')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{view.parties[row.holderPartyId] ?? '—'}</> },
                { key: 'shares', header: <>{t('compensation.columns.releasedShares')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{shares(row.previousShares)} → {shares(row.shares)}</> },
                { key: 'deposit', header: <>{t('compensation.columns.deposit')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.deposit)}</> },
                { key: 'reclass', header: <>{t('compensation.columns.reclass')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.reclass)}</> },
                { key: 'par', header: <>{t('compensation.columns.par')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.par)}</> },
              ]}
            />
          )}
          {!compensation && view.interest && (
            <RegisteredListTable
              source="equity_interest_lines"
              rows={view.interest.lines}
              rowKey={(row) => row.securityId}
              empty={t('interest.empty')}
              toolbarAfter={toolbar}
              columns={[
                {
                  key: 'security', header: <>{t('securities.columns.number')}</>, headerClassName: HEAD, className: CELL,
                  cell: (row) => <Link className={`font-mono ${LINK}`} href={withParams(BASE, context.params, { view: 'securities', security: row.securityId, run: undefined, period: undefined, lines: undefined })}>{row.securityNumber}</Link>,
                  search: (row) => `${row.securityNumber} ${view.parties[row.holderPartyId] ?? ''}`,
                },
                { key: 'holder', header: <>{t('securities.columns.holder')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{view.parties[row.holderPartyId] ?? '—'}</> },
                { key: 'cumulative', header: <>{t('interest.columns.cumulative')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.cumulative, { currency: row.currency })}</> },
                { key: 'previous', header: <>{t('interest.columns.previous')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.previous, { currency: row.currency })}</> },
                { key: 'period', header: <>{t('interest.columns.period')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <strong>{money(row.period, { currency: row.currency })}</strong> },
                { key: 'functional', header: <>{t('interest.columns.functional')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.functional)}</> },
              ]}
            />
          )}
        </>
      )}
      {view.historyOpen && <RunHistoryDrawer view={view} />}
    </div>
  )
}

/** The runs posted for the legal entity, latest first, each with the journal entry it posted. */
function RunHistoryDrawer({ view }: { view: RunsViewData }) {
  const t = useTranslations('equity')
  const { money } = useMoney()
  const compensation = view.run === 'compensation'
  const rows = compensation ? view.compensationRuns : view.interestRuns
  return (
    <UrlDrawer open openKey={view.run} closeHref={view.historyCloseHref} size="lg"
      title={compensation ? t('runs.historyTitle.compensation') : t('runs.historyTitle.interest')}
      description={t('runs.historyDescription')}>
      <div className="p-4">
        <RegisteredListTable
          source={compensation ? 'equity_compensation_runs' : 'equity_interest_runs'}
          rows={rows}
          rowKey={(row) => row.id}
          empty={compensation ? t('compensation.runsEmpty') : t('interest.runsEmpty')}
          searchable={false}
          columns={[
            { key: 'through', header: <>{t('compensation.columns.through')}</>, headerClassName: HEAD, className: `${CELL} font-mono`, cell: (row) => <>{row.throughDate}</> },
            { key: 'total', header: <>{t('compensation.columns.total')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{money(row.total, { currency: row.currency })}</> },
            {
              key: 'entry', header: <>{t('compensation.columns.entry')}</>, headerClassName: HEAD, className: `${CELL} font-mono`,
              cell: (row) => row.journalEntryId ? <Link className={LINK} href={`/journal?entry=${row.journalEntryId}`}>{row.entryNumber ?? row.journalEntryId}</Link> : <>{t('compensation.noEntry')}</>,
            },
          ]}
        />
      </div>
    </UrlDrawer>
  )
}
