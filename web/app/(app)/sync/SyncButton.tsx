'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

export function SyncButton({ source, label }: { source: string; label: string }) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function sync() {
    setBusy(true)
    const id = toast.loading(`Syncing from ${label}…`)
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      const tb = data.tb
      const summary =
        `${data.newEntries} new · ${data.reversedEntries} reversed · ${data.unchanged} unchanged — ` +
        `TB ${tb.matches}/${tb.accounts}` +
        (tb.mismatches.length ? ` (${tb.mismatches.length} MISMATCHES)` : ' exact')
      if (tb.mismatches.length) toast.error(summary, { id, duration: 10_000 })
      else toast.success(`Synced in ${(data.durationMs / 1000).toFixed(1)}s — ${summary}`, { id, duration: 8_000 })
      router.refresh()
    } catch (e) {
      toast.error(`Sync failed: ${(e as Error).message}`, { id })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button onClick={sync} disabled={busy}>
      <RefreshCw size={15} className={busy ? 'animate-spin' : undefined} />
      {busy ? `Syncing from ${label}…` : `Sync from ${label}`}
    </Button>
  )
}
