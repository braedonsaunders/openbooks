import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { ArrowRight, Scale, ScrollText, SquareStack } from 'lucide-react'
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { PageContainer } from '../../components/page-layout'
import { dashboardData, orgInfo } from '../../lib/data'
import { dateTime, money } from '../../lib/format'
import { configuredSources } from '@openbooks/engine/src/sync/registry.ts'
import { SyncButton } from './sync/SyncButton'

export const dynamic = 'force-dynamic'

function StatCard({
  label,
  value,
  tone = 'default',
  icon,
}: {
  label: string
  value: string
  tone?: 'default' | 'good' | 'bad'
  icon?: React.ReactNode
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        {icon ? (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
            {icon}
          </span>
        ) : null}
        <span className="min-w-0">
          <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
            {label}
          </span>
          <span
            className={
              'block truncate text-2xl font-semibold tabular-nums ' +
              (tone === 'good'
                ? 'text-teal-700 dark:text-teal-300'
                : tone === 'bad'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-slate-900 dark:text-slate-100')
            }
          >
            {value}
          </span>
        </span>
      </CardContent>
    </Card>
  )
}

// Known sync-run statuses — unknown values from the database render verbatim.
const RUN_STATUSES = ['ok', 'failed', 'running']

export default async function Dashboard() {
  const t = await getTranslations('dashboard')
  const tc = await getTranslations('common')
  const [{ totals, runs }, org] = await Promise.all([dashboardData(), orgInfo()])
  const sources = configuredSources()
  const lastOk = runs.find((r: any) => r.status === 'ok')
  const lastTb = lastOk?.stats?.tb
  const balanced = Number(totals.ledger_sum) === 0
  const parityOk = lastTb && lastTb.mismatches?.length === 0

  return (
    <PageContainer>
      <PageHeader
        title={t('title')}
        description={
          org
            ? t('orgDescription', { name: org.name, currency: org.base_currency, book: org.book })
            : undefined
        }
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('stats.journalEntries')}
          value={Number(totals.entries).toLocaleString()}
          icon={<ScrollText size={18} />}
        />
        <StatCard
          label={t('stats.journalLines')}
          value={Number(totals.lines).toLocaleString()}
          icon={<SquareStack size={18} />}
        />
        <StatCard
          label={t('stats.ledgerBalance')}
          value={
            balanced
              ? t('stats.ledgerBalanced')
              : t('stats.ledgerSum', { amount: money(totals.ledger_sum) })
          }
          tone={balanced ? 'good' : 'bad'}
          icon={<Scale size={18} />}
        />
        {lastTb ? (
          <StatCard
            label={t('stats.parallelRun', { source: lastOk.source })}
            value={t('stats.parityValue', {
              // Stringified so ICU doesn't add digit grouping to the counts.
              matches: String(lastTb.matches),
              accounts: String(lastTb.accounts),
            })}
            tone={parityOk ? 'good' : 'bad'}
          />
        ) : null}
      </div>

      {sources.length > 0 ? (
        <Card className="mt-6">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm text-slate-600 dark:text-slate-300">
              {t('syncCard.body')}{' '}
              <Link
                href="/sync"
                className="inline-flex items-center gap-1 font-medium text-teal-700 hover:underline dark:text-teal-300"
              >
                {t('syncCard.link')} <ArrowRight size={13} />
              </Link>
            </div>
            <SyncButton source={sources[0]!.name} label={sources[0]!.displayName} />
          </CardContent>
        </Card>
      ) : null}

      <h2 className="mt-8 mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
        {t('recentRuns.title')}
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('recentRuns.started')}</TableHead>
            <TableHead>{t('recentRuns.source')}</TableHead>
            <TableHead>{t('recentRuns.trigger')}</TableHead>
            <TableHead>{tc('labels.status')}</TableHead>
            <TableHead className="text-right">{t('recentRuns.new')}</TableHead>
            <TableHead className="text-right">{t('recentRuns.reversed')}</TableHead>
            <TableHead className="text-right">{t('recentRuns.unchanged')}</TableHead>
            <TableHead>{t('recentRuns.tbVerification')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-slate-500 dark:text-slate-400">
                {t('recentRuns.empty')}
              </TableCell>
            </TableRow>
          ) : null}
          {runs.map((r: any) => (
            <TableRow key={r.id}>
              <TableCell>{dateTime(r.started_at)}</TableCell>
              <TableCell>{r.source}</TableCell>
              <TableCell>{r.triggered_by}</TableCell>
              <TableCell>
                <Badge variant={r.status === 'ok' ? 'success' : r.status === 'failed' ? 'destructive' : 'secondary'}>
                  {RUN_STATUSES.includes(r.status) ? t(`recentRuns.runStatus.${r.status}`) : r.status}
                </Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.stats?.newEntries ?? ''}</TableCell>
              <TableCell className="text-right tabular-nums">{r.stats?.reversedEntries ?? ''}</TableCell>
              <TableCell className="text-right tabular-nums">{r.stats?.unchanged ?? ''}</TableCell>
              <TableCell>
                {r.stats?.tb ? (
                  <Badge variant={r.stats.tb.mismatches?.length === 0 ? 'success' : 'destructive'}>
                    {r.stats.tb.matches}/{r.stats.tb.accounts}
                  </Badge>
                ) : (
                  <span className="text-xs text-slate-500">{r.error_message ?? ''}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </PageContainer>
  )
}
