'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, SearchSelect, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import type { TimesheetPickers } from '../../../../api/timesheets/_lib'

type Result = {
  rateBookName: string; rateVersionDate: string; assignmentExplanation: string; baseCurrency: string
  directCostRate: string; burdenRate: string; costRate: string; billRate: string; transferRate: string
  standardCostAmount: string; billAmount: string
  components: { lane: string; code: string; name: string; method: string; ratePerHour: string; amount: string; explanation: string }[]
}

export function LaborRateTest({ pickers }: { pickers: TimesheetPickers }) {
  const t = useTranslations('admin.setup.rateTest')
  const [form, setForm] = useState({ employeePartyId: '', projectId: '', itemId: '', timeTypeId: pickers.timeTypes[0]?.value ?? '', departmentId: '', locationId: '', workedOn: new Date().toISOString().slice(0, 10), hours: '8', isBillable: true })
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (key: string, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }))
  async function run() {
    setBusy(true); setResult(null)
    try {
      const response = await fetch('/api/admin/setup/labor-rate-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || t('failed'))
      setResult(payload)
    } catch (error) { toast.error(error instanceof Error ? error.message : t('failed')) } finally { setBusy(false) }
  }
  const options = (rows: { value: string; label: string }[]) => rows
  return <div className="space-y-5">
    <div><h2 className="text-lg font-semibold">{t('title')}</h2><p className="text-sm text-slate-500 dark:text-slate-400">{t('description')}</p></div>
    <Card><CardContent className="grid gap-4 pt-6 sm:grid-cols-2 lg:grid-cols-3">
      <div className="space-y-1.5"><Label>{t('employee')}</Label><SearchSelect value={form.employeePartyId} onChange={(value) => set('employeePartyId', value)} options={options(pickers.employees)} placeholder={t('selectEmployee')} ariaLabel={t('employee')} /></div>
      <div className="space-y-1.5"><Label>{t('project')}</Label><SearchSelect value={form.projectId} onChange={(value) => set('projectId', value)} options={options(pickers.projects)} placeholder={t('selectProject')} ariaLabel={t('project')} /></div>
      <div className="space-y-1.5"><Label>{t('item')}</Label><SearchSelect value={form.itemId} onChange={(value) => set('itemId', value)} options={options(pickers.items)} clearable placeholder={t('optional')} ariaLabel={t('item')} /></div>
      <div className="space-y-1.5"><Label>{t('timeType')}</Label><Select value={form.timeTypeId} onChange={(event) => set('timeTypeId', event.target.value)}>{pickers.timeTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div>
      <div className="space-y-1.5"><Label>{t('department')}</Label><Select value={form.departmentId} onChange={(event) => set('departmentId', event.target.value)}><option value="">{t('optional')}</option>{pickers.departments.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div>
      <div className="space-y-1.5"><Label>{t('location')}</Label><Select value={form.locationId} onChange={(event) => set('locationId', event.target.value)}><option value="">{t('optional')}</option>{pickers.locations.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></div>
      <div className="space-y-1.5"><Label>{t('workDate')}</Label><Input type="date" value={form.workedOn} onChange={(event) => set('workedOn', event.target.value)} /></div>
      <div className="space-y-1.5"><Label>{t('hours')}</Label><Input type="number" min="0.0001" step="0.25" value={form.hours} onChange={(event) => set('hours', event.target.value)} /></div>
      <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={form.isBillable} onChange={(event) => set('isBillable', event.target.checked)} />{t('billable')}</label>
      <div className="sm:col-span-2 lg:col-span-3"><Button disabled={busy || !form.employeePartyId || !form.projectId} onClick={run}>{busy ? t('testing') : t('test')}</Button></div>
    </CardContent></Card>
    {result ? <><div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {([['directCostRate', result.directCostRate], ['burdenRate', result.burdenRate], ['costRate', result.costRate], ['billRate', result.billRate], ['transferRate', result.transferRate]] as const).map(([key, value]) => <Card key={key}><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-slate-500">{t(key)}</CardTitle></CardHeader><CardContent className="text-lg font-semibold tabular-nums">{result.baseCurrency} {value}</CardContent></Card>)}
    </div><Card><CardHeader><CardTitle>{t('explanation')}</CardTitle><p className="text-sm text-slate-500">{result.rateBookName} · {result.rateVersionDate} · {result.assignmentExplanation}</p></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>{t('lane')}</TableHead><TableHead>{t('component')}</TableHead><TableHead>{t('method')}</TableHead><TableHead className="text-right">{t('ratePerHour')}</TableHead><TableHead className="text-right">{t('amount')}</TableHead><TableHead>{t('why')}</TableHead></TableRow></TableHeader><TableBody>{result.components.map((component, index) => <TableRow key={`${component.lane}-${component.code}-${index}`}><TableCell>{component.lane}</TableCell><TableCell>{component.code} · {component.name}</TableCell><TableCell>{component.method}</TableCell><TableCell className="text-right tabular-nums">{component.ratePerHour}</TableCell><TableCell className="text-right tabular-nums">{component.amount}</TableCell><TableCell className="max-w-xs text-xs text-slate-500">{component.explanation}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card></> : null}
  </div>
}
