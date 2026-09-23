'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'
import { promptDialog } from '@/lib/prompt'

/**
 * Reconcile one legacy-provenance obligation: the operator attests the
 * existing schedule against the policy in force at creation, lifting the
 * rebuild refusal for that obligation only. The refusal names this action;
 * the reason it collects is the audit evidence.
 */
export function ReconcileLegacyButton({ obligationId }: { obligationId: string }) {
  const t = useTranslations('revenue')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function reconcile() {
    const reason = await promptDialog({
      title: t('drawer.reconcileTitle'),
      label: t('drawer.reconcileReason'),
      placeholder: t('drawer.reconcilePlaceholder'),
      confirmLabel: t('drawer.reconcileConfirm'),
    })
    if (!reason) return
    setBusy(true)
    try {
      const res = await fetch(`/api/revenue/obligations/${obligationId}/reconcile-legacy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('drawer.reconcileFailed')))
        return
      }
      toast.success(t('drawer.reconciled'))
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="outline" onClick={reconcile} disabled={busy}>
      {t('drawer.reconcile')}
    </Button>
  )
}
