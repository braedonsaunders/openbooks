import { configuredSources } from '@openbooks/engine/src/sync/registry.ts'
import { Alert, AlertDescription, AlertTitle, Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { PageContainer } from '../../../components/page-layout'
import { dashboardData } from '../../../lib/data'
import { dateTime } from '../../../lib/format'
import { SyncButton } from './SyncButton'

export const dynamic = 'force-dynamic'

export default async function SyncPage() {
  const { runs } = await dashboardData()
  const sources = configuredSources()
  const lastOk = runs.find((r: any) => r.status === 'ok')
  const mismatches = lastOk?.stats?.tb?.mismatches ?? []

  return (
    <PageContainer>
      <PageHeader
        title="Sync"
        description="Manual bridge to a connected accounting system while running in parallel. Changed transactions are reversed and re-posted — full audit trail, no mutation. Every sync re-verifies the trial balance per account against the live source."
      />

      <div className="mt-6 space-y-6">
        {sources.length === 0 ? (
          <Alert>
            <AlertTitle>No external source configured</AlertTitle>
            <AlertDescription>
              Connect one by adding a source adapter and its credentials; it will appear here
              automatically.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Connected sources</h2>
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
              Trial-balance mismatches (last sync)
            </h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source account</TableHead>
                  <TableHead className="text-right">openbooks</TableHead>
                  <TableHead className="text-right">source</TableHead>
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
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">All runs</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Finished</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Detail</TableHead>
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
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">
                    {r.status === 'ok' && r.stats
                      ? `${r.stats.newEntries} new · ${r.stats.reversedEntries} reversed · ${r.stats.unchanged} unchanged · TB ${r.stats.tb?.matches}/${r.stats.tb?.accounts}`
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
