'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LayoutDashboard, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Select, Textarea, UrlDrawer } from '@openbooks/ui'

interface PartyOpt {
  id: string
  display_name?: string | null
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

const STATUS_OPTIONS = [
  { value: 'quoted', label: 'Quoted' },
  { value: 'awarded', label: 'Awarded' },
  { value: 'active', label: 'Active' },
  { value: 'substantially_complete', label: 'Substantially complete' },
  { value: 'closed', label: 'Closed' },
  { value: 'cancelled', label: 'Cancelled' },
]

const BILLING_OPTIONS = [
  { value: 'time_and_materials', label: 'Time & materials' },
  { value: 'fixed_price', label: 'Fixed price' },
  { value: 'cost_plus', label: 'Cost plus' },
]

const TASK_STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'complete', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
]

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
  canManage,
  basePath = '/projects',
}: {
  payload: ProjectPayload
  parties: PartyOpt[]
  canManage: boolean
  basePath?: string
}) {
  const router = useRouter()
  const pr = payload.project
  const isPlaceholderName = pr.name === 'New project'

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

  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  const nameValid = name.trim().length > 0 && name.trim() !== 'New project'

  const partyOptions = useMemo(
    () => parties.map((p) => ({ value: p.id, label: p.display_name ?? '' })),
    [parties],
  )

  function setTask(i: number, patch: Partial<TaskRow>) {
    setTasks((rows) => rows.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  }

  // -- autosave (debounced PATCH) ------------------------------------------
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
    [name, code, customerId, foremanId, managerId, status, billingMethod, customerPoNumber, startsOn, endsOn, contractValue, notes, tasks, isActive],
  )
  const first = useRef(true)
  useEffect(() => {
    if (!canManage) return
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('dirty')
    const t = setTimeout(async () => {
      setSaveState('saving')
      const res = await fetch(`/api/projects/${pr.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(savePayload),
      })
      if (res.ok) {
        setSaveState('saved')
        router.refresh()
      } else {
        setSaveState('error')
        toast.error((await res.json()).error ?? 'Autosave failed')
      }
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savePayload, canManage])

  async function setActiveState(next: boolean) {
    setBusy(true)
    const res = await fetch(`/api/projects/${pr.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: next }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Update failed')
    else {
      setIsActive(next)
      toast.success(next ? 'Project activated' : 'Project deactivated')
    }
    setBusy(false)
    router.refresh()
  }

  const ro = !canManage

  return (
    <UrlDrawer
      open
      closeHref={basePath}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{name.trim() || 'New project'}</span>
          <Badge variant={isActive ? 'success' : 'outline'}>{isActive ? 'Active' : 'Inactive'}</Badge>
        </span>
      }
      description={canManage ? 'Changes save automatically.' : undefined}
      headerActions={
        <>
          <Link href={`/projects/${pr.id}`}>
            <Button variant="outline">
              <LayoutDashboard size={15} /> Open cockpit
            </Button>
          </Link>
          {canManage ? (
            isActive ? (
              <Button variant="outline" disabled={busy} onClick={() => setActiveState(false)}>
                Deactivate
              </Button>
            ) : (
              <>
                {!nameValid ? (
                  <span className="text-xs text-slate-500 dark:text-slate-400">Name the project to activate it</span>
                ) : null}
                <Button disabled={busy || !nameValid} onClick={() => setActiveState(true)}>
                  Activate
                </Button>
              </>
            )
          ) : null}
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
            {canManage
              ? saveState === 'saved'
                ? 'All changes saved'
                : saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'error'
                    ? 'Save failed — fix and retry'
                    : 'Unsaved changes…'
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
              Name<span className="text-red-500"> *</span>
            </Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project or job name…" disabled={ro} />
          </div>
          <div className={field}>
            <Label>Code</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" placeholder="JOB-01" disabled={ro} />
          </div>
          <div className={field}>
            <Label>Status</Label>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} disabled={ro}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>Customer</Label>
            <SearchSelect
              value={customerId}
              onChange={setCustomerId}
              options={partyOptions}
              clearable
              emptyLabel="No customer"
              placeholder="Select customer…"
              sheetTitle="Customer"
              ariaLabel="Customer"
              disabled={ro}
            />
          </div>
          <div className={field}>
            <Label>Billing method</Label>
            <Select value={billingMethod} onChange={(e) => setBillingMethod(e.target.value)} disabled={ro}>
              <option value="">—</option>
              {BILLING_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className={field}>
            <Label>Contract value</Label>
            <Input
              inputMode="decimal"
              className="text-right tabular-nums"
              value={contractValue}
              onChange={(e) => setContractValue(e.target.value)}
              disabled={ro}
            />
          </div>
        </section>

        {/* -- assignment / schedule ----------------------------------- */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={field}>
            <Label>Foreman</Label>
            <SearchSelect
              value={foremanId}
              onChange={setForemanId}
              options={partyOptions}
              clearable
              emptyLabel="No foreman"
              placeholder="Select foreman…"
              sheetTitle="Foreman"
              ariaLabel="Foreman"
              disabled={ro}
            />
          </div>
          <div className={field}>
            <Label>Manager</Label>
            <SearchSelect
              value={managerId}
              onChange={setManagerId}
              options={partyOptions}
              clearable
              emptyLabel="No manager"
              placeholder="Select manager…"
              sheetTitle="Manager"
              ariaLabel="Manager"
              disabled={ro}
            />
          </div>
          <div className={field}>
            <Label>Customer PO #</Label>
            <Input value={customerPoNumber} onChange={(e) => setCustomerPoNumber(e.target.value)} className="font-mono" disabled={ro} />
          </div>
          <div className={field}>
            <Label>Start date</Label>
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} disabled={ro} />
          </div>
          <div className={field}>
            <Label>End date</Label>
            <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} disabled={ro} />
          </div>
        </section>

        {/* -- WBS tasks (cost budget) --------------------------------- */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Work breakdown & cost budget</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Tasks and their estimated hours / cost. The cost budget is the sum of these estimates.
              </p>
            </div>
            {!ro ? (
              <Button variant="outline" size="sm" onClick={() => setTasks([...tasks, emptyTask()])}>
                <Plus size={14} /> Add task
              </Button>
            ) : null}
          </div>
          {tasks.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No tasks yet.</p>
          ) : (
            <div className="space-y-2">
              {tasks.map((t, i) => (
                <div key={t.id ?? `new-${i}`} className="grid items-end gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-12 dark:border-slate-800">
                  <div className={`${field} sm:col-span-2`}>
                    <Label>Code</Label>
                    <Input value={t.code} onChange={(e) => setTask(i, { code: e.target.value })} className="font-mono" disabled={ro} />
                  </div>
                  <div className={`${field} sm:col-span-4`}>
                    <Label>Task</Label>
                    <Input value={t.name} onChange={(e) => setTask(i, { name: e.target.value })} placeholder="Task name…" disabled={ro} />
                  </div>
                  <div className={`${field} sm:col-span-2`}>
                    <Label>Est. hours</Label>
                    <Input
                      inputMode="decimal"
                      className="text-right tabular-nums"
                      value={t.estimatedHours}
                      onChange={(e) => setTask(i, { estimatedHours: e.target.value })}
                      disabled={ro}
                    />
                  </div>
                  <div className={`${field} sm:col-span-2`}>
                    <Label>Est. cost</Label>
                    <Input
                      inputMode="decimal"
                      className="text-right tabular-nums"
                      value={t.estimatedCost}
                      onChange={(e) => setTask(i, { estimatedCost: e.target.value })}
                      disabled={ro}
                    />
                  </div>
                  <div className={`${field} sm:col-span-2`}>
                    <Label>Status</Label>
                    <Select value={t.status} onChange={(e) => setTask(i, { status: e.target.value })} disabled={ro}>
                      {TASK_STATUS_OPTIONS.map((o) => (
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
                        aria-label="Remove task"
                      >
                        <Trash2 size={14} /> Remove
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
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={ro} />
        </section>
      </div>
    </UrlDrawer>
  )
}
