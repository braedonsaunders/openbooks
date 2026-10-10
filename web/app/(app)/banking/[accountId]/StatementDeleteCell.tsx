'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'

/**
 * Delete one statement import from the account's import history. The engine
 * is authoritative: it refuses matched, excluded, signed-off-history and
 * duplicate-flagged imports with named remedies, surfaced here as the
 * failure toast. A blocked import renders its reason on the disabled
 * control instead of offering a delete that cannot succeed.
 */
export function StatementDeleteCell({
  statementId,
  lineCount,
  blockedReason,
  confirmMessage,
  showDelete,
}: {
  statementId: string
  lineCount: number
  blockedReason: string | null
  confirmMessage: string
  showDelete?: boolean
}) {
  const t = useTranslations('banking.account')
  const tBanking = useTranslations('banking')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  if (!showDelete) return null
  if (blockedReason) {
    return (
      <Button variant="ghost" size="sm" disabled title={blockedReason} aria-label={t('deleteImport')}>
        <Trash2 size={14} />
      </Button>
    )
  }

  async function run() {
    const ok = await confirmDialog({ message: confirmMessage, confirmLabel: t('deleteImport'), tone: 'danger' })
    if (!ok || busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/banking/statements/${statementId}`, { method: 'DELETE' })
      const data = (await res.json().catch(() => null)) as { error?: unknown; deletedLines?: unknown } | null
      if (!res.ok) {
        toast.error(typeof data?.error === 'string' && data.error ? data.error : tBanking('errors.requestFailed'))
        return
      }
      toast.success(t('importDeleted', { count: typeof data?.deletedLines === 'number' ? data.deletedLines : lineCount }))
      router.refresh()
    } catch {
      toast.error(tBanking('errors.requestFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="ghost" size="sm" disabled={busy} title={t('deleteImport')} aria-label={t('deleteImport')} onClick={run}>
      <Trash2 size={14} />
    </Button>
  )
}
