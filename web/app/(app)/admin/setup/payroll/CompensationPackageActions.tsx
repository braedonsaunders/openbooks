'use client'

import { useRef, useState } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Label, SearchSelect } from '@openbooks/ui'
import { FieldControl } from '../[entity]/SetupDrawer'
import { useMoney } from '@/components/money-provider'
import { InspectorPanel } from '@/components/builder/builder-kit'
import { clearSetupChildren } from '@/lib/setup/navigation'
import { readApiErrorMessage } from '@/lib/api-error'
import type { CompensationPackageAssignment, CompensationPackageEvaluation, CompensationPackageVersion } from '@openbooks/engine/payroll/compensation-packages'

export function PackageVersionPicker({ versions, value }: { versions: CompensationPackageVersion[]; value?: string }) {
  const t = useTranslations('admin.setup.compensationPackages')
  const router = useRouter(), pathname = usePathname(), params = useSearchParams()
  return <div className="space-y-1.5"><Label>{t('chooseApprovedVersion')}</Label><SearchSelect ariaLabel={t('chooseApprovedVersion')} placeholder={t('chooseApprovedVersion')} value={value ?? ''} options={versions.map(version => ({ value: version.id, label: `${t('version')} ${version.version} · ${version.effectiveFrom} – ${version.effectiveTo ?? '…'}` }))} onChange={nextValue => {
    const next = new URLSearchParams(params.toString())
    clearSetupChildren(next, 'packageAssignments')
    if (nextValue) next.set('assignmentVersion', nextValue); else next.delete('assignmentVersion')
    router.replace(`${pathname}?${next}`, { scroll: false })
  }} /></div>
}

/** The native decision tab preserves refusals and carries the server-loaded revision. */
export function CompensationPackageActions({ packageId, version, assignment, canManage, canApprove }: {
  packageId: string; version?: CompensationPackageVersion; assignment?: CompensationPackageAssignment; canManage: boolean; canApprove: boolean
}) {
  const t = useTranslations('admin.setup'), router = useRouter()
  const record = version ?? assignment!
  const [reason, setReason] = useState(''), [end, setEnd] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const family = version ? 'versions' : 'assignments'
  const actions = [
    ...(canManage && record.status === 'draft' ? ['submit'] : []),
    ...(canApprove && record.status === 'submitted' ? ['approve', 'reject'] : []),
    ...(assignment && canManage && record.status === 'draft' ? ['cancel'] : []),
    ...(assignment && canManage && record.status === 'active' ? ['end'] : []),
  ]
  async function act(action: string) {
    if (pending.current) return
    if (!reason.trim()) { setError(t('compensationPackages.reasonHint')); return }
    pending.current = true; setBusy(true); setError(null)
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const deciding = action === 'approve' || action === 'reject'
      const suffix = deciding ? '/decision' : version ? '/submit' : ''
      const body = { expectedRevision: record.revision, reason, ...(version && !deciding ? {} : { action }), ...(action === 'end' ? { effectiveTo: end } : {}) }
      const response = await fetch(`/api/payroll/compensation-packages/${packageId}/${family}/${record.id}${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
      if (!response.ok) { setError(await readApiErrorMessage(response, t('compensationPackages.decisionUnconfirmed'))); return }
      setReason(''); router.refresh()
    } catch { setError(t('compensationPackages.decisionUnconfirmed')) }
    finally { clearTimeout(timeout); pending.current = false; setBusy(false) }
  }
  return <InspectorPanel title={t('compensationPackages.review')} description={t('compensationPackages.reviewHint')}>
    <p className="mb-4 text-sm">{t('compensationPackages.status')}: {t(`compensationPackages.options.${record.status}`)}</p>
    {actions.length ? <div className="space-y-4">
      <FieldControl field={{ key: 'reason', kind: 'textarea', labelKey: 'compensationPackages.reason', required: true }} value={reason} onChange={value => { setReason(String(value)); setError(null) }} creating forceLocked={busy} refOptions={[]} formValues={{ reason }} t={t} />
      {actions.includes('end') ? <FieldControl field={{ key: 'effectiveTo', kind: 'date', required: true }} value={end} onChange={value => setEnd(String(value))} creating forceLocked={busy} refOptions={[]} formValues={{ effectiveTo: end }} t={t} /> : null}
      <div className="flex flex-wrap gap-2">{actions.map(action => <Button key={action} variant={action === 'reject' || action === 'cancel' ? 'outline' : 'default'} disabled={busy} onClick={() => void act(action)}>{t(`compensationPackages.actions.${action}`)}</Button>)}</div>
    </div> : <p className="text-sm text-slate-500">{t('compensationPackages.noActions')}</p>}
    {error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}
  </InspectorPanel>
}

/** Sample values exercise the same exact policy as payroll without creating a transaction. */
export function CompensationPackagePreview({ packageId, version }: { packageId: string; version: CompensationPackageVersion }) {
  const t = useTranslations('admin.setup')
  const { money } = useMoney(version.definition.currency)
  const [dates, setDates] = useState<Record<string, unknown>>({ periodStart: '', periodEnd: '', effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo ?? '' })
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(version.definition.inputs.filter(input => input.source !== 'constant').map(input => [input.name, input.type.kind === 'boolean' ? false : ''])))
  const [result, setResult] = useState<CompensationPackageEvaluation | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  async function preview() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null); setResult(null)
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(`/api/payroll/compensation-packages/${packageId}/versions/${version.id}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: { ...dates, effectiveTo: dates.effectiveTo || null, values, occupiedComponentIds: [], replacementComponentIds: [] } }), signal: controller.signal })
      if (!response.ok) { setError(await readApiErrorMessage(response, t('compensationPackages.previewFailed'))); return }
      setResult(await response.json())
    } catch { setError(t('compensationPackages.previewFailed')) }
    finally { clearTimeout(timeout); pending.current = false; setBusy(false) }
  }
  return <div className="space-y-4"><InspectorPanel title={t('compensationPackages.preview')} description={t('compensationPackages.previewHint')}>
    <div className="grid gap-4 sm:grid-cols-2">
      {['periodStart', 'periodEnd', 'effectiveFrom', 'effectiveTo'].map(key => <FieldControl key={key} field={{ key, kind: 'date', required: key !== 'effectiveTo', labelKey: key.startsWith('period') ? `compensationPackages.${key}` : `fields.${key}` }} value={dates[key]} onChange={value => { setDates(current => ({ ...current, [key]: value })); setResult(null) }} creating forceLocked={busy} refOptions={[]} formValues={dates} t={t} />)}
      {version.definition.inputs.filter(input => input.source !== 'constant').map(input => <FieldControl key={input.name} field={{ key: input.name, kind: input.type.kind === 'boolean' ? 'boolean' : 'text', required: true, label: input.name }} value={values[input.name] ?? (input.type.kind === 'boolean' ? false : '')} onChange={value => { setValues(current => ({ ...current, [input.name]: value })); setResult(null) }} creating forceLocked={busy} refOptions={[]} formValues={values} t={t} />)}
    </div><Button className="mt-4" disabled={busy} onClick={() => void preview()}>{t('compensationPackages.preview')}</Button>
    {error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}
  </InspectorPanel>
    {result ? <InspectorPanel title={t('compensationPackages.previewResult')} description={t('compensationPackages.coverage', { covered: result.coveredDays, period: result.periodDays })}>
      {result.lines.map(line => <p key={line.key} className="flex flex-wrap justify-between gap-3 py-2 text-sm"><span>{line.key}</span><span className="font-mono tabular-nums">{line.applicable ? money(line.amount, { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : t('compensationPackages.notEligible')}</span></p>)}
      {!result.lines.length ? <p className="text-sm">{t('compensationPackages.noPayments')}</p> : null}
    </InspectorPanel> : null}
  </div>
}
