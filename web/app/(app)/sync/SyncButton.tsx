'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

export function SyncButton({ source, label }: { source: string; label: string }) {
  const t = useTranslations('sync')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function sync() {
    setBusy(true)
    const id = toast.loading(t('button.syncing', { source: label }))
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      const tb = data.tb
      const summary = t('toast.summary', {
        newEntries: data.newEntries,
        reversedEntries: data.reversedEntries,
        unchanged: data.unchanged,
        matches: tb.matches,
        accounts: tb.accounts,
        mismatches: tb.mismatches.length,
      })
      if (tb.mismatches.length) toast.error(summary, { id, duration: 10_000 })
      else
        toast.success(
          t('toast.synced', { seconds: (data.durationMs / 1000).toFixed(1), summary }),
          { id, duration: 8_000 },
        )
      router.refresh()
    } catch (e) {
      toast.error(t('toast.syncFailed', { detail: (e as Error).message }), { id })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button onClick={sync} disabled={busy}>
      <RefreshCw size={15} className={busy ? 'animate-spin' : undefined} />
      {busy ? t('button.syncing', { source: label }) : t('button.sync', { source: label })}
    </Button>
  )
}
