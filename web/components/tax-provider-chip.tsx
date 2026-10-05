'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'

export interface TaxProviderChipRow {
  id: string
  status: string
  lastError: string | null
}

/** Badge vocabulary for commit rows, shared with the activity drawer. */
export function providerCommitStatusVariant(status: string): 'success' | 'secondary' | 'warning' | 'outline' {
  if (status === 'committed') return 'success'
  if (status === 'failed') return 'warning'
  if (status === 'pending') return 'secondary'
  return 'outline'
}

/** A failed row retries; anything else is informational. */
export function providerCommitRetryable(canRetry: boolean, status: string): boolean {
  return canRetry && status === 'failed'
}

/**
 * Provider commit status for a posted sales document. Renders nothing while
 * the document has no commit rows (no provider, manual rates, or the commit
 * switch off — there is nothing to commit to). A failure names the reason
 * and offers the retry in place.
 */
export function TaxProviderStatusChip({
  documentNumber,
  provider,
  rows,
  canRetry,
}: {
  documentNumber: string
  provider: string
  rows: TaxProviderChipRow[]
  canRetry: boolean
}) {
  const t = useTranslations('tax.activity')
  const tc = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (rows.length === 0) return null
  const row = rows.find((candidate) => candidate.status === 'failed') ?? rows[0]!
  const retryable = providerCommitRetryable(canRetry, row.status)

  const retryNow = async () => {
    const confirmed = await confirmDialog({
      title: t('retryConfirmTitle'),
      message: t('retryConfirmDescription', { document: documentNumber, provider }),
      confirmLabel: t('retryNow'),
      cancelLabel: tc('actions.cancel'),
    })
    if (!confirmed) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/tax/provider-transactions/${row.id}/retry`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setError((body?.error as string | undefined) ?? t('retryFailed'))
        return
      }
      toast.success(t('retryStarted'))
      router.refresh()
    } catch {
      setError(t('retryFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={providerCommitStatusVariant(row.status)}>{t(`status.${row.status}`)}</Badge>
      {row.status === 'failed' && row.lastError && (
        <span className="text-sm text-muted-foreground">{row.lastError}</span>
      )}
      {retryable && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void retryNow()}>
          {busy ? tc('actions.saving') : t('retryNow')}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
