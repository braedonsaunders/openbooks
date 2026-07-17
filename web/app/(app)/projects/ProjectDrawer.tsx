'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { LayoutDashboard, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Select, Textarea, UrlDrawer } from '@openbooks/ui'

interface PartyOpt {
  id: string
  display_name?: string | null
}
interface SubsidiaryOpt {
  id: string
  name: string
  depth: number
}
interface TaskRow {
  id: string | null
  code: string
  name: string
  status: string
  estimatedHours: string
  estimatedCost: string
}
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
}

const field = 'space-y-1.5'

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
}: {
  payload: ProjectPayload
  parties: PartyOpt[]
  subsidiaries: SubsidiaryOpt[]
  canManage: boolean
  basePath?: string
}) {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const pr = payload.project
  // 'New project' is the server-side draft sentinel stored in the DB — compared
  // and saved verbatim; only its *display* goes through the catalog.
  const isPlaceholderName = pr.name === 'New project'

  // Enum option lists — values are API codes, labels come from the catalogs.
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
  const taskStatusOptions = useMemo(
    () => [
      { value: 'open', label: tCommon('status.open') },
      { value: 'complete', label: t('taskStatus.complete') },
      { value: 'cancelled', label: tCommon('status.cancelled') },
    ],
    [t, tCommon],
  )

  const [name, setName] = useState<string>(isPlaceholderName ? '' : (pr.name ?? ''))
  const [code, setCode] = useState<string>(pr.code ?? '')
  const [customerId, setCustomerId] = useState<string>(pr.customer_id ?? '')
  const [foremanId, setForemanId] = useState<string>(pr.foreman_id ?? '')
  const [managerId, setManagerId] = useState<string>(pr.manager_id ?? '')
  const [status, setStatus] = useState<string>(pr.status ?? 'active')
  const [billingMethod, setBillingMethod] = useState<string>(pr.billing_method ?? '')
  const [customerPoNumber, setCustomerPoNumber] = useState<string>(pr.customer_po_number ?? '')
  const [startsOn, setStartsOn] = useState<string>(pr.starts_on ?? '')
  const [endsOn, setEndsOn] = useState<string>(pr.ends_on ?? '')
  const [contractValue, setContractValue] = useState<string>(
    payload.contractValue != null ? Number(payload.contractValue).toFixed(2) : '',
  )
  const [notes, setNotes] = useState<string>(pr.notes ?? '')
  const [tasks, setTasks] = useState<TaskRow[]>(
    payload.tasks.map((t) => ({
      id: t.id,
      code: t.code ?? '',
      name: t.name ?? '',
      status: t.status ?? 'open',
      estimatedHours: t.estimated_hours != null ? Number(t.estimated_hours).toString() : '',
      estimatedCost: t.estimated_cost != null ? Number(t.estimated_cost).toFixed(2) : '',
    })),
  )
  const [isActive, setIsActive] = useState<boolean>(pr.is_active === true)
  const [subsidiaryId, setSubsidiaryId] = useState<string>(pr.subsidiary_id ?? '')
  const [subsidiaryIncludeChildren, setSubsidiaryIncludeChildren] = useState<boolean>(
    pr.subsidiary_include_children !== false,
  )

  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  // NetSuite-style record model: the flyout ALWAYS opens READ-ONLY (view mode)
  // — even for drafts — with an Edit button in the header. Save is EXPLICIT —
  // one Save button, no per-field autosave.
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const editable = mode === 'edit' && canManage

  const nameValid = name.trim().length > 0 && name.trim() !== 'New project'

  const partyOptions = useMemo(
    () => parties.map((p) => ({ value: p.id, label: p.display_name ?? '' })),
    [parties],
  )

  function setTask(i: number, patch: Partial<TaskRow>) {
    setTasks((rows) => rows.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  }

  // -- explicit save (no autosave) -------------------------------------------
  const savePayload = useMemo(
    () => ({
      name: name.trim() || (isActive ? name : 'New project'),
      code,
      customerId: customerId || null,
      foremanId: foremanId || null,
      managerId: managerId || null,
      status,
      billingMethod: billingMethod || null,
      customerPoNumber: customerPoNumber || null,
      startsOn: startsOn || null,
      endsOn: endsOn || null,
      contractValue: contractValue || null,
      notes: notes || null,
      subsidiaryId: subsidiaries.length > 1 ? subsidiaryId || null : undefined,
      subsidiaryIncludeChildren: subsidiaries.length > 1 ? subsidiaryIncludeChildren : undefined,
      tasks: tasks
        .filter((t) => t.name.trim().length > 0)
        .map((t) => ({
          id: t.id,
          code: t.code || null,
          name: t.name,
          status: t.status,
          estimatedHours: t.estimatedHours || null,
          estimatedCost: t.estimatedCost || null,
        })),
    }),
    [name, code, customerId, foremanId, managerId, status, billingMethod, customerPoNumber, startsOn, endsOn, contractValue, notes, subsidiaryId, subsidiaryIncludeChildren, subsidiaries.length, tasks, isActive],
  )
  // Track unsaved edits (no autosave — Save is an explicit button).
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

  /** Reset every field back to the loaded project (used by Cancel). */
  function resetForm() {
    setName(isPlaceholderName ? '' : (pr.name ?? ''))
    setCode(pr.code ?? '')
    setCustomerId(pr.customer_id ?? '')
    setForemanId(pr.foreman_id ?? '')
    setManagerId(pr.manager_id ?? '')
    setStatus(pr.status ?? 'active')
    setBillingMethod(pr.billing_method ?? '')
    setCustomerPoNumber(pr.customer_po_number ?? '')
    setStartsOn(pr.starts_on ?? '')
    setEndsOn(pr.ends_on ?? '')
    setContractValue(payload.contractValue != null ? Number(payload.contractValue).toFixed(2) : '')
    setNotes(pr.notes ?? '')
    setSubsidiaryId(pr.subsidiary_id ?? '')
    setSubsidiaryIncludeChildren(pr.subsidiary_include_children !== false)
    setTasks(
      payload.tasks.map((t) => ({
        id: t.id,
        code: t.code ?? '',
        name: t.name ?? '',
        status: t.status ?? 'open',
        estimatedHours: t.estimated_hours != null ? Number(t.estimated_hours).toString() : '',
        estimatedCost: t.estimated_cost != null ? Number(t.estimated_cost).toFixed(2) : '',
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
      headerActions={
        <>
          {mode === 'edit' ? (
            <>
              <Button disabled={busy} onClick={save}>
                {busy ? tCommon('actions.saving') : tCommon('actions.save')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {tCommon('actions.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Link href={`/projects/${pr.id}`}>
                <Button variant="outline">
                  <LayoutDashboard size={15} /> {t('drawer.openCockpit')}
                </Button>
              </Link>
              {canManage ? (
                <>
                  <Button variant="outline" onClick={() => setMode('edit')}>
                    {tCommon('actions.edit')}
                  </Button>
                  {isActive ? (
                    <Button variant="outline" disabled={busy} onClick={() => setActiveState(false)}>
                      {t('drawer.deactivate')}
                    </Button>
                  ) : (
                    <>
                      {!nameValid ? (
                        <span className="text-xs text-slate-500 dark:text-slate-400">{t('drawer.nameToActivate')}</span>
                      ) : null}
                      <Button disabled={busy || !nameValid} onClick={() => setActiveState(true)}>
                        {t('drawer.activate')}
                      </Button>
                    </>
                  )}
                </>
              ) : null}
            </>
          )}
        </>
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              'text-xs ' +
              (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
            }
          >
            {mode === 'edit'
              ? saveState === 'saving'
                ? tCommon('actions.saving')
                : saveState === 'error'
                  ? t('drawer.saveFailedRetry')
                  : dirty
                    ? t('drawer.unsavedChanges')
                    : null
              : null}
          </span>
        </div>
      }
    >
      <div className="space-y-7 p-1">
        {/* -- identity ------------------------------------------------- */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {tCommon('labels.name')}<span className="text-red-500"> *</span>
            </Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('drawer.namePlaceholder')} disabled={ro} />
          </div>
          <div className={field}>
            <Label>{t('labels.code')}</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" placeholder={t('drawer.codePlaceholder')} disabled={ro} />
          </div>
          <div className={field}>
            <Label>{tCommon('labels.status')}</Label>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} disabled={ro}>
              {statusOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>{tCommon('labels.customer')}</Label>
            <SearchSelect
              value={customerId}
              onChange={setCustomerId}
              options={partyOptions}
              clearable
              emptyLabel={t('drawer.noCustomer')}
              placeholder={t('drawer.selectCustomer')}
              sheetTitle={tCommon('labels.customer')}
              ariaLabel={tCommon('labels.customer')}
              disabled={ro}
            />
          </div>
          <div className={field}>
            <Label>{t('labels.billingMethod')}</Label>
            <Select value={billingMethod} onChange={(e) => setBillingMethod(e.target.value)} disabled={ro}>
              <option value="">—</option>
              {billingOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className={field}>
            <Label>{t('labels.contractValue')}</Label>
            <Input
              inputMode="decimal"
              className="text-right tabular-nums"
              value={contractValue}
              onChange={(e) => setContractValue(e.target.value)}
              disabled={ro}
            />
          </div>
        </section>

        {subsidiaries.length > 1 ? (
          <section className="grid gap-4 sm:grid-cols-2">
            <div className={field}>
              <Label>{t('drawer.subsidiaryRestriction')}</Label>
              <Select value={subsidiaryId} onChange={(e) => setSubsidiaryId(e.target.value)} disabled={ro}>
                <option value="">{t('drawer.allSubsidiaries')}</option>
                {subsidiaries.map((s) => (
                  <option key={s.id} value={s.id}>{`${'— '.repeat(s.depth)}${s.name}`}</option>
                ))}
              </Select>
            </div>
            {subsidiaryId ? (
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={subsidiaryIncludeChildren}
                  onChange={(e) => setSubsidiaryIncludeChildren(e.target.checked)}
                  disabled={ro}
                  className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
                {t('drawer.includeChildSubsidiaries')}
              </label>
            ) : null}
          </section>
        ) : null}

        {/* -- assignment / schedule ----------------------------------- */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={field}>
            <Label>{t('labels.foreman')}</Label>
            <SearchSelect
              value={foremanId}
              onChange={setForemanId}
              options={partyOptions}
              clearable
              emptyLabel={t('drawer.noForeman')}
              placeholder={t('drawer.selectForeman')}
              sheetTitle={t('labels.foreman')}
              ariaLabel={t('labels.foreman')}
              disabled={ro}
            />
          </div>
          <div className={field}>
            <Label>{t('labels.manager')}</Label>
            <SearchSelect
              value={managerId}
              onChange={setManagerId}
              options={partyOptions}
              clearable
              emptyLabel={t('drawer.noManager')}
              placeholder={t('drawer.selectManager')}
              sheetTitle={t('labels.manager')}
              ariaLabel={t('labels.manager')}
              disabled={ro}
            />
          </div>
          <div className={field}>
            <Label>{t('labels.customerPo')}</Label>
            <Input value={customerPoNumber} onChange={(e) => setCustomerPoNumber(e.target.value)} className="font-mono" disabled={ro} />
          </div>
          <div className={field}>
            <Label>{t('labels.startDate')}</Label>
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} disabled={ro} />
          </div>
          <div className={field}>
            <Label>{t('labels.endDate')}</Label>
            <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} disabled={ro} />
          </div>
        </section>

        {/* -- WBS tasks (cost budget) --------------------------------- */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('drawer.wbsTitle')}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('drawer.wbsDescription')}
              </p>
            </div>
            {!ro ? (
              <Button variant="outline" size="sm" onClick={() => setTasks([...tasks, emptyTask()])}>
                <Plus size={14} /> {t('drawer.addTask')}
              </Button>
            ) : null}
          </div>
          {tasks.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('drawer.noTasks')}</p>
          ) : (
            <div className="space-y-2">
              {tasks.map((task, i) => (
                <div key={task.id ?? `new-${i}`} className="grid items-end gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-12 dark:border-slate-800">
                  <div className={`${field} sm:col-span-2`}>
                    <Label>{t('labels.code')}</Label>
                    <Input value={task.code} onChange={(e) => setTask(i, { code: e.target.value })} className="font-mono" disabled={ro} />
                  </div>
                  <div className={`${field} sm:col-span-4`}>
                    <Label>{t('labels.task')}</Label>
                    <Input value={task.name} onChange={(e) => setTask(i, { name: e.target.value })} placeholder={t('drawer.taskNamePlaceholder')} disabled={ro} />
                  </div>
                  <div className={`${field} sm:col-span-2`}>
                    <Label>{t('labels.estHours')}</Label>
                    <Input
                      inputMode="decimal"
                      className="text-right tabular-nums"
                      value={task.estimatedHours}
                      onChange={(e) => setTask(i, { estimatedHours: e.target.value })}
                      disabled={ro}
                    />
                  </div>
                  <div className={`${field} sm:col-span-2`}>
                    <Label>{t('labels.estCost')}</Label>
                    <Input
                      inputMode="decimal"
                      className="text-right tabular-nums"
                      value={task.estimatedCost}
                      onChange={(e) => setTask(i, { estimatedCost: e.target.value })}
                      disabled={ro}
                    />
                  </div>
                  <div className={`${field} sm:col-span-2`}>
                    <Label>{tCommon('labels.status')}</Label>
                    <Select value={task.status} onChange={(e) => setTask(i, { status: e.target.value })} disabled={ro}>
                      {taskStatusOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {!ro ? (
                    <div className="sm:col-span-12 flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setTasks(tasks.filter((_, j) => j !== i))}
                        aria-label={t('drawer.removeTaskAria')}
                      >
                        <Trash2 size={14} /> {tCommon('actions.remove')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* -- notes --------------------------------------------------- */}
        <section className={field}>
          <Label>{tCommon('labels.notes')}</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={ro} />
        </section>
      </div>
    </UrlDrawer>
  )
}
