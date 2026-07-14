import Link from 'next/link'
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

export default async function Dashboard() {
  const [{ totals, runs }, org] = await Promise.all([dashboardData(), orgInfo()])
  const sources = configuredSources()
  const lastOk = runs.find((r: any) => r.status === 'ok')
  const lastTb = lastOk?.stats?.tb
  const balanced = Number(totals.ledger_sum) === 0
  const parityOk = lastTb && lastTb.mismatches?.length === 0

  return (
    <PageContainer>
      <PageHeader
        title="Dashboard"
        description={org ? `${org.name} · ${org.base_currency} · ${org.book}` : undefined}
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Journal entries"
          value={Number(totals.entries).toLocaleString()}
          icon={<ScrollText size={18} />}
        />
        <StatCard
          label="Journal lines"
          value={Number(totals.lines).toLocaleString()}
          icon={<SquareStack size={18} />}
        />
        <StatCard
          label="Ledger balance"
          value={balanced ? 'Σ = 0.00' : `Σ = ${money(totals.ledger_sum)}`}
          tone={balanced ? 'good' : 'bad'}
          icon={<Scale size={18} />}
        />
        {lastTb ? (
          <StatCard
            label={`Parallel-run vs ${lastOk.source}`}
            value={`${lastTb.matches}/${lastTb.accounts} match`}
            tone={parityOk ? 'good' : 'bad'}
          />
        ) : null}
      </div>

      {sources.length > 0 ? (
        <Card className="mt-6">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm text-slate-600 dark:text-slate-300">
              An external accounting system is connected for parallel-run verification. Sync is
              manual; every sync re-verifies the trial balance per account.{' '}
              <Link
                href="/sync"
                className="inline-flex items-center gap-1 font-medium text-teal-700 hover:underline dark:text-teal-300"
              >
                Sync page <ArrowRight size={13} />
              </Link>
            </div>
            <SyncButton source={sources[0]!.name} label={sources[0]!.displayName} />
          </CardContent>
        </Card>
      ) : null}

      <h2 className="mt-8 mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
        Recent sync runs
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">New</TableHead>
            <TableHead className="text-right">Reversed</TableHead>
            <TableHead className="text-right">Unchanged</TableHead>
            <TableHead>TB verification</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-slate-500 dark:text-slate-400">
                No syncs yet.
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
                  {r.status}
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
