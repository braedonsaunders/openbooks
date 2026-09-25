'use client'

import { useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Input, Select } from '@openbooks/ui'
import { Field } from '@/components/field'
import { enumLabel } from '@/lib/enum-label'

export interface FieldTimeRuleSettings {
  roundingIncrement: number | null
  roundingMode: string | null
  unpaidBreakMinutes: number | null
  autoCloseHours: number | null
  signatureRequired: boolean
  equipmentToleranceHours: string | null
  photoRequired: boolean
}

export interface KioskRow {
  id: string
  name: string
  locationId: string | null
  projectId: string | null
  pinRequired: boolean
  photoRequired: boolean
  isActive: boolean
  lastSeenAt: string | null
}

export interface StageChain {
  subject: string
  stages: Array<{ order: number; approverKind: string; roleKey?: string | null }> | null
}

type ApprovalSubject = 'timesheet_week' | 'crew_time_batch'
type ApprovalKind = 'supervisor' | 'project_manager' | 'payroll' | 'role'

/**
 * The field-time setup surface: declared rounding/break/auto-close/
 * signature/tolerance/photo rules, kiosk devices with token issue and
 * revoke plus worker PINs, and the multi-stage chains. Every rule is
 * required — the service refuses without them rather than guessing.
 */
export function FieldTimeSetup({
  initialSettings,
  kiosks,
  chains,
  kioskLinkBase,
}: {
  initialSettings: FieldTimeRuleSettings
  kiosks: KioskRow[]
  chains: StageChain[]
  kioskLinkBase: string
}) {
  const t = useTranslations('timesheets')
  const approvalSubjects = {
    timesheet_week: t('field.subjects.timesheetWeek'),
    crew_time_batch: t('field.subjects.crewTimeBatch'),
  } satisfies Record<ApprovalSubject, string>
  const approverKinds = {
    supervisor: t('field.approvers.supervisor'),
    project_manager: t('field.approvers.projectManager'),
    payroll: t('field.approvers.payroll'),
    role: t('field.approvers.role'),
  } satisfies Record<ApprovalKind, string>
  const [settings, setSettings] = useState<FieldTimeRuleSettings>(initialSettings)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null)
  const [kioskName, setKioskName] = useState('')
  const [pinWorker, setPinWorker] = useState('')
  const [pin, setPin] = useState('')

  const saveSettings = useCallback(async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch('/api/time/settings', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roundingIncrement: settings.roundingIncrement,
          roundingMode: settings.roundingMode ?? 'nearest',
          unpaidBreakMinutes: settings.unpaidBreakMinutes,
          autoCloseHours: settings.autoCloseHours,
          signatureRequired: settings.signatureRequired,
          equipmentToleranceHours: settings.equipmentToleranceHours ?? '0.5000',
          photoRequired: settings.photoRequired,
        }),
      })
      const payload = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        setError(payload?.error ?? t('field.sendFailed'))
        return
      }
      setSaved(true)
    } catch {
      setError(t('field.sendFailed'))
    } finally {
      setBusy(false)
    }
  }, [settings, t])

  const registerKiosk = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/time/kiosks', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: kioskName.trim() }),
      })
      const payload = (await res.json().catch(() => null)) as { error?: string; kiosk?: { name: string }; token?: string } | null
      if (!res.ok || !payload?.token) {
        setError(payload?.error ?? t('field.sendFailed'))
        return
      }
      setIssued({ name: payload.kiosk?.name ?? kioskName.trim(), token: payload.token })
      setKioskName('')
      window.location.reload()
    } catch {
      setError(t('field.sendFailed'))
    } finally {
      setBusy(false)
    }
  }, [kioskName, t])

  const setPinFor = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/time/kiosks', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'set-pin', employeePartyId: pinWorker.trim(), pin: pin.trim() }),
      })
      const payload = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        setError(payload?.error ?? t('field.sendFailed'))
        return
      }
      setPinWorker('')
      setPin('')
      setSaved(true)
    } catch {
      setError(t('field.sendFailed'))
    } finally {
      setBusy(false)
    }
  }, [pinWorker, pin, t])

  const num = (value: string): number | null => {
    if (value.trim() === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-base font-semibold">{t('field.rulesTitle')}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('field.roundingIncrement')}>
            <Select
              value={settings.roundingIncrement == null ? '' : String(settings.roundingIncrement)}
              onChange={(event) => setSettings((prev) => ({ ...prev, roundingIncrement: event.target.value === '' ? null : Number(event.target.value) }))}
            >
              <option value="">{t('field.notDeclared')}</option>
              <option value="0">{t('field.roundingNone')}</option>
              <option value="6">{t('field.rounding6')}</option>
              <option value="15">{t('field.rounding15')}</option>
            </Select>
          </Field>
          <Field label={t('field.roundingMode')}>
            <Select value={settings.roundingMode ?? 'nearest'} onChange={(event) => setSettings((prev) => ({ ...prev, roundingMode: event.target.value }))}>
              <option value="nearest">{t('field.roundNearest')}</option>
              <option value="up">{t('field.roundUp')}</option>
              <option value="down">{t('field.roundDown')}</option>
            </Select>
          </Field>
          <Field label={t('field.unpaidBreak')}>
            <Input value={settings.unpaidBreakMinutes == null ? '' : String(settings.unpaidBreakMinutes)} onChange={(event) => setSettings((prev) => ({ ...prev, unpaidBreakMinutes: num(event.target.value) }))} inputMode="numeric" placeholder="30" />
          </Field>
          <Field label={t('field.autoClose')}>
            <Input value={settings.autoCloseHours == null ? '' : String(settings.autoCloseHours)} onChange={(event) => setSettings((prev) => ({ ...prev, autoCloseHours: num(event.target.value) }))} inputMode="decimal" placeholder="16" />
          </Field>
          <Field label={t('field.equipmentTolerance')}>
            <Input value={settings.equipmentToleranceHours ?? ''} onChange={(event) => setSettings((prev) => ({ ...prev, equipmentToleranceHours: event.target.value.trim() || null }))} inputMode="decimal" placeholder="0.5" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.signatureRequired} onChange={(event) => setSettings((prev) => ({ ...prev, signatureRequired: event.target.checked }))} />
          {t('field.signatureRequired')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.photoRequired} onChange={(event) => setSettings((prev) => ({ ...prev, photoRequired: event.target.checked }))} />
          {t('field.photoRequiredSetting')}
        </label>
        <Button disabled={busy} onClick={saveSettings}>
          {busy ? t('field.working') : t('field.saveRules')}
        </Button>
        {saved ? <p className="text-sm text-teal-700">{t('field.rulesSaved')}</p> : null}
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-base font-semibold">{t('field.kiosksTitle')}</h2>
        {kiosks.length === 0 ? <p className="text-sm text-slate-500">{t('field.noKiosks')}</p> : null}
        <ul className="space-y-2">
          {kiosks.map((kiosk) => (
            <li key={kiosk.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 p-3 dark:border-slate-800">
              <span className="font-medium">{kiosk.name}</span>
              {!kiosk.isActive ? <span className="text-xs text-red-600">{t('field.retired')}</span> : null}
            </li>
          ))}
        </ul>
        {issued ? (
          <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800" role="status">
            <p>{t('field.tokenIssued', { name: issued.name })}</p>
            <p className="mt-1 break-all font-mono text-xs">
              {kioskLinkBase}/{issued.token}
            </p>
          </div>
        ) : null}
        <div className="flex gap-2">
          <Field label={t('field.kioskNamePlaceholder')}>
            <Input value={kioskName} onChange={(event) => setKioskName(event.target.value)} placeholder={t('field.kioskNamePlaceholder')} className="max-w-xs" />
          </Field>
          <Button variant="outline" disabled={busy || !kioskName.trim()} onClick={registerKiosk}>
            {t('field.registerKiosk')}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Field label={t('field.pinWorkerPlaceholder')}>
            <Input value={pinWorker} onChange={(event) => setPinWorker(event.target.value)} placeholder={t('field.pinWorkerPlaceholder')} className="max-w-xs" />
          </Field>
          <Field label={t('field.pinPlaceholder')}>
            <Input value={pin} onChange={(event) => setPin(event.target.value)} placeholder={t('field.pinPlaceholder')} inputMode="numeric" autoComplete="off" className="max-w-40" />
          </Field>
          <Button variant="outline" disabled={busy || !pinWorker.trim() || !pin.trim()} onClick={setPinFor}>
            {t('field.setPin')}
          </Button>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-base font-semibold">{t('field.stagesTitle')}</h2>
        {chains.map((chain) => (
          <div key={chain.subject} className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
            <p className="font-medium">{enumLabel(chain.subject, approvalSubjects, t('field.unknownApprovalTarget'))}</p>
            <p className="text-sm text-slate-500">
              {chain.stages && chain.stages.length > 0
                ? chain.stages.map((stage) => `${stage.order}. ${enumLabel(stage.approverKind, approverKinds, t('field.unknownApprovalTarget'))}${stage.roleKey ? ` (${t('field.approvers.namedRole', { role: stage.roleKey })})` : ''}`).join(' → ')
                : t('field.singleApproval')}
            </p>
          </div>
        ))}
        <p className="text-xs text-slate-500">{t('field.stagesHint')}</p>
      </section>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
