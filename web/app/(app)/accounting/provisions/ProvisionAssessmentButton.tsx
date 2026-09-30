'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, SearchSelect, Select, Textarea } from '@openbooks/ui'
import type { ProvisionIdentity, ProvisionEstimate, provisionEditorOptions, readProvisionObligation } from '@openbooks/engine/provisions'
import { PagedTable } from '@/components/paged-table'
import { MoneyInput, moneyFieldError } from '@/components/money-input'
import { useBusinessToday } from '@/components/business-date-provider'
import { useDirtyClose } from '@/lib/use-dirty-close'
import { readApiErrorMessage } from '@/lib/api-error'

type Choices = Awaited<ReturnType<typeof provisionEditorOptions>>

export function ProvisionAssessmentHistory({ assessments }: { assessments: Awaited<ReturnType<typeof readProvisionObligation>>['assessments'] }) {
  const t = useTranslations('accounting.provisions'), accounting = useTranslations('accounting.lifecycle')
  return <PagedTable rows={assessments} rowKey={row => row.id} empty={t('noAssessments')} columns={[
    { key: 'date', header: t('date'), cell: row => <Link href={`/accounting/changes?change=${row.id}`}>{row.effectiveOn}</Link> },
    { key: 'reason', header: t('reason'), cell: row => row.reason, search: row => row.reason },
    { key: 'status', header: t('status'), cell: row => accounting(row.status) },
  ]} searchable />
}
/** The asset accounting-change editor's native Drawer, account pickers and
 * dirty-close guard, with a PagedTable for expected-value settlement outcomes. */
export function ProvisionAssessmentButton({ options, identity }: { options: Choices; identity?: ProvisionIdentity }) {
  const t = useTranslations('accounting.provisions'), common = useTranslations('common')
  const today = useBusinessToday(), router = useRouter()
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({ date: today, method: 'best_estimate' })
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID()), [initialKey, setInitialKey] = useState(requestKey)
  const [obligationId, setObligationId] = useState(() => identity?.id ?? crypto.randomUUID())
  const [outcomes, setOutcomes] = useState<{ id: string; amount: string; probability: string }[]>([])
  const update = (key: string, value: string) => { setValues(current => ({ ...current, [key]: value })); setRequestKey(crypto.randomUUID()) }
  const updateOutcomes = (rows: typeof outcomes) => { setOutcomes(rows); setRequestKey(crypto.randomUUID()) }
  const close = () => {
    setOpen(false); setValues({ date: today, method: 'best_estimate' }); setOutcomes([]); setError(null)
    const next = crypto.randomUUID(); setRequestKey(next); setInitialKey(next); setObligationId(identity?.id ?? crypto.randomUUID())
  }
  const closeGuard = useDirtyClose({ dirty: requestKey !== initialKey, busy, onClose: close,
    message: common('feedback.unsavedChanges'), confirmLabel: common('confirm.discardChanges') })
  const needsEstimate = values.obligation === 'yes' && values.outflow === 'probable' && values.estimable === 'yes'
  const moneyInvalid = needsEstimate && (values.method === 'best_estimate'
    ? moneyFieldError(t('estimate'), 'a money amount', values.amount ?? '', 4, { required: true }) !== null
    : values.method === 'expected_value'
      ? outcomes.length === 0 || outcomes.some(row => moneyFieldError(t('estimate'), 'a money amount', row.amount, 4, { required: true }) || moneyFieldError(t('probability'), 'a probability', row.probability, 4, { required: true }))
      : ['minimum', 'maximum'].some(key => moneyFieldError(t(key), 'a money amount', values[key] ?? '', 4, { required: true })))
  async function save() {
    setBusy(true); setError(null)
    try {
      const entity = options.subsidiaries.find(row => row.id === values.subsidiary)
      const obligation = identity ?? { id: obligationId, name: values.name, subsidiaryId: values.subsidiary, currency: entity?.currency,
        bookId: values.book, expenseAccountId: values.expense, liabilityAccountId: values.liability }
      const estimate: ProvisionEstimate | null = !needsEstimate ? null : values.method === 'best_estimate'
        ? { method: 'best_estimate', amount: values.amount ?? '' }
        : values.method === 'expected_value' ? { method: 'expected_value', outcomes: outcomes.map(({ amount, probability }) => ({ amount, probability })) }
        : { method: values.method === 'uniform_range' ? 'uniform_range' : 'no_better_estimate_range', minimum: values.minimum ?? '', maximum: values.maximum ?? '' }
      const response = await fetch('/api/accounting/provisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        obligation, effectiveOn: values.date, reason: values.reason, idempotencyKey: requestKey,
        assessment: { presentObligation: values.obligation === 'yes', outflow: values.outflow,
          reliablyEstimable: values.estimable === 'yes', evidence: values.evidence, discounting: values.discounting,
          discountEvidence: values.discountEvidence, estimate },
      }) })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('failed')))
      const result = await response.json() as { id: string }
      close(); router.push(`/accounting/changes?change=${result.id}`); router.refresh()
    } catch (caught) { const message = caught instanceof Error ? caught.message : t('failed'); setError(message); toast.error(message) }
    finally { setBusy(false) }
  }
  const yesNo = (key: string) => <div className="space-y-1"><Label htmlFor={`provision-${key}`}>{t(key)}</Label>
    <Select id={`provision-${key}`} value={values[key] ?? ''} onChange={event => update(key, event.target.value)}>
      <option value="">{t('choose')}</option><option value="yes">{common('labels.yes')}</option><option value="no">{common('labels.no')}</option>
    </Select></div>
  const picker = (key: string, rows: { id: string; name: string }[]) => <div className="space-y-1"><Label>{t(key)}</Label>
    <SearchSelect ariaLabel={t(key)} value={values[key] ?? ''} onChange={value => update(key, value)} options={rows.map(row => ({ value: row.id, label: row.name }))} placeholder={t('choose')} />
  </div>
  return <>
    <Button onClick={() => setOpen(true)}>{identity ? t('review') : t('new')}</Button>
    {open ? <Drawer open onClose={closeGuard.close} title={identity ? t('review') : t('new')} size="2xl">
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">{t('approvalHint')}</p>
        {identity ? <p className="font-medium">{identity.name} · {identity.currency}</p> : <>
          <div className="space-y-1"><Label htmlFor="provision-name">{t('name')}</Label><Input id="provision-name" value={values.name ?? ''} onChange={event => update('name', event.target.value)} maxLength={200} /></div>
          <div className="grid gap-3 sm:grid-cols-2">{picker('subsidiary', options.subsidiaries)}{picker('book', options.books)}
            {picker('expense', options.accounts.filter(row => ['expense', 'expense_other'].includes(row.type)))}
            {picker('liability', options.accounts.filter(row => ['liability_current_other', 'liability_long_term'].includes(row.type)))}</div>
        </>}
        <div className="space-y-1"><Label htmlFor="provision-date">{t('date')}</Label><Input id="provision-date" type="date" value={values.date ?? ''} onChange={event => update('date', event.target.value)} /></div>
        <div className="grid gap-3 sm:grid-cols-2">{yesNo('obligation')}{yesNo('estimable')}
          <div className="space-y-1"><Label htmlFor="provision-outflow">{t('outflow')}</Label><Select id="provision-outflow" value={values.outflow ?? ''} onChange={event => update('outflow', event.target.value)}>
            <option value="">{t('choose')}</option>{['probable', 'possible', 'remote'].map(value => <option key={value} value={value}>{t(value)}</option>)}
          </Select></div>
        </div>
        <div className="space-y-1"><Label htmlFor="provision-evidence">{t('evidence')}</Label><Textarea id="provision-evidence" value={values.evidence ?? ''} onChange={event => update('evidence', event.target.value)} maxLength={10000} /></div>
        {needsEstimate ? <>
          <div className="space-y-1"><Label htmlFor="provision-method">{t('method')}</Label><Select id="provision-method" value={values.method ?? 'best_estimate'} onChange={event => update('method', event.target.value)}>
            {(options.reportingFramework === 'ifrs' ? ['best_estimate', 'expected_value', 'uniform_range'] : ['best_estimate', 'no_better_estimate_range']).map(value => <option key={value} value={value}>{t(value)}</option>)}
          </Select></div>
          {values.method === 'best_estimate' ? <MoneyInput value={values.amount ?? ''} onChange={value => update('amount', value)} field={t('estimate')} ariaLabel={t('estimate')} required />
            : values.method === 'expected_value' ? <PagedTable rows={outcomes} rowKey={row => row.id} empty={t('noOutcomes')}
              toolbarAfter={<Button variant="outline" onClick={() => updateOutcomes([...outcomes, { id: crypto.randomUUID(), amount: '', probability: '' }])}>{t('addOutcome')}</Button>}
              columns={[
                { key: 'amount', header: t('estimate'), cell: row => <MoneyInput value={row.amount} field={t('estimate')} ariaLabel={t('estimate')} required onChange={value => updateOutcomes(outcomes.map(current => current.id === row.id ? { ...current, amount: value } : current))} /> },
                { key: 'probability', header: t('probability'), cell: row => <MoneyInput value={row.probability} field={t('probability')} ariaLabel={t('probability')} required onChange={value => updateOutcomes(outcomes.map(current => current.id === row.id ? { ...current, probability: value } : current))} /> },
                { key: 'remove', header: common('labels.actions'), cell: row => <Button variant="ghost" onClick={() => updateOutcomes(outcomes.filter(current => current.id !== row.id))}>{common('actions.remove')}</Button> },
              ]} />
            : <div className="grid gap-3 sm:grid-cols-2">{['minimum', 'maximum'].map(key => <MoneyInput key={key} value={values[key] ?? ''} onChange={value => update(key, value)} field={t(key)} ariaLabel={t(key)} required />)}</div>}
        </> : <p className="text-sm text-muted-foreground">{t('unrecognizedHint')}</p>}
        <div className="space-y-1"><Label htmlFor="provision-discounting">{t('discounting')}</Label><Select id="provision-discounting" value={values.discounting ?? ''} onChange={event => update('discounting', event.target.value)}>
          <option value="">{t('choose')}</option><option value="immaterial">{t('immaterial')}</option>
          {options.reportingFramework === 'ifrs' ? <option value="included_in_estimate">{t('included_in_estimate')}</option> : <option value="undiscounted">{t('undiscounted')}</option>}
        </Select></div>
        <div className="space-y-1"><Label htmlFor="provision-discount-evidence">{t('discountEvidence')}</Label><Textarea id="provision-discount-evidence" value={values.discountEvidence ?? ''} onChange={event => update('discountEvidence', event.target.value)} maxLength={10000} /></div>
        <div className="space-y-1"><Label htmlFor="provision-reason">{t('reason')}</Label><Textarea id="provision-reason" value={values.reason ?? ''} onChange={event => update('reason', event.target.value)} maxLength={1000} /></div>
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
        <div className="flex gap-2"><Button disabled={busy || moneyInvalid || !values.obligation || !values.estimable || !values.outflow || !values.discounting
          || (values.evidence?.trim().length ?? 0) < 20 || (values.discountEvidence?.trim().length ?? 0) < 20 || (values.reason?.trim().length ?? 0) < 8
          || (!identity && (!values.name?.trim() || !values.subsidiary || !values.book || !values.expense || !values.liability))} onClick={() => void save()}>{t('propose')}</Button>
          <Button variant="outline" disabled={busy} onClick={closeGuard.close}>{common('actions.cancel')}</Button></div>
      </div>
    </Drawer> : null}
  </>
}
