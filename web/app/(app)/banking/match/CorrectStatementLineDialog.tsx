'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Label } from '@openbooks/ui'

/**
 * Correct one unmatched statement line's amount, sign, date or description.
 * The engine refuses matched, excluded and signed-off-history lines with
 * named remedies; a refusal persists as a dialog-level alert (the
 * ImportStatementButton pattern), cleared on the next edit. Saving an
 * unchanged form is a no-op the engine answers without writing.
 */
export function CorrectStatementLineDialog({
  line,
  onClose,
  onSaved,
}: {
  line: { id: string; posted_on: string; amount: string; description: string | null }
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('banking.match')
  const tCommon = useTranslations('common')
  const tBanking = useTranslations('banking')
  const [amount, setAmount] = useState(line.amount)
  const [postedOn, setPostedOn] = useState(line.posted_on)
  const [description, setDescription] = useState(line.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cleanDescription = description.trim() === '' ? null : description.trim()
  const dirty =
    amount.trim() !== line.amount ||
    postedOn !== line.posted_on ||
    cleanDescription !== (line.description ?? null)

  async function save() {
    if (!dirty || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/banking/statement-lines/${line.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'correct',
          amount: amount.trim(),
          postedOn,
          description: cleanDescription,
        }),
      })
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null
      if (!res.ok) {
        setError(typeof data?.error === 'string' && data.error ? data.error : tBanking('errors.requestFailed'))
        return
      }
      onSaved()
    } catch {
      setError(tBanking('errors.requestFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="sm"
      title={t('correctTitle')}
      description={t('correctHint')}
      headerActions={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
          <Button disabled={busy || !dirty} onClick={save}>
            {t('correctSave')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="correct-line-amount">{tCommon('labels.amount')}</Label>
          <Input
            id="correct-line-amount"
            disabled={busy}
            value={amount}
            inputMode="decimal"
            onChange={(e) => {
              setAmount(e.target.value)
              setError(null)
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="correct-line-date">{tCommon('labels.date')}</Label>
          <Input
            id="correct-line-date"
            type="date"
            disabled={busy}
            value={postedOn}
            onChange={(e) => {
              setPostedOn(e.target.value)
              setError(null)
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="correct-line-description">{tCommon('labels.description')}</Label>
          <Input
            id="correct-line-description"
            disabled={busy}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
              setError(null)
            }}
          />
        </div>
      </div>
    </Drawer>
  )
}
