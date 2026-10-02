'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Alert, Button, Drawer, Input, Label, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { useDirtyClose } from '../../../../lib/use-dirty-close'
import { canonicalDecimal } from '@openbooks/engine/money/decimal'
import {
  BENEFIT_AWARDS_API,
  validateAwardDraft,
  translatedFieldErrors,
  decimalFieldRefusal,
  type ProgramFamily,
  type AwardDraft,
  type AwardFieldErrors,
  type BuilderOption as PortfolioOption,
} from '../../../../lib/hrm/benefits-portfolio'

/**
 * New-award builder, opened through `award=new`. Records one award against
 * an active program: the recipient employment, the covered period, the
 * value in its currency, and first-class gift-card evidence — the reason,
 * a recipient note, and the provider's record reference. The value crosses
 * exactly as typed; the award service canonicalizes it and refuses
 * duplicates by source key, so a retried submit lands once. Delivery never
 * edits net pay: payroll programs settle through payroll inputs, external
 * programs use non-cash payroll inputs for tax treatment and retain
 * their provider fulfillment evidence. A provider reference alone never marks a payable award delivered.
 */

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">
      {message}
    </p>
  )
}

export function AwardBuilderDrawer({
  closeHref,
  programOptions,
  employmentOptions,
  initialProgramId = '',
}: {
  closeHref: string
  programOptions: (PortfolioOption & { currency: string; fixedAmount: string | null; family: ProgramFamily })[]
  employmentOptions: PortfolioOption[]
  initialProgramId?: string
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const initialProgram = programOptions.find(option => option.value === initialProgramId)
  const [initialDraft] = useState<AwardDraft>({
    programId: initialProgram?.value ?? '',
    employmentId: '',
    periodFrom: '',
    periodTo: '',
    value: initialProgram?.fixedAmount ?? '',
    currency: initialProgram?.currency ?? '',
    reason: '',
    recipientNote: '',
    recordReference: '',
  })
  const [draft, setDraft] = useState<AwardDraft>(initialDraft)
  const [errors, setErrors] = useState<AwardFieldErrors>({})
  const [saving, setSaving] = useState(false)
  const [sourceKey] = useState(() => `award:${crypto.randomUUID()}`)
  const selectedProgram = programOptions.find((option) => option.value === draft.programId)
  const isGrant = selectedProgram !== undefined && selectedProgram.family !== 'reward'

  function close() {
    router.push(closeHref as never)
    router.refresh()
  }

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initialDraft), [draft, initialDraft])
  const closeGuard = useDirtyClose({
    dirty,
    busy: saving,
    onClose: close,
    message: tCommon('feedback.unsavedChanges'),
    confirmLabel: tCommon('confirm.discardChanges'),
  })

  function set<K extends keyof AwardDraft>(key: K, value: AwardDraft[K]) {
    setDraft((current) => {
      const next = { ...current, [key]: value }
      if (key === 'programId') {
        const program = programOptions.find((option) => option.value === value)
        next.currency = program?.currency ?? ''
        next.value = program?.fixedAmount ?? ''
      }
      return next
    })
    setErrors((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  async function save() {
    const found = translatedFieldErrors(validateAwardDraft(draft), t)
    if (draft.value.trim() !== '' && canonicalDecimal(draft.value.trim(), 4) === null) {
      found.value = decimalFieldRefusal(draft.value.trim(), t('portfolio.awardFields.value'), t)
    }
    if (Object.keys(found).length > 0) {
      setErrors(found)
      toast.error(t('portfolio.builder.fixFields'))
      return
    }
    setSaving(true)
    try {
      const currency = draft.currency.trim().toUpperCase()
      const res = await fetch(BENEFIT_AWARDS_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          programId: draft.programId,
          employmentId: draft.employmentId,
          periodFrom: draft.periodFrom,
          periodTo: draft.periodTo === '' ? null : draft.periodTo,
          value: draft.value.trim(),
          currency,
          evidence: {
            reason: draft.reason.trim(),
            note: draft.recipientNote.trim() === '' ? null : draft.recipientNote.trim(),
            recordReference: draft.recordReference.trim() === '' ? null : draft.recordReference.trim(),
          },
          sourceKey,
        }),
      })
      // res.ok first, always: a refusal body is read only for its message.
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('portfolio.awardCreateFailed')))
        return
      }
      const body: unknown = await res.json().catch(() => null)
      const id =
        body !== null && typeof body === 'object' && 'award' in body &&
        body.award !== null && typeof body.award === 'object' && 'id' in body.award
          ? String((body.award as { id: unknown }).id)
          : null
      const params = new URLSearchParams(closeHref.split('?')[1] ?? '')
      params.delete('award')
      if (id) params.set('award', id)
      const query = params.toString()
      router.push(`${closeHref.split('?')[0]}${query ? `?${query}` : ''}` as never)
      router.refresh()
    } catch {
      toast.error(t('portfolio.awardCreateFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer open onClose={() => void closeGuard.close()} title={t(isGrant ? 'programWorkspace.createGrant' : 'portfolio.awardBuilderTitle')} size="md">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('portfolio.rewardCreateHint')}</p>
        <div>
          <Label htmlFor="award-builder-program">{t('portfolio.awardFields.program')}</Label>
          <Select
            id="award-builder-program"
            disabled={initialProgram !== undefined}
            value={draft.programId}
            onChange={(e) => set('programId', e.target.value)}
            aria-invalid={errors.programId !== undefined}
          >
            <option value="">{t('portfolio.builder.chooseProgram')}</option>
            {programOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <FieldError id="award-builder-programId-error" message={errors.programId} />
          {programOptions.length === 0 ? <Alert className="mt-2 flex flex-col gap-2">
            <p>{t('portfolio.rewardProgramPrerequisite')}</p>
            <div><Button asChild variant="outline" size="sm"><Link href="/hrm/benefits?view=programs&program=new&family=reward">{t('portfolio.createRewardProgram')}</Link></Button></div>
            <div><Button variant="outline" size="sm" onClick={() => router.refresh()}>{t('portfolio.builder.refreshOptions')}</Button></div>
          </Alert> : null}
        </div>
        <div>
          <Label htmlFor="award-builder-recipient">{t('portfolio.awardFields.recipient')}</Label>
          <Select
            id="award-builder-recipient"
            value={draft.employmentId}
            onChange={(e) => set('employmentId', e.target.value)}
            aria-invalid={errors.employmentId !== undefined}
          >
            <option value="">{t('portfolio.builder.chooseRecipient')}</option>
            {employmentOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <FieldError id="award-builder-employmentId-error" message={errors.employmentId} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="award-builder-from">{t('portfolio.awardFields.periodFrom')}</Label>
            <Input
              id="award-builder-from"
              type="date"
              value={draft.periodFrom}
              onChange={(e) => set('periodFrom', e.target.value)}
              aria-invalid={errors.periodFrom !== undefined}
            />
            <FieldError id="award-builder-periodFrom-error" message={errors.periodFrom} />
          </div>
          <div>
            <Label htmlFor="award-builder-to">{t('portfolio.awardFields.periodTo')}</Label>
            <Input
              id="award-builder-to"
              type="date"
              value={draft.periodTo}
              onChange={(e) => set('periodTo', e.target.value)}
              aria-invalid={errors.periodTo !== undefined}
            />
            <FieldError id="award-builder-periodTo-error" message={errors.periodTo} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="award-builder-value">{t('portfolio.awardFields.value')}</Label>
            <Input
              id="award-builder-value" readOnly={selectedProgram?.fixedAmount != null}
              inputMode="decimal"
              value={draft.value}
              onChange={(e) => set('value', e.target.value)}
              aria-invalid={errors.value !== undefined}
            />
            <FieldError id="award-builder-value-error" message={errors.value} />
          </div>
          <div>
            <Label id="award-builder-currency-label">{t('portfolio.awardFields.currency')}</Label>
            <div id="award-builder-currency" role="status" aria-labelledby="award-builder-currency-label" className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm dark:border-slate-700 dark:bg-slate-900">
              {draft.currency || '—'}
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('portfolio.awardCurrencyHint')}</p>
            <FieldError id="award-builder-currency-error" message={errors.currency} />
          </div>
        </div>
        <div>
          <Label htmlFor="award-builder-reason">{t('portfolio.awardFields.reason')}</Label>
          <Textarea
            id="award-builder-reason"
            value={draft.reason}
            onChange={(e) => set('reason', e.target.value)}
            placeholder={t('portfolio.awardFields.reasonPlaceholder')}
            aria-invalid={errors.reason !== undefined}
          />
          <FieldError id="award-builder-reason-error" message={errors.reason} />
        </div>
        <div>
          <Label htmlFor="award-builder-note">{t('portfolio.awardFields.recipientNote')}</Label>
          <Input id="award-builder-note" value={draft.recipientNote} onChange={(e) => set('recipientNote', e.target.value)} />
        </div>
        <div>
          <Label htmlFor="award-builder-reference">{t('portfolio.awardFields.recordReference')}</Label>
          <Input
            id="award-builder-reference"
            value={draft.recordReference}
            onChange={(e) => set('recordReference', e.target.value)}
            placeholder={t('portfolio.awardFields.recordReferencePlaceholder')}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('portfolio.awardFields.recordReferenceHint')}</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => void closeGuard.close()}>
            {t('portfolio.builder.cancel')}
          </Button>
          <Button disabled={saving} onClick={save}>
            {t(isGrant ? 'programWorkspace.createGrant' : 'portfolio.awardCreate')}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
