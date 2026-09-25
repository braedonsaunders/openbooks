'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import { PagedTable, type PagedColumn } from '../../../../../components/paged-table'
import { readApiErrorMessage } from '../../../../../lib/api-error'

type Option = { value: string; label: string }
type Scope = {
  employer_subsidiary_id: string | null
  department_id: string | null
  project_ids: string[]
  location_ids: string[]
}
type RateLine = {
  id: string
  classificationId: string
  classificationCode: string
  classificationName: string
  baseRate: string
  fringeRate: string
  fringeCreditRate: string
  overtimeMultiplier: string
  currency: string
  effectiveFrom: string
  effectiveTo: string | null
}
type EditorData = {
  lines: readonly RateLine[]
  classifications: readonly { id: string; code: string; name: string }[]
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function initialScope(row: Record<string, unknown>): Scope {
  const value = row.applies_to
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    employer_subsidiary_id: typeof raw.employer_subsidiary_id === 'string' ? raw.employer_subsidiary_id : null,
    department_id: typeof raw.department_id === 'string' ? raw.department_id : null,
    project_ids: stringArray(raw.project_ids),
    location_ids: stringArray(raw.location_ids),
  }
}

export function ConstructionRateScheduleEditor({
  row,
  scopeOptions,
  initialData,
}: {
  row: Record<string, unknown>
  scopeOptions: { subsidiaries: Option[]; departments: Option[]; projects: Option[]; locations: Option[] }
  initialData: EditorData
}) {
  const t = useTranslations('hrm.compliance.rateScheduleEditor')
  const tc = useTranslations('common')
  const router = useRouter()
  const scheduleId = String(row.id)
  const [scope, setScope] = useState(() => initialScope(row))
  const [data, setData] = useState<EditorData>(initialData)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [classificationId, setClassificationId] = useState('')
  const [baseRate, setBaseRate] = useState('')
  const [fringeRate, setFringeRate] = useState('0')
  const [fringeCreditRate, setFringeCreditRate] = useState('0')
  const [overtimeMultiplier, setOvertimeMultiplier] = useState('1.5')
  const [currency, setCurrency] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(String(row.effective_from ?? '').slice(0, 10))
  const [effectiveTo, setEffectiveTo] = useState('')

  const refreshLines = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(`/api/hrm/compliance/rate-schedules?scheduleId=${encodeURIComponent(scheduleId)}`)
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('loadFailed')))
      setData(await response.json() as EditorData)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [scheduleId, t])

  async function saveScope() {
    setBusy(true)
    try {
      const response = await fetch('/api/hrm/compliance/rate-schedules?scope=1', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scheduleId, appliesTo: scope }),
      })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('saveFailed')))
      toast.success(t('scopeSaved'))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function addLine() {
    if (!classificationId || !baseRate || !currency || !effectiveFrom) {
      toast.error(t('required'))
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/hrm/compliance/rate-schedules', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scheduleId, classificationId, baseRate, fringeRate, fringeCreditRate,
          overtimeMultiplier, currency: currency.trim().toUpperCase(), effectiveFrom,
          effectiveTo: effectiveTo || null,
        }),
      })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('saveFailed')))
      toast.success(t('lineAdded'))
      setBaseRate('')
      setEffectiveTo('')
      await refreshLines()
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const classOptions = data.classifications.map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` }))
  const columns: PagedColumn<RateLine>[] = [
    { key: 'classification', header: t('classification'), search: (line) => `${line.classificationCode} ${line.classificationName}`, cell: (line) => `${line.classificationCode} · ${line.classificationName}` },
    { key: 'effectiveFrom', header: t('effectiveFrom'), cell: (line) => `${line.effectiveFrom} – ${line.effectiveTo ?? t('openEnded')}` },
    { key: 'baseRate', header: t('baseRate'), align: 'right', cell: (line) => `${line.currency} ${line.baseRate}` },
    { key: 'fringe', header: t('fringeRate'), align: 'right', cell: (line) => line.fringeRate },
    { key: 'overtime', header: t('overtimeMultiplier'), align: 'right', cell: (line) => line.overtimeMultiplier },
  ]

  return (
    <div className="space-y-6 p-1">
      <section className="space-y-3">
        <h3 className="font-semibold">{t('scope')}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>{t('subsidiary')}</Label><SearchSelect value={scope.employer_subsidiary_id ?? ''} onChange={(value) => setScope((current) => ({ ...current, employer_subsidiary_id: value || null }))} options={scopeOptions.subsidiaries} clearable emptyLabel={t('scopeAll')} ariaLabel={t('subsidiary')} sheetTitle={t('subsidiary')} /></div>
          <div className="space-y-1.5"><Label>{t('department')}</Label><SearchSelect value={scope.department_id ?? ''} onChange={(value) => setScope((current) => ({ ...current, department_id: value || null }))} options={scopeOptions.departments} clearable emptyLabel={t('scopeAll')} ariaLabel={t('department')} sheetTitle={t('department')} /></div>
          <div className="space-y-1.5"><Label htmlFor="rate-schedule-projects">{t('projects')}</Label><Select id="rate-schedule-projects" multiple value={scope.project_ids} onChange={(event) => setScope((current) => ({ ...current, project_ids: Array.from(event.target.selectedOptions, (option) => option.value) }))} className="min-h-24"><option value="" disabled>{t('chooseProjects')}</option>{scopeOptions.projects.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
          <div className="space-y-1.5"><Label htmlFor="rate-schedule-locations">{t('locations')}</Label><Select id="rate-schedule-locations" multiple value={scope.location_ids} onChange={(event) => setScope((current) => ({ ...current, location_ids: Array.from(event.target.selectedOptions, (option) => option.value) }))} className="min-h-24"><option value="" disabled>{t('chooseLocations')}</option>{scopeOptions.locations.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
        </div>
        <Button type="button" disabled={busy} onClick={saveScope}>{busy ? tc('actions.saving') : t('saveScope')}</Button>
      </section>

      <section className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        <div><h3 className="font-semibold">{t('lines')}</h3><p className="text-sm text-slate-500">{t('lineHint')}</p></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>{t('classification')}</Label><SearchSelect value={classificationId} onChange={setClassificationId} options={classOptions} ariaLabel={t('classification')} sheetTitle={t('classification')} /></div>
          <div className="space-y-1.5"><Label htmlFor="rate-line-currency">{t('currency')}</Label><Input id="rate-line-currency" maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></div>
          <div className="space-y-1.5"><Label htmlFor="rate-line-base">{t('baseRate')}</Label><Input id="rate-line-base" inputMode="decimal" value={baseRate} onChange={(event) => setBaseRate(event.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="rate-line-fringe">{t('fringeRate')}</Label><Input id="rate-line-fringe" inputMode="decimal" value={fringeRate} onChange={(event) => setFringeRate(event.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="rate-line-credit">{t('fringeCreditRate')}</Label><Input id="rate-line-credit" inputMode="decimal" value={fringeCreditRate} onChange={(event) => setFringeCreditRate(event.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="rate-line-ot">{t('overtimeMultiplier')}</Label><Input id="rate-line-ot" inputMode="decimal" value={overtimeMultiplier} onChange={(event) => setOvertimeMultiplier(event.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="rate-line-from">{t('effectiveFrom')}</Label><Input id="rate-line-from" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="rate-line-to">{t('effectiveTo')}</Label><Input id="rate-line-to" type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} /></div>
        </div>
        <Button type="button" disabled={busy || loading} onClick={addLine}>{busy ? tc('actions.saving') : t('addLine')}</Button>
        {loading ? <p className="text-sm text-slate-500">{tc('labels.loading')}</p> : data.lines.length ? <PagedTable rows={[...data.lines]} columns={columns} rowKey={(line) => line.id} empty={t('noLines')} /> : <p className="text-sm text-slate-500">{t('noLines')}</p>}
      </section>
    </div>
  )
}
