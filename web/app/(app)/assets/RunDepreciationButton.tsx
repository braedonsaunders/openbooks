'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Play } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { RunDepreciationDrawer, type DepreciationBook, type DepreciationCandidate, type DepreciationPeriod } from './RunDepreciationDrawer'
/**
 * "Run depreciation" trigger — opens the review/confirm drawer. The button
 * never posts itself: preview and Confirm live inside RunDepreciationDrawer,
 * so every path (list-level, per-book asset menu) previews before posting.
 */
export function RunDepreciationButton({
  assetId,
  assetNumber,
  assetName,
  lockBookId,
  books,
  candidates,
  periods,
  variant,
  className,
  label,
}: {
  assetId?: string
  assetNumber?: string
  assetName?: string
  /** Asset-menu launch: preselect and lock the chosen book. */
  lockBookId?: string
  books: DepreciationBook[]
  candidates?: DepreciationCandidate[]
  periods: DepreciationPeriod[]
  variant?: 'default' | 'outline' | 'ghost'
  className?: string
  label?: string
}) {
  const t = useTranslations('assets')
  const [open, setOpen] = useState(false)

  return <>
    <Button variant={variant ?? (assetId ? 'outline' : 'default')} className={className} onClick={() => setOpen(true)}>
      {variant === 'ghost' ? null : <Play size={15} />}
      {label ?? t('list.runDepreciation')}
    </Button>
    {open ? <RunDepreciationDrawer
      books={books}
      candidates={candidates ?? []}
      periods={periods}
      lockAsset={assetId ? { id: assetId, number: assetNumber ?? '', name: assetName ?? '' } : undefined}
      lockBookId={lockBookId}
      open
      onClose={() => setOpen(false)}
      stacked={!!assetId}
    /> : null}
  </>
}
