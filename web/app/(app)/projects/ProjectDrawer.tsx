'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronDown, Plus, Receipt, Trash2, TrendingUp } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Popover, SearchSelect, Select, Textarea, UrlDrawer, cn } from '@openbooks/ui'
import { defaultFormLayout, type FormLayoutConfig, type HeaderFieldPlacement } from '@openbooks/customization'
import { CustomFieldInput } from '../../../components/custom-field-input'
import type { CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import { InvoicingPreferenceFields, type InvoicingPref } from '../../../components/invoicing-preference-fields'
import { RateBookAssignmentSection } from '../parties/RateBookAssignmentSection'
import { FinancialsTab, type FinancialsData } from './tabs/FinancialsTab'
import type { RecognitionStatus } from './tabs/RecognitionCard'
import { CostTimeTab, type CostTimeData } from './tabs/CostTimeTab'
import { TransactionsTab } from './tabs/TransactionsTab'
import { WorkBreakdownTab, type WorkBreakdownTask } from './tabs/WorkBreakdownTab'
import { ChargesSection, type ChargeRow, type ChargeItemOption, type ChargeEquipmentOption } from './tabs/ChargesSection'
import { BillingSection, type BillingRequestClient, type UnbilledClient, type EffectiveInvoicingClient } from './tabs/BillingSection'
import { formatMoney } from '@openbooks/engine/src/money.ts'

interface PartyOpt {
  id: string
  display_name?: string | null
}
interface SubsidiaryOpt {
  id: string
  name: string
  depth: number
}
type TaskRow = WorkBreakdownTask
interface ProjectPayload {
  project: Record<string, any>
  contractValue: string | null
  customerName: string | null
  foremanName: string | null
  managerName: string | null
  tasks: {
    id: string
    code: string | null
    name: string
    status: string
    estimated_hours: string | null
    estimated_cost: string | null
  }[]
  customFieldDefs?: CustomFieldDefClient[]
}

/** Everything the cockpit tabs need — loaded server-side alongside the project. */
export interface ProjectCockpitData {
  financials: FinancialsData
  projectType: { key: string; name: string }
  time: CostTimeData
  unbilled: UnbilledClient
  billingRequests: BillingRequestClient[]
  /** Effective invoicing/backup defaults after the type←customer←project cascade. */
  invoicing: EffectiveInvoicingClient
  charges: ChargeRow[]
  items: ChargeItemOption[]
  equipment: ChargeEquipmentOption[]
  absorption: { recovered: string; billValue: string }
  recognition: RecognitionStatus | null
  transactions: {
    id: string
    kind: string
    documentNumber: string
    documentDate: string
    partyName: string | null
    status: string
    amount: string | number
  }[]
}

const TAB_KEYS = ['overview', 'work_breakdown', 'financials', 'cost_time', 'charges', 'billing', 'transactions'] as const
type TabKey = (typeof TAB_KEYS)[number]

const emptyTask = (): TaskRow => ({
  id: null,
  code: '',
  name: '',
  status: 'open',
  estimatedHours: '',
  estimatedCost: '',
})

export function ProjectDrawer({
  payload,
  parties,
  subsidiaries,
  canManage,
  basePath = '/projects',
  layout,
  cockpit,
  projectTypes = [],
}: {
  payload: ProjectPayload
  parties: PartyOpt[]
  subsidiaries: SubsidiaryOpt[]
  canManage: boolean
  basePath?: string
  /** Resolved form layout (custom fields already merged in). */
  layout?: FormLayoutConfig
  /** Cockpit data for the financial/time/charges/billing/transactions tabs. */
  cockpit: ProjectCockpitData
  /** Configurable project types (Setup → Project Types) for the selector. */
  projectTypes?: { id: string; name: string }[]
}) {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const pr = payload.project
  const isPlaceholderName = pr.name === 'New project'

  const statusOptions = useMemo(
    () => [
      { value: 'quoted', label: t('status.quoted') },
      { value: 'awarded', label: t('status.awarded') },
      { value: 'active', label: tCommon('status.active') },
      { value: 'substantially_complete', label: t('status.substantially_complete') },
      { value: 'closed', label: tCommon('status.closed') },
      { value: 'cancelled', label: tCommon('status.cancelled') },
    ],
    [t, tCommon],
  )
  const billingOptions = useMemo(
    () => [
      { value: 'time_and_materials', label: t('billing.time_and_materials') },
      { value: 'fixed_price', label: t('billing.fixed_price') },
      { value: 'cost_plus', label: t('billing.cost_plus') },
    ],
    [t],
  )
  const [name, setName] = useState<string>(isPlaceholderName ? '' : (pr.name ?? ''))
  const [code, setCode] = useState<string>(pr.code ?? '')
  const [customerId, setCustomerId] = useState<string>(pr.customer_id ?? '')
  const [foremanId, setForemanId] = useState<string>(pr.foreman_id ?? '')
  const [managerId, setManagerId] = useState<string>(pr.manager_id ?? '')
  const [status, setStatus] = useState<string>(pr.status ?? 'active')
  const [billingMethod, setBillingMethod] = useState<string>(pr.billing_method ?? '')
  const [projectTypeId, setProjectTypeId] = useState<string>(pr.project_type_id ?? '')
  const [invoicingPref, setInvoicingPref] = useState<InvoicingPref>((pr.invoicing_preference as InvoicingPref) ?? {})
  const [customerPoNumber, setCustomerPoNumber] = useState<string>(pr.customer_po_number ?? '')
  const [startsOn, setStartsOn] = useState<string>(pr.starts_on ?? '')
  const [endsOn, setEndsOn] = useState<string>(pr.ends_on ?? '')
  const [contractValue, setContractValue] = useState<string>(
    payload.contractValue != null ? formatMoney(payload.contractValue, 2) : '',
  )
  const [notes, setNotes] = useState<string>(pr.notes ?? '')
  const customFieldDefs = payload.customFieldDefs ?? []
  const [custom, setCustom] = useState<Record<string, unknown>>(
    (pr.custom as Record<string, unknown> | null) ?? {},
  )
  const [tasks, setTasks] = useState<TaskRow[]>(
    payload.tasks.map((task) => ({
      id: task.id,
      code: task.code ?? '',
      name: task.name ?? '',
      status: task.status ?? 'open',
      estimatedHours: task.estimated_hours != null ? Number(task.estimated_hours).toString() : '',
      estimatedCost: task.estimated_cost != null ? formatMoney(task.estimated_cost, 2) : '',
    })),
  )
  const [isActive, setIsActive] = useState<boolean>(pr.is_active === true)
  const [subsidiaryId, setSubsidiaryId] = useState<string>(pr.subsidiary_id ?? '')
  const [subsidiaryIncludeChildren, setSubsidiaryIncludeChildren] = useState<boolean>(
    pr.subsidiary_include_children !== false,
  )

  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  // source platform-style record: opens READ-ONLY; Edit switches to an explicit-save form.
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const editable = mode === 'edit' && canManage

  // Flyout chrome: subtabs + Actions-menu-driven create forms (repository conventions).
  const [tab, setTab] = useState<TabKey>('overview')
  const [actionsOpen, setActionsOpen] = useState(false)
  const [chargeFormOpen, setChargeFormOpen] = useState(false)
  const [billingFormOpen, setBillingFormOpen] = useState(false)

  const nameValid = name.trim().length > 0 && name.trim() !== 'New project'

  const partyOptions = useMemo(
    () => parties.map((p) => ({ value: p.id, label: p.display_name ?? '' })),
    [parties],
  )

  function setTask(task: TaskRow, patch: Partial<TaskRow>) {
    setTasks((rows) => rows.map((row) => (row === task ? { ...row, ...patch } : row)))
  }

  const savePayload = useMemo(
    () => ({
      name: name.trim() || (isActive ? name : 'New project'),
      code,
      customerId: customerId || null,
      foremanId: foremanId || null,
      managerId: managerId || null,
      status,
      billingMethod: billingMethod || null,
      projectTypeId: projectTypeId || null,
      invoicingPreference: invoicingPref,
      customerPoNumber: customerPoNumber || null,
      startsOn: startsOn || null,
      endsOn: endsOn || null,
      contractValue: contractValue || null,
      notes: notes || null,
      custom,
      subsidiaryId: subsidiaries.length > 1 ? subsidiaryId || null : undefined,
      subsidiaryIncludeChildren: subsidiaries.length > 1 ? subsidiaryIncludeChildren : undefined,
      tasks: tasks
        .filter((task) => task.name.trim().length > 0)
        .map((task) => ({
          id: task.id,
          code: task.code || null,
          name: task.name,
          status: task.status,
          estimatedHours: task.estimatedHours || null,
          estimatedCost: task.estimatedCost || null,
        })),
    }),
    [name, code, customerId, foremanId, managerId, status, billingMethod, projectTypeId, invoicingPref, customerPoNumber, startsOn, endsOn, contractValue, notes, custom, subsidiaryId, subsidiaryIncludeChildren, subsidiaries.length, tasks, isActive],
  )
  const [dirty, setDirty] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (editable) setDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savePayload])

  function resetForm() {
    setName(isPlaceholderName ? '' : (pr.name ?? ''))
    setCode(pr.code ?? '')
    setCustomerId(pr.customer_id ?? '')
    setForemanId(pr.foreman_id ?? '')
    setManagerId(pr.manager_id ?? '')
    setStatus(pr.status ?? 'active')
    setBillingMethod(pr.billing_method ?? '')
    setProjectTypeId(pr.project_type_id ?? '')
    setInvoicingPref((pr.invoicing_preference as InvoicingPref) ?? {})
    setCustomerPoNumber(pr.customer_po_number ?? '')
    setStartsOn(pr.starts_on ?? '')
    setEndsOn(pr.ends_on ?? '')
    setContractValue(payload.contractValue != null ? formatMoney(payload.contractValue, 2) : '')
    setNotes(pr.notes ?? '')
    setCustom((pr.custom as Record<string, unknown> | null) ?? {})
    setSubsidiaryId(pr.subsidiary_id ?? '')
    setSubsidiaryIncludeChildren(pr.subsidiary_include_children !== false)
    setTasks(
      payload.tasks.map((task) => ({
        id: task.id,
        code: task.code ?? '',
        name: task.name ?? '',
        status: task.status ?? 'open',
        estimatedHours: task.estimated_hours != null ? Number(task.estimated_hours).toString() : '',
        estimatedCost: task.estimated_cost != null ? formatMoney(task.estimated_cost, 2) : '',
      })),
    )
  }

  async function save() {
    setBusy(true)
    setSaveState('saving')
    const res = await fetch(`/api/projects/${pr.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savePayload),
    })
    if (res.ok) {
      setSaveState('saved')
      setDirty(false)
      setMode('view')
      router.refresh()
    } else {
      setSaveState('error')
      toast.error((await res.json()).error ?? t('drawer.autosaveFailed'))
    }
    setBusy(false)
  }

  function cancel() {
    resetForm()
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  async function setActiveState(next: boolean) {
    setBusy(true)
    const res = await fetch(`/api/projects/${pr.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: next }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('drawer.updateFailed'))
    else {
      setIsActive(next)
      toast.success(next ? t('drawer.activated') : t('drawer.deactivated'))
    }
    setBusy(false)
    router.refresh()
  }

  const ro = !editable
  const effectiveLayout = layout ?? defaultFormLayout('project')
  const cfByKey = useMemo(
    () => new Map(customFieldDefs.map((d) => [`cf_${d.key}`, d])),
    [customFieldDefs],
  )

  function renderProjectField(placement: HeaderFieldPlacement): React.ReactNode {
    const lbl = placement.labelOverride?.trim() || undefined
    switch (placement.key) {
      case 'name':
        return (
          <>
            <Label>{lbl || tCommon('labels.name')}<span className="text-red-500"> *</span></Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('drawer.namePlaceholder')} disabled={ro} />
          </>
        )
      case 'code':
        return (
          <>
            <Label>{lbl || t('labels.code')}</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" placeholder={t('drawer.codePlaceholder')} disabled={ro} />
          </>
        )
      case 'project_type_id':
        if (projectTypes.length === 0) return null
        return (
          <>
            <Label>{lbl || t('drawer.projectType')}</Label>
            <Select value={projectTypeId} onChange={(e) => setProjectTypeId(e.target.value)} disabled={ro}>
              <option value="">—</option>
              {projectTypes.map((projectType) => <option key={projectType.id} value={projectType.id}>{projectType.name}</option>)}
            </Select>
          </>
        )
      case 'customer_id':
        return (
          <>
            <Label>{lbl || tCommon('labels.customer')}</Label>
            <SearchSelect value={customerId} onChange={setCustomerId} options={partyOptions} clearable emptyLabel={t('drawer.noCustomer')} placeholder={t('drawer.selectCustomer')} sheetTitle={tCommon('labels.customer')} ariaLabel={tCommon('labels.customer')} disabled={ro} />
          </>
        )
      case 'status':
        return (
          <>
            <Label>{lbl || tCommon('labels.status')}</Label>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} disabled={ro}>
              {statusOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </Select>
          </>
        )
      case 'billing_method':
        return (
          <>
            <Label>{lbl || t('labels.billingMethod')}</Label>
            <Select value={billingMethod} onChange={(e) => setBillingMethod(e.target.value)} disabled={ro}>
              <option value="">—</option>
              {billingOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </Select>
          </>
        )
      case 'contract_value':
        return (
          <>
            <Label>{lbl || t('labels.contractValue')}</Label>
            <div className="flex items-center">
              <span className="mr-1 text-slate-500">$</span>
              <Input inputMode="decimal" className="text-right tabular-nums" value={contractValue} onChange={(e) => setContractValue(e.target.value)} disabled={ro} />
            </div>
          </>
        )
      case 'foreman_id':
        return (
          <>
            <Label>{lbl || t('labels.foreman')}</Label>
            <SearchSelect value={foremanId} onChange={setForemanId} options={partyOptions} clearable emptyLabel={t('drawer.noForeman')} placeholder={t('drawer.selectForeman')} sheetTitle={t('labels.foreman')} ariaLabel={t('labels.foreman')} disabled={ro} />
          </>
        )
      case 'manager_id':
        return (
          <>
            <Label>{lbl || t('labels.manager')}</Label>
            <SearchSelect value={managerId} onChange={setManagerId} options={partyOptions} clearable emptyLabel={t('drawer.noManager')} placeholder={t('drawer.selectManager')} sheetTitle={t('labels.manager')} ariaLabel={t('labels.manager')} disabled={ro} />
          </>
        )
      case 'customer_po_number':
        return (
          <>
            <Label>{lbl || t('labels.customerPo')}</Label>
            <Input value={customerPoNumber} onChange={(e) => setCustomerPoNumber(e.target.value)} className="font-mono" disabled={ro} />
          </>
        )
      case 'starts_on':
        return (
          <>
            <Label>{lbl || t('labels.startDate')}</Label>
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} disabled={ro} />
          </>
        )
      case 'ends_on':
        return (
          <>
            <Label>{lbl || t('labels.endDate')}</Label>
            <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} disabled={ro} />
          </>
        )
      case 'subsidiary_id':
        if (subsidiaries.length <= 1) return null
        return (
          <>
            <Label>{lbl || t('drawer.subsidiaryRestriction')}</Label>
            <Select value={subsidiaryId} onChange={(e) => setSubsidiaryId(e.target.value)} disabled={ro}>
              <option value="">{t('drawer.allSubsidiaries')}</option>
              {subsidiaries.map((s) => (<option key={s.id} value={s.id}>{`${'— '.repeat(s.depth)}${s.name}`}</option>))}
            </Select>
            {subsidiaryId ? (
              <label className="mt-1 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={subsidiaryIncludeChildren} onChange={(e) => setSubsidiaryIncludeChildren(e.target.checked)} disabled={ro} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
                {t('drawer.includeChildSubsidiaries')}
              </label>
            ) : null}
          </>
        )
      case 'notes':
        return (
          <>
            <Label>{lbl || tCommon('labels.notes')}</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={ro} />
          </>
        )
      default: {
        const def = cfByKey.get(placement.key)
        if (!def) return null
        const overridden = lbl ? { ...def, label: lbl } : def
        return (
          <CustomFieldInput
            def={overridden}
            value={custom[def.key]}
            onChange={(v) => setCustom({ ...custom, [def.key]: v })}
            readOnly={ro}
          />
        )
      }
    }
  }

  function menuItem(icon: React.ReactNode, label: string, onClick: () => void) {
    return (
      <button
        type="button"
        onClick={() => { setActionsOpen(false); onClick() }}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        {icon}
        {label}
      </button>
    )
  }

  const tabs = TAB_KEYS.map((key) => ({ key, label: t(`cockpit.tabs.${key}`) }))

  return (
    <UrlDrawer
      open
      closeHref={basePath}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{name.trim() || t('drawer.newProject')}</span>
          <Badge variant={isActive ? 'success' : 'outline'}>
            {isActive ? tCommon('status.active') : tCommon('status.inactive')}
          </Badge>
        </span>
      }
      description={mode === 'edit' ? tCommon('feedback.editingHint') : undefined}
      subtabs={
        <nav className="-mb-px flex flex-wrap gap-1" aria-label={t('cockpit.tabsAria')}>
          {tabs.map((tb) => (
            <button
              key={tb.key}
              type="button"
              role="tab"
              aria-selected={tab === tb.key}
              onClick={() => setTab(tb.key)}
              className={cn(
                'border-b-2 px-3 py-3 text-sm font-medium transition-colors',
                tab === tb.key
                  ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200',
              )}
            >
              {tb.label}
            </button>
          ))}
        </nav>
      }
      headerActions={
        mode === 'edit' ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" disabled={busy} onClick={save}>
              {busy ? tCommon('actions.saving') : tCommon('actions.save')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={cancel}>
              {tCommon('actions.cancel')}
            </Button>
          </div>
        ) : canManage ? (
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" onClick={() => { if (tab !== 'work_breakdown') setTab('overview'); setMode('edit') }}>
              {tCommon('actions.edit')}
            </Button>
            <Popover
            open={actionsOpen}
            onOpenChange={setActionsOpen}
            align="end"
            trigger={
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => setActionsOpen((o) => !o)}
                aria-expanded={actionsOpen}
              >
                {tCommon('labels.actions')}
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', actionsOpen && 'rotate-180')} aria-hidden />
              </Button>
            }
            className="w-56 p-1.5"
          >
            <div className="space-y-0.5">
              {menuItem(<Plus className="h-3.5 w-3.5" aria-hidden />, t('charges.addTitle'), () => { setTab('charges'); setChargeFormOpen(true) })}
              {menuItem(<Receipt className="h-3.5 w-3.5" aria-hidden />, t('billing.requestBilling'), () => { setTab('billing'); setBillingFormOpen(true) })}
              {billingMethod === 'fixed_price'
                ? menuItem(<TrendingUp className="h-3.5 w-3.5" aria-hidden />, t('cockpit.recognizeRevenue'), () => setTab('financials'))
                : null}
              <div className="my-1 border-t border-slate-200 dark:border-slate-800" />
              {isActive
                ? menuItem(<Trash2 className="h-3.5 w-3.5" aria-hidden />, t('drawer.deactivate'), () => setActiveState(false))
                : nameValid
                  ? menuItem(<Plus className="h-3.5 w-3.5" aria-hidden />, t('drawer.activate'), () => setActiveState(true))
                  : null}
            </div>
          </Popover>
          </div>
        ) : undefined
      }
      footer={
        (tab === 'overview' || tab === 'work_breakdown') && mode === 'edit' ? (
          <div className="flex w-full items-center gap-3">
            <span className={cn('text-xs', saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>
              {saveState === 'saving'
                ? tCommon('actions.saving')
                : saveState === 'error'
                  ? t('drawer.saveFailedRetry')
                  : dirty
                    ? t('drawer.unsavedChanges')
                    : null}
            </span>
          </div>
        ) : undefined
      }
    >
      {tab === 'overview' ? (
        <div className="space-y-7 p-1">
          <HeaderFields layout={effectiveLayout} editable={editable} renderField={renderProjectField} />

          {/* Project-level invoicing/backup override (cascades over type ← customer). */}
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('invoicingPref.heading')}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('invoicingPref.projectHint')}</p>
            </div>
            <InvoicingPreferenceFields value={invoicingPref} onChange={setInvoicingPref} disabled={ro} />
          </section>

          {!isPlaceholderName ? (
            <RateBookAssignmentSection scope="project" scopeId={String(pr.id)} />
          ) : null}

        </div>
      ) : null}

      {tab === 'work_breakdown' ? (
        <WorkBreakdownTab
          tasks={tasks}
          editable={editable}
          onAdd={() => setTasks((rows) => [...rows, emptyTask()])}
          onChange={setTask}
          onRemove={(task) => setTasks((rows) => rows.filter((row) => row !== task))}
        />
      ) : null}

      {tab === 'financials' ? (
        <FinancialsTab
          data={cockpit.financials}
          projectId={pr.id}
          billingMethod={billingMethod || null}
          recognition={cockpit.recognition}
          canManage={canManage}
        />
      ) : null}

      {tab === 'cost_time' ? <CostTimeTab data={cockpit.time} /> : null}

      {tab === 'charges' ? (
        <ChargesSection
          projectId={pr.id}
          charges={cockpit.charges}
          items={cockpit.items}
          equipment={cockpit.equipment}
          absorption={cockpit.absorption}
          formOpen={chargeFormOpen}
          onFormOpenChange={setChargeFormOpen}
        />
      ) : null}

      {tab === 'billing' ? (
        <BillingSection
          projectId={pr.id}
          unbilled={cockpit.unbilled}
          requests={cockpit.billingRequests}
          invoicing={cockpit.invoicing}
          canManage={canManage}
          formOpen={billingFormOpen}
          onFormOpenChange={setBillingFormOpen}
        />
      ) : null}

      {tab === 'transactions' ? (
        <TransactionsTab transactions={cockpit.transactions} />
      ) : null}
    </UrlDrawer>
  )
}
