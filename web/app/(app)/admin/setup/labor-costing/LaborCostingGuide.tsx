'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowRight, BookOpen, Check, Wand2 } from 'lucide-react'
import { Button, Card, CardContent, Input, Label, SearchSelect, Select, cn } from '@openbooks/ui'

type Props = {
  currency: string
  books: { id: string; name: string; currency: string; is_default: boolean }[]
  accounts: { id: string; number: string | null; name: string }[]
  projectTypes: { id: string; name: string; labor_rate_book_id: string | null; labor_rate_policy: string | null }[]
  sourceCount: number
  initial: { rateBookId: string; policy: string; laborWip: string; laborClearing: string; accountingMode: string }
}

export function LaborCostingGuide({ currency, books: initialBooks, accounts, projectTypes, sourceCount, initial }: Props) {
  const t = useTranslations('admin.setup.laborWizard')
  const common = useTranslations('common')
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [books, setBooks] = useState(initialBooks)
  const [template, setTemplate] = useState('construction-union')
  const [rateBookId, setRateBookId] = useState(initial.rateBookId)
  const [policy, setPolicy] = useState(initial.policy)
  const [laborWip, setLaborWip] = useState(initial.laborWip)
  const [laborClearing, setLaborClearing] = useState(initial.laborClearing)
  const [mode, setMode] = useState(initial.accountingMode)
  const [createSource, setCreateSource] = useState(sourceCount === 0)
  const [typeIds, setTypeIds] = useState(new Set(projectTypes.map((type) => type.id)))
  const accountOptions = accounts.map((a) => ({ value: a.id, label: `${a.number ? `${a.number} · ` : ''}${a.name}` }))

  async function createTemplate() {
    setBusy(true)
    const response = await fetch('/api/admin/setup/labor-rate-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: template, currency, effectiveFrom: new Date().toISOString().slice(0, 10) }) })
    const result = await response.json().catch(() => ({}))
    setBusy(false)
    if (!response.ok) return toast.error(result.error ?? t('templateFailed'))
    const label = t(`templates.${template}` as never)
    setBooks((current) => [...current, { id: result.rateBookId, name: label, currency, is_default: false }])
    setRateBookId(result.rateBookId)
    toast.success(t('templateCreated'))
    setStep(1)
  }

  async function finish() {
    setBusy(true)
    const response = await fetch('/api/admin/setup/labor-costing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rateBookId, policy, laborWip, laborClearing, accountingMode: mode, projectTypeIds: [...typeIds], createExternalSource: createSource }) })
    const result = await response.json().catch(() => ({}))
    setBusy(false)
    if (!response.ok) return toast.error(result.error ?? t('saveFailed'))
    toast.success(t('saved'))
    router.refresh()
    setStep(4)
  }

  const cards = [t('steps.template'), t('steps.company'), t('steps.projects'), t('steps.payroll')]
  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h2><p className="text-sm text-slate-500 dark:text-slate-400">{t('description')}</p></div><Link href="/docs/labor-rates" className="flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"><BookOpen size={13} />{t('docs')}</Link></div>
    <div className="grid gap-3 sm:grid-cols-4">{cards.map((title, index) => <button type="button" key={title} onClick={() => index <= step && setStep(index)} className={cn('rounded-lg border p-3 text-left', index === step ? 'border-teal-500 bg-teal-50 dark:bg-teal-950/30' : 'border-slate-200 dark:border-slate-800')}><span className="mb-1 flex h-5 w-5 items-center justify-center rounded-full bg-teal-600 text-[11px] text-white">{index < step ? <Check size={12} /> : index + 1}</span><span className="text-sm font-medium text-slate-900 dark:text-slate-100">{title}</span></button>)}</div>
    <Card><CardContent className="space-y-4 p-5">
      {step === 0 ? <><div><h3 className="font-semibold">{t('templateTitle')}</h3><p className="text-sm text-slate-500 dark:text-slate-400">{t('templateHint')}</p></div><div className="grid gap-2 sm:grid-cols-2">{['construction-union','professional-services','field-service-equipment','blended-crew'].map((id) => <button key={id} type="button" onClick={() => setTemplate(id)} className={cn('rounded-lg border p-3 text-left text-sm', template === id ? 'border-teal-500 bg-teal-50 dark:bg-teal-950/30' : 'border-slate-200 dark:border-slate-700')}><span className="font-medium">{t(`templates.${id}` as never)}</span><span className="mt-1 block text-xs text-slate-500">{t(`templateDescriptions.${id}` as never)}</span></button>)}</div><div className="flex justify-between"><Button variant="outline" disabled={!books.length} onClick={() => setStep(1)}>{t('useExisting')}</Button><Button disabled={busy} onClick={createTemplate}><Wand2 size={14}/>{busy ? common('actions.saving') : t('createStarter')}</Button></div></> : null}
      {step === 1 ? <><div><h3 className="font-semibold">{t('companyTitle')}</h3><p className="text-sm text-slate-500">{t('companyHint')}</p></div><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1"><Label>{t('defaultBook')}</Label><Select value={rateBookId} onChange={(e) => setRateBookId(e.target.value)}>{books.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.currency}</option>)}</Select></div><div className="space-y-1"><Label>{t('policy')}</Label><Select value={policy} onChange={(e) => setPolicy(e.target.value)}>{['work_date','locked','scheduled_escalation','manual_reprice'].map((p) => <option key={p} value={p}>{t(`policies.${p}`)}</option>)}</Select></div><div className="space-y-1"><Label>{t('laborWip')}</Label><SearchSelect value={laborWip} onChange={setLaborWip} options={accountOptions} clearable ariaLabel={t('laborWip')} /></div><div className="space-y-1"><Label>{t('laborClearing')}</Label><SearchSelect value={laborClearing} onChange={setLaborClearing} options={accountOptions} clearable ariaLabel={t('laborClearing')} /></div></div><div className="flex justify-end"><Button disabled={!rateBookId} onClick={() => setStep(2)}>{t('next')}<ArrowRight size={13}/></Button></div></> : null}
      {step === 2 ? <><div><h3 className="font-semibold">{t('projectsTitle')}</h3><p className="text-sm text-slate-500">{t('projectsHint')}</p></div><div className="space-y-2">{projectTypes.map((type) => <label key={type.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={typeIds.has(type.id)} onChange={(e) => { const next = new Set(typeIds); e.target.checked ? next.add(type.id) : next.delete(type.id); setTypeIds(next) }}/>{type.name}</label>)}</div><div className="flex justify-end"><Button onClick={() => setStep(3)}>{t('next')}<ArrowRight size={13}/></Button></div></> : null}
      {step === 3 ? <><div><h3 className="font-semibold">{t('payrollTitle')}</h3><p className="text-sm text-slate-500">{t('payrollHint')}</p></div><div className="space-y-3"><label className="block rounded-lg border p-3"><input type="radio" name="mode" value="costing_only" checked={mode === 'costing_only'} onChange={() => setMode('costing_only')} /> <span className="ml-2 font-medium">{t('modes.costingOnly')}</span><span className="block pl-6 text-xs text-slate-500">{t('modes.costingOnlyHint')}</span></label><label className="block rounded-lg border p-3"><input type="radio" name="mode" value="variance_to_clearing" checked={mode === 'variance_to_clearing'} onChange={() => setMode('variance_to_clearing')} /> <span className="ml-2 font-medium">{t('modes.variance')}</span><span className="block pl-6 text-xs text-slate-500">{t('modes.varianceHint')}</span></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={createSource} onChange={(e) => setCreateSource(e.target.checked)}/>{t('createSource')}</label></div><div className="flex justify-end"><Button disabled={busy || (mode === 'variance_to_clearing' && (!laborWip || !laborClearing))} onClick={finish}>{busy ? common('actions.saving') : t('finish')}</Button></div></> : null}
      {step === 4 ? <div className="space-y-3 text-center"><Check className="mx-auto text-teal-600" size={32}/><h3 className="font-semibold">{t('completeTitle')}</h3><p className="text-sm text-slate-500">{t('completeHint')}</p><div className="flex justify-center gap-2"><Button asChild><Link href="/admin/setup/labor-rate-test">{t('testRate')}</Link></Button><Button asChild variant="outline"><Link href="/admin/setup/payroll-costs">{t('payrollWorkspace')}</Link></Button></div></div> : null}
    </CardContent></Card>
  </div>
}
