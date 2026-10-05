'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { useMoney } from '@/components/money-provider'
import { readApiErrorMessage } from '@/lib/api-error'
import { promptDialog } from '@/lib/prompt'

type ActivePromotion = { id: string; code: string; name: string; kind: string }

/** Minor units (cents) to an exact major-unit decimal string. */
function minorToMajor(minor: string): string {
  const units = BigInt(minor)
  const sign = units < 0n ? '-' : ''
  const abs = units < 0n ? -units : units
  return `${sign}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`
}

async function readJson(res: Response) {
  return (await res.json()) as Record<string, unknown>
}

/**
 * Everyday promotion path for sales document drawers: pick an active
 * promotion (or type a code) and post it to the draft. The server computes
 * the discount lines; the drawer reload shows them with their promotion
 * chip, and nothing posts until the document itself is saved.
 */
export function PromotionApplyControl({ documentId, currency, disabled, onApplied }: {
  documentId: string
  currency: string
  disabled?: boolean
  onApplied: () => void
}) {
  const t = useTranslations('salesOrders')
  const { money } = useMoney(currency)
  const [busy, setBusy] = useState(false)

  async function apply() {
    if (busy) return
    setBusy(true)
    try {
      const listRes = await fetch('/api/promotions?active=1', { cache: 'no-store' })
      if (!listRes.ok) {
        toast.error(await readApiErrorMessage(listRes, t('promotion.loadFailed')))
        return
      }
      const listed = ((await readJson(listRes)).promotions ?? []) as ActivePromotion[]
      let code: string | null
      if (listed.length > 0) {
        code = await promptDialog({
          title: t('promotion.selectTitle'),
          label: t('promotion.selectLabel'),
          confirmLabel: t('promotion.apply'),
          options: [
            ...listed.map((promotion) => ({ value: promotion.code, label: `${promotion.code} — ${promotion.name}` })),
            { value: '', label: t('promotion.enterCode') },
          ],
        })
        if (code === '') {
          code = await promptDialog({
            title: t('promotion.codeTitle'),
            label: t('promotion.codeLabel'),
            confirmLabel: t('promotion.apply'),
          })
        }
      } else {
        code = await promptDialog({
          title: t('promotion.codeTitle'),
          label: t('promotion.codeLabel'),
          confirmLabel: t('promotion.apply'),
        })
      }
      if (!code) return
      const applyRes = await fetch(`/api/documents/${documentId}/apply-promotion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      if (!applyRes.ok) {
        toast.error(await readApiErrorMessage(applyRes, t('promotion.applyFailed')))
        return
      }
      const applied = await readJson(applyRes)
      const total = typeof applied.discountMinor === 'string' ? applied.discountMinor : '0'
      const count = Array.isArray(applied.lines) ? applied.lines.length : 0
      toast.success(t('promotion.applied', {
        code: typeof applied.code === 'string' ? applied.code : code,
        amount: money(minorToMajor(total)),
        count,
      }))
      onApplied()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={disabled || busy} onClick={apply}>
      {t('promotion.apply')}
    </Button>
  )
}
