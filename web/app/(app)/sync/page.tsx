import { getTranslations } from 'next-intl/server'
import { configuredSources } from '@openbooks/engine/src/sync/registry.ts'
import { Alert, AlertDescription, AlertTitle, Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { PageContainer } from '../../../components/page-layout'
import { dashboardData } from '../../../lib/data'
import { dateTime } from '../../../lib/format'
import { SyncButton } from './SyncButton'

export const dynamic = 'force-dynamic'

// Run statuses we have display labels for — anything else renders verbatim.
const RUN_STATUS_KEYS = ['ok', 'failed', 'running'] as const

export default async function SyncPage() {
  const t = await getTranslations('sync')
  const tc = await getTranslations('common')
  const { runs } = await dashboardData()
  const sources = configuredSources()
  const lastOk = runs.find((r: any) => r.status === 'ok')
  const mismatches = lastOk?.stats?.tb?.mismatches ?? []

  return (
    <PageContainer>
      <PageHeader title={t('title')} description={t('description')} />

      <div className="mt-6 space-y-6">
        {sources.length === 0 ? (
          <Alert>
            <AlertTitle>{t('noSource.title')}</AlertTitle>
            <AlertDescription>{t('noSource.description')}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('connectedSources')}</h2>
            {sources.map((s) => (
              <div key={s.name} className="flex items-center gap-3">
                <Badge variant="success">{s.displayName}</Badge>
                <SyncButton source={s.name} label={s.displayName} />
              </div>
            ))}
          </div>
        )}

        {mismatches.length > 0 ? (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-red-600 dark:text-red-400">
              {t('mismatchesHeading')}
            </h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.sourceAccount')}</TableHead>
                  <TableHead className="text-right">{t('columns.ours')}</TableHead>
                  <TableHead className="text-right">{t('columns.theirs')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mismatches.map((m: any) => (
                  <TableRow key={m.accountRef}>
                    <TableCell className="font-mono text-[13px]">{m.accountRef}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.ours}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.theirs}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('allRuns')}</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.started')}</TableHead>
                <TableHead>{t('columns.finished')}</TableHead>
                <TableHead>{t('columns.trigger')}</TableHead>
                <TableHead>{tc('labels.status')}</TableHead>
                <TableHead>{t('columns.detail')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell>{dateTime(r.started_at)}</TableCell>
                  <TableCell>{dateTime(r.finished_at)}</TableCell>
                  <TableCell>{r.triggered_by}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === 'ok' ? 'success' : r.status === 'failed' ? 'destructive' : 'secondary'}>
                      {(RUN_STATUS_KEYS as readonly string[]).includes(r.status)
                        ? t(`runStatus.${r.status}`)
                        : r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">
                    {r.status === 'ok' && r.stats
                      ? t('runStats', {
                          newEntries: r.stats.newEntries,
                          reversedEntries: r.stats.reversedEntries,
                          unchanged: r.stats.unchanged,
                          matches: r.stats.tb?.matches,
                          accounts: r.stats.tb?.accounts,
                        })
                      : (r.error_message ?? '')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </PageContainer>
  )
}
