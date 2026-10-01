'use client'
import { useState } from 'react'
import { useTranslations, useFormatter } from 'next-intl'
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@openbooks/ui'
import type { TransferJob } from '../lib/data-io/transfer-contract'
import { transferCommand } from '../lib/data-io/transfer-client'

/** One status surface for imports and exports, backed by durable job state. */
export function DataTransferStatus({ job, onChange, connectionError }: {
  job: TransferJob; onChange: (job: TransferJob) => void; connectionError?: string | null
}) {
  const t = useTranslations('data.transfer'), format = useFormatter()
  const tExport = useTranslations('data.export')
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const terminal = ['completed', 'failed', 'cancelled'].includes(job.state)
  const amount = job.state === 'uploading' ? job.uploadedBytes : job.processedRows
  const total = job.state === 'uploading' ? job.bytes : job.totalRows
  const knownTotal = terminal || job.state === 'uploading' || (job.kind === 'import' && job.state !== 'parsing')
  const command = async (action: 'cancel' | 'retry') => {
    setBusy(true); setError(null)
    try { onChange(await transferCommand(job, action)) } catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  return <Card>
    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
      <CardTitle className="text-sm">{t('title')}</CardTitle>
      <Badge variant={job.state === 'failed' ? 'outline' : job.state === 'completed' ? 'success' : 'secondary'}>{!job.workerActive && ['parsing', 'previewing', 'committing', 'exporting'].includes(job.state) ? t('queued') : t(`states.${job.state}`)}</Badge>
    </CardHeader>
    <CardContent className="space-y-4">
      <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2">
        <p className="truncate text-sm font-medium">{job.filename}</p>
        {job.kind === 'export' && job.state === 'completed' && <p className="text-sm">{tExport('exported', { filename: job.filename, count: job.options.columns?.length ?? 0 })}</p>}
        <p className="text-sm tabular-nums text-muted-foreground">{job.state === 'uploading'
          ? t('uploaded', { current: format.number(amount), total: format.number(total) })
          : knownTotal ? t('processedOf', { current: format.number(amount), total: format.number(total) }) : t('processed', { current: format.number(amount) })}</p>
        <progress aria-label={t('title')} className="h-2 w-full accent-teal-600" max={Math.max(total, 1)} {...(knownTotal ? { value: amount } : {})} />
      </div>
      <p className="text-xs text-muted-foreground">{t('lastActivity', { time: format.dateTime(new Date(job.lastActivity), { dateStyle: 'medium', timeStyle: 'medium' }) })}</p>
      {job.kind === 'import' && <p className="text-xs text-muted-foreground">{t('committed', { created: format.number(job.outcome.created), updated: format.number(job.outcome.updated), deleted: format.number(job.outcome.deleted ?? 0) })}</p>}
      {connectionError && <Alert variant="warning">{t('reconnecting')} {connectionError}</Alert>}
      {(job.error || error) && <Alert variant="destructive">{job.error || error}</Alert>}
      {job.kind === 'import' && <p className="text-xs text-muted-foreground">{t('batchPolicy')}</p>}
      <div className="flex flex-wrap gap-2">
        {!terminal && <Button variant="outline" size="sm" disabled={busy || job.cancelRequested} onClick={() => { void command('cancel') }}>{job.cancelRequested ? t('cancelling') : t('cancel')}</Button>}
        {job.state === 'failed' && !job.cancelRequested && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void command('retry') }}>{t('retry')}</Button>}
        {job.kind === 'export' && job.state === 'completed' && <Button asChild size="sm"><a href={`/api/data/transfers/${job.id}/download`}>{t('download')}</a></Button>}
        {job.kind === 'import' && (job.preview.failed > 0 || job.outcome.failed > 0 || (job.preview.warnings?.length ?? 0) > 0) && <Button asChild size="sm" variant="outline"><a href={`/api/data/transfers/${job.id}/issues?phase=${job.outcome.failed ? 'commit' : 'preview'}`}>{t('issues')}</a></Button>}
      </div>
      {job.state === 'uploading' && <p className="text-xs text-muted-foreground">{t('resumeUpload')}</p>}
    </CardContent>
  </Card>
}
