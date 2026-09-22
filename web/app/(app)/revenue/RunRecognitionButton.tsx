'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Play } from 'lucide-react'
import { Button } from '@openbooks/ui'
import {
  RunRecognitionDrawer,
  type RecognitionBook,
  type RecognitionCandidate,
  type RecognitionPeriod,
} from './RunRecognitionDrawer'

/**
 * "Run recognition" — opens the review drawer. Clicking writes nothing: the
 * drawer previews the exact balanced entries for the chosen scope (as-of
 * date, book, period, contract, obligation) and only its Confirm posts,
 * carrying the preview fingerprint so the run refuses a stale review.
 */
export function RunRecognitionButton({
  obligationId,
  obligationDescription,
  books = [],
  periods = [],
  candidates = [],
  variant,
  label,
}: {
  /** Obligation-level launch from the contract drawer: scope is fixed. */
  obligationId?: string
  obligationDescription?: string
  books?: RecognitionBook[]
  periods?: RecognitionPeriod[]
  candidates?: RecognitionCandidate[]
  variant?: 'default' | 'outline' | 'ghost'
  label?: string
}) {
  const t = useTranslations('revenue')
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant={variant ?? (obligationId ? 'outline' : 'default')} onClick={() => setOpen(true)}>
        <Play size={15} /> {label ?? t('list.runRecognition')}
      </Button>
      {open ? (
        <RunRecognitionDrawer
          books={books}
          periods={periods}
          candidates={candidates}
          lockObligation={
            obligationId
              ? { id: obligationId, description: obligationDescription ?? '' }
              : undefined
          }
          open={open}
          onClose={() => setOpen(false)}
          stacked={Boolean(obligationId)}
        />
      ) : null}
    </>
  )
}
