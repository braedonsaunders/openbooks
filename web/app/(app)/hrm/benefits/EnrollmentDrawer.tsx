'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, Select, Textarea } from '@openbooks/ui'
import { TransactionDrawer } from '../../../../components/transaction-drawer'
import { BenefitContributionChoices, type BenefitElectionRule, type ContributionChoice } from '../../me/islands'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { promptDialog } from '../../../../lib/prompt'
import { useDirtyClose } from '../../../../lib/use-dirty-close'

export interface EnrollmentDrawerRecord {
  id: string
  employeeName: string
  planName: string
  currency: string
  status: string
  statusLabel: string
  effectiveFrom: string
  effectiveTo: string | null
  classKey: string | null
  matchEligible: boolean | null
  classes: { value: string; label: string }[]
  rules: BenefitElectionRule[]
  terms: { ruleId: string; electionMode: 'fixed' | 'follows_policy'; electedRate: string | null; declaredPeriodsPerYear: number | null }[]
  approvalHref: string | null
}

/** Submitted elections change through a dated successor; this drawer never overwrites their history. */
export function EnrollmentDrawer({ record, closeHref, canManage, canChange, stacked = false, onSaved }: {
  record: EnrollmentDrawerRecord; closeHref: string; canManage: boolean; canChange: boolean; stacked?: boolean; onSaved?: () => void
}) {
  const t = useTranslations('hrm.enrollmentRecord')
  const common = useTranslations('common')
  const setup = useTranslations('admin.setup')
  const router = useRouter()
  const initialChoices = () => Object.fromEntries(record.terms.map(term => [term.ruleId, {
    electionMode: term.electionMode, electedRate: term.electedRate ?? '',
    declaredPeriodsPerYear: term.declaredPeriodsPerYear == null ? '' : String(term.declaredPeriodsPerYear),
  }]))
  const [mode, setMode] = useState<'view' | 'edit' | 'end'>('view')
  const [tab, setTab] = useState('details')
  const [choices, setChoices] = useState<Record<string, ContributionChoice>>(initialChoices)
  const [classKey, setClassKey] = useState(record.classKey ?? '')
  const [matchEligible, setMatchEligible] = useState(record.matchEligible == null ? '' : String(record.matchEligible))
  const [date, setDate] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = mode !== 'view' && (date !== '' || reason !== '' || classKey !== (record.classKey ?? '') || matchEligible !== (record.matchEligible == null ? '' : String(record.matchEligible)) || JSON.stringify(choices) !== JSON.stringify(initialChoices()))
  const guard = useDirtyClose({ dirty, busy, onClose: () => router.push(closeHref), message: common('feedback.unsavedChanges'), confirmLabel: common('confirm.discardChanges') })
  const selectedRules = record.rules.filter(rule => Object.hasOwn(choices, rule.value))
  const editable = mode === 'edit'
  const canEnd = canManage && record.status === 'active'
  const canCancel = canManage && ['elected', 'pending_approval'].includes(record.status)
  async function cancelEdit() {
    if (!await guard.beforeClose()) return
    setChoices(initialChoices()); setClassKey(record.classKey ?? ''); setMatchEligible(record.matchEligible == null ? '' : String(record.matchEligible))
    setDate(''); setReason(''); setError(null); setMode('view')
  }
  async function act(body: Record<string, unknown>) {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const response = await fetch(`/api/hrm/enrollments/${encodeURIComponent(record.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) { setError(await readApiErrorMessage(response, t('failed'))); return }
      const result = await response.json() as { enrollment: { id: string } }
      if (typeof result.enrollment?.id !== 'string') throw new Error('Invalid enrollment response')
      setMode('view'); setDate(''); setReason('')
      onSaved?.()
      router.replace(stacked ? closeHref : `/hrm/benefits?view=employees&enrollmentConfig=${encodeURIComponent(result.enrollment.id)}`)
      router.refresh()
    } catch { setError(t('failed')) } finally { setBusy(false) }
  }
  function save() {
    if (!date || !reason.trim()) { setError(t('dateReasonRequired')); return }
    if (mode === 'end') { void act({ action: 'end', endedOn: date, reason: reason.trim() }); return }
    if (date <= record.effectiveFrom) { setError(t('laterDateRequired', { date: record.effectiveFrom })); return }
    if (record.rules.length > 0 && !selectedRules.length || selectedRules.some(rule => !choices[rule.value]?.electionMode || (choices[rule.value]?.electionMode === 'fixed' && !choices[rule.value]?.electedRate.trim()))) { setError(t('termsRequired')); return }
    if (selectedRules.some(rule => rule.effectiveFrom > date || (rule.effectiveTo !== null && rule.effectiveTo < date))) { setError(t('rulesNotEffective')); return }
    if (selectedRules.some(rule => rule.requiresMatchEligibility) && matchEligible === '') { setError(setup('validation.required', { field: setup('fields.matchEligible') })); return }
    void act({ action: 'change', changeDate: date, reason: reason.trim(), classKey: classKey || null, matchEligible: matchEligible === '' ? null : matchEligible === 'true',
      contributionTerms: selectedRules.length ? selectedRules.map(rule => ({ ruleId: rule.value, electionMode: choices[rule.value]!.electionMode,
        electedRate: choices[rule.value]!.electionMode === 'fixed' ? choices[rule.value]!.electedRate : null,
        declaredPeriodsPerYear: choices[rule.value]!.declaredPeriodsPerYear ? Number(choices[rule.value]!.declaredPeriodsPerYear) : null,
      })) : undefined,
    })
  }
  const elections = <div className="space-y-4">
    {editable ? <p className="text-sm text-slate-500">{t('changeHint')}</p> : null}
    <BenefitContributionChoices rules={selectedRules} choices={choices} readOnly={!editable || busy} onRemove={editable && !busy && selectedRules.length > 1 ? id => setChoices(current => { const next = { ...current }; delete next[id]; return next }) : undefined} onChange={(id, choice) => { setError(null); setChoices(current => ({ ...current, [id]: choice })) }} />
    {editable ? <>
      <Label htmlFor="enrollment-add-contribution">{t('addContribution')}</Label>
      <Select id="enrollment-add-contribution" value="" disabled={busy} onChange={event => { const id = event.target.value; if (id) setChoices(current => ({ ...current, [id]: { electionMode: 'fixed', electedRate: '' } })) }}>
        <option value="">{t('chooseContribution')}</option>
        {record.rules.filter(rule => !Object.hasOwn(choices, rule.value)).map(rule => <option key={rule.value} value={rule.value}>{rule.label}</option>)}
      </Select>
    </> : null}
  </div>
  return <TransactionDrawer stacked={stacked} recordId={record.id} targetTable="hrm_benefit_enrollments" showAttachments={false} closeHref={closeHref} beforeClose={guard.beforeClose}
    title={<span className="flex items-center gap-2">{record.employeeName}<Badge>{record.statusLabel}</Badge></span>}
    description={record.planName} activeTab={tab} onActiveTabChange={setTab} keepChildrenMounted
    detailTabs={[{ key: 'contributions', label: t('contributions'), content: elections }]}
    primaryAction={mode === 'view' ? canManage && canChange && record.status === 'active' ? <Button variant="outline" size="sm" disabled={busy} onClick={() => { setMode('edit'); setTab('contributions'); setError(null) }}>{common('actions.edit')}</Button> : null : <>
      <Button size="sm" disabled={busy} onClick={save}>{busy ? common('actions.saving') : mode === 'end' ? t('end') : common('actions.save')}</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void cancelEdit()}>{common('actions.cancel')}</Button>
    </>}
    actions={mode === 'view' && (canEnd || canCancel || record.approvalHref) ? <>
      {record.approvalHref ? <Button asChild variant="ghost"><a href={record.approvalHref}>{t('approvals')}</a></Button> : null}
      {canEnd ? <Button variant="ghost" disabled={busy} onClick={() => { setMode('end'); setTab('details'); setError(null) }}>{t('end')}</Button> : null}
      {canCancel ? <Button variant="ghost" disabled={busy} onClick={async () => { const value = await promptDialog({ title: t('cancel'), label: t('reason'), confirmLabel: t('cancel') }); if (value?.trim()) await act({ action: 'cancel', reason: value.trim() }) }}>{t('cancel')}</Button> : null}
    </> : null}
    footer={mode !== 'view' || error ? <div className="w-full space-y-3">
      {mode !== 'view' ? <div className="grid gap-3 sm:grid-cols-2">
        <div><Label htmlFor="enrollment-change-date">{t('effectiveDate')}</Label><Input id="enrollment-change-date" type="date" disabled={busy} min={record.effectiveFrom} value={date} onChange={event => { setDate(event.target.value); setError(null) }} /></div>
        <div><Label htmlFor="enrollment-change-reason">{t('reason')}</Label><Textarea id="enrollment-change-reason" disabled={busy} value={reason} onChange={event => { setReason(event.target.value); setError(null) }} /></div>
      </div> : null}
      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div> : undefined}>
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-2">
        <div><dt className="text-xs text-slate-500">{t('plan')}</dt><dd>{record.planName}</dd></div>
        <div><dt className="text-xs text-slate-500">{t('currency')}</dt><dd>{record.currency}</dd></div>
        <div><dt className="text-xs text-slate-500">{t('from')}</dt><dd>{record.effectiveFrom}</dd></div>
        <div><dt className="text-xs text-slate-500">{t('to')}</dt><dd>{record.effectiveTo ?? '—'}</dd></div>
      </dl>
      {record.classes.length ? <div><Label htmlFor="enrollment-class">{setup('fields.classKey')}</Label>{editable ? <Select id="enrollment-class" value={classKey} disabled={busy} onChange={event => setClassKey(event.target.value)}><option value="">—</option>{record.classes.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select> : <p>{record.classes.find(option => option.value === classKey)?.label ?? classKey}</p>}</div> : null}
      {selectedRules.some(rule => rule.requiresMatchEligibility) || record.matchEligible !== null ? <div><Label htmlFor="enrollment-match">{setup('fields.matchEligible')}</Label>{editable ? <Select id="enrollment-match" disabled={busy} value={matchEligible} onChange={event => setMatchEligible(event.target.value)}><option value="">—</option><option value="true">{common('labels.yes')}</option><option value="false">{common('labels.no')}</option></Select> : <p>{record.matchEligible === null ? '—' : record.matchEligible ? common('labels.yes') : common('labels.no')}</p>}</div> : null}
    </div>
  </TransactionDrawer>
}
