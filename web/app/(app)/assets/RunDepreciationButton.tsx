'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { money } from '../../../lib/format'

/**
 * List-level "Run depreciation" — posts all due, unposted period entries
 * through the kernel (assets.manage). Idempotent, so a repeat click that finds
 * nothing due simply reports zero.
 */
export function RunDepreciationButton({ assetId }: { assetId?: string } = {}) {
  const t = useTranslations('assets')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    const res = await fetch('/api/assets/run-depreciation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(assetId ? { assetId } : {}),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('drawer.runFailed'))
      setBusy(false)
      return
    }
    if (data.posted > 0) {
      toast.success(
        t('run.posted', { count: data.posted, amount: money(data.totalAmount) }) +
          (data.skipped > 0 ? ` · ${t('run.someSkipped', { count: data.skipped })}` : ''),
      )
    } else {
      toast.message(t('run.nothingDue') + (data.skipped > 0 ? ` · ${t('run.someSkipped', { count: data.skipped })}` : ''))
    }
    if (Array.isArray(data.problems) && data.problems.length) {
      for (const p of data.problems.slice(0, 3)) toast.warning(String(p))
    }
    setBusy(false)
    router.refresh()
  }

  return (
    <Button variant={assetId ? 'outline' : 'default'} onClick={run} disabled={busy}>
      <Play size={15} /> {t('list.runDepreciation')}
    </Button>
  )
}
