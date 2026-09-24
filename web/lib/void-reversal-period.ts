'use client'

import { promptDialog } from './prompt'

export type VoidReversalPeriodCopy = {
  title: string
  label: string
  regularOption: string
  confirm: string
  cancel: string
}

export type VoidReversalPeriodChoice = {
  cancelled: boolean
  reversalPeriodId: string | null
}

type AdjustmentPeriod = {
  id: string
  name: string
  startsOn: string
  endsOn: string
}

/**
 * Ask the operator which period a void reversal posts into. Orgs without
 * adjustment periods get no choice — the reversal resolves by date in the
 * regular covering period, exactly as before. Resolves cancelled only when
 * the operator dismisses the choice. A failed lookup falls back to the
 * default instead of blocking the void: the void POST itself validates any
 * named override, so proceeding only ever reproduces today's behaviour.
 */
export async function promptVoidReversalPeriod(
  documentId: string,
  copy: VoidReversalPeriodCopy,
): Promise<VoidReversalPeriodChoice> {
  let periods: AdjustmentPeriod[] = []
  try {
    const res = await fetch(`/api/documents/${documentId}/void`)
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        adjustmentPeriods?: unknown
      } | null
      if (data && Array.isArray(data.adjustmentPeriods)) {
        periods = (data.adjustmentPeriods as Partial<AdjustmentPeriod>[]).filter(
          (period): period is AdjustmentPeriod =>
            !!period && typeof period.id === 'string' && typeof period.name === 'string',
        )
      }
    }
  } catch {
    periods = []
  }
  if (periods.length === 0) return { cancelled: false, reversalPeriodId: null }
  const chosen = await promptDialog({
    title: copy.title,
    label: copy.label,
    confirmLabel: copy.confirm,
    cancelLabel: copy.cancel,
    options: [
      { value: '', label: copy.regularOption },
      ...periods.map((period) => ({ value: period.id, label: period.name })),
    ],
  })
  if (chosen === null) return { cancelled: true, reversalPeriodId: null }
  return { cancelled: false, reversalPeriodId: chosen || null }
}
