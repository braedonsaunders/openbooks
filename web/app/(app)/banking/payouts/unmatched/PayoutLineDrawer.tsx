'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button } from '@openbooks/ui'
import { DisclosureSection } from '@openbooks/ui'
import {
  ActionError,
  classifiedError,
  readActionResult,
  transportError,
} from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import { readApiErrorMessage } from '@/lib/api-error'
import { confirmDialog } from '@/lib/confirm'

export interface PayoutLineDrawerData {
  id: string
  providerLabel: string
  kindLabel: string
  /** Null when the line carries no usable currency: the row is omitted rather than mispriced. */
  amount: string | null
  externalRef: string | null
  description: string | null
  batchRef: string
  settledDate: string
  canDecide: boolean
  strings: {
    kindRow: string
    amountRow: string
    referenceRow: string
    descriptionRow: string
    batchRow: string
    settledRow: string
    proposalTitle: string
    proposalLoading: string
    proposalFailed: string
    evidenceTitle: string
    applyLabel: string
    confirmTitle: string
  }
}

interface PayoutCandidate {
  rank: number
  kind: 'link_document' | 'manual'
  label: string
  detail: string
  confidence: 'high' | 'medium' | 'low'
  evidence: string[]
}

interface PayoutSuggestion {
  lineId: string
  code: string
  candidates: PayoutCandidate[]
  similarCount: number
  explanation: string
}

function confidenceVariant(confidence: string): 'success' | 'secondary' | 'outline' {
  if (confidence === 'high') return 'success'
  if (confidence === 'medium') return 'secondary'
  return 'outline'
}

/**
 * One unmatched settlement line with its proposed link. Everyday depth is
 * the top candidate with Apply; the candidate list is the configure depth;
 * evidence and the link consequence sit inside a collapsed advanced
 * section. Approving asks for confirmation first and links through the
 * settlement link writer, which re-validates the document.
 */
export function PayoutLineDrawer({ line }: { line: PayoutLineDrawerData }) {
  const { strings } = line
  const t = useTranslations('banking.pspUnmatched')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const [suggestion, setSuggestion] = React.useState<PayoutSuggestion | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [rank, setRank] = React.useState(0)

  React.useEffect(() => {
    let live = true
    fetch(`/api/psp/settlement-lines/${line.id}/suggestion`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          if (live) setLoadError(await readApiErrorMessage(res, strings.proposalFailed))
          return
        }
        const body = (await res.json()) as { suggestion: PayoutSuggestion }
        if (live) {
          setSuggestion(body.suggestion)
          setRank(0)
        }
      })
      .catch(() => {
        if (live) setLoadError(strings.proposalFailed)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [line.id, strings.proposalFailed])

  const candidate = suggestion?.candidates[rank] ?? null

  const onApprove = async (applyToSimilar: boolean) => {
    if (!suggestion || !candidate || candidate.kind === 'manual') return
    const confirmed = await confirmDialog({
      title: strings.confirmTitle,
      message: t('assistance.confirmBody', {
        fix: candidate.detail,
        count: applyToSimilar ? suggestion.similarCount : 1,
      }),
      confirmLabel: strings.applyLabel,
    })
    if (!confirmed) return
    await execute(
      async () => {
        let res: Response
        try {
          res = await fetch(`/api/psp/settlement-lines/${line.id}/approve`, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rank, applyToSimilar }),
          })
        } catch (error) {
          return { ok: false as const, error: transportError(error instanceof Error ? error.message : String(error)) }
        }
        if (!res.ok) {
          return {
            ok: false as const,
            error: new ActionError({
              kind: classifiedError(res.status).kind,
              status: res.status,
              serverMessage: await readApiErrorMessage(res, strings.applyLabel),
            }),
          }
        }
        return readActionResult<{ applied: string; linked: { lineId: string }[]; skipped: number }>(res)
      },
      {
        fallbackMessage: strings.applyLabel,
        onOk: (outcome) => {
          router.refresh()
          toast.success(t('assistance.approved', { linked: outcome.linked.length, skipped: outcome.skipped }))
        },
      },
    )
  }

  const rows: [string, string | null][] = [
    [strings.kindRow, line.kindLabel],
    [strings.amountRow, line.amount],
    [strings.referenceRow, line.externalRef],
    [strings.descriptionRow, line.description],
    [strings.batchRow, line.batchRef],
    [strings.settledRow, line.settledDate],
  ]

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white">{line.providerLabel}</h3>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) =>
          value ? (
            <div key={label} className="contents">
              <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ) : null,
        )}
      </dl>
      <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-white">{strings.proposalTitle}</h4>
        {loading ? (
          <p className="mt-2 text-sm text-slate-500">{strings.proposalLoading}</p>
        ) : loadError || !suggestion || !candidate ? (
          <p className="mt-2 text-sm text-slate-500">{loadError ?? strings.proposalFailed}</p>
        ) : (
          <>
            <ActionAlert error={refusal} fallbackMessage={strings.applyLabel} />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant={candidate.kind === 'manual' ? 'warning' : confidenceVariant(candidate.confidence)}>
                {candidate.label}
              </Badge>
              {suggestion.similarCount > 1 ? (
                <span className="text-xs text-slate-500">
                  {t('assistance.similar', { count: suggestion.similarCount })}
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">{suggestion.explanation}</p>
            {suggestion.candidates.length > 1 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {suggestion.candidates.map((entry) => (
                  <Button
                    key={entry.rank}
                    size="sm"
                    variant={entry.rank === rank ? 'default' : 'outline'}
                    disabled={busy}
                    onClick={() => setRank(entry.rank)}
                  >
                    {entry.label}
                  </Button>
                ))}
              </div>
            ) : null}
            <DisclosureSection
              title={strings.evidenceTitle}
              summary={t('assistance.evidenceSummary', { count: candidate.evidence.length })}
            >
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
                {candidate.evidence.map((entry, index) => (
                  <li key={index}>{entry}</li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-slate-500">{candidate.detail}</p>
            </DisclosureSection>
            {line.canDecide && candidate.kind !== 'manual' ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => onApprove(false)}>
                  {strings.applyLabel}
                </Button>
                {suggestion.similarCount > 1 ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onApprove(true)}>
                    {t('assistance.applySimilar', { count: suggestion.similarCount })}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
