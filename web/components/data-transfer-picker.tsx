'use client'
import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Alert, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../lib/api-error'
import { requestTransfer } from '../lib/data-io/transfer-client'
import type { TransferJob, TransferSummary } from '../lib/data-io/transfer-contract'

/** Operators can reopen durable work after navigation or a lost browser tab. */
export function DataTransferPicker({ kind, job, onChange, disabled = false }: {
  kind: TransferJob['kind']; job: TransferJob | null; onChange: (job: TransferJob) => void; disabled?: boolean
}) {
  const t = useTranslations('data.transfer'), id = useId()
  const [jobs, setJobs] = useState<TransferSummary[]>([]), [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/api/data/transfers', { cache: 'no-store', signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('loadFailed')))
      const result = await response.json()
      if (!abort.signal.aborted) setJobs((result.jobs ?? []).filter((item: TransferSummary) => item.kind === kind))
    }).catch((error: Error) => { if (!abort.signal.aborted) setError(error.message) })
    return () => abort.abort()
  }, [kind, job?.id, job?.state, t])
  if (!jobs.length && !error) return null
  return <div className="space-y-2">
    <Label htmlFor={id}>{t('recent')}</Label>
    <Select id={id} value={job?.id ?? ''} disabled={loading || disabled} onChange={async (event) => {
      if (!event.target.value) return
      setLoading(true); setError(null)
      try { onChange(await requestTransfer(`/api/data/transfers/${encodeURIComponent(event.target.value)}`)) }
      catch (error) { setError((error as Error).message) } finally { setLoading(false) }
    }}>
      <option value="">{t('choose')}</option>
      {jobs.map((item) => <option key={item.id} value={item.id}>{item.filename} · {t(`states.${item.state}`)}</option>)}
    </Select>
    {error && <Alert variant="destructive">{error}</Alert>}
  </div>
}
