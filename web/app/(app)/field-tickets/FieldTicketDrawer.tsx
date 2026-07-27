'use client'

import { useMoney } from '@/components/money-provider'
import Link from 'next/link'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Mail, Plus, Send, Trash2 } from 'lucide-react'
import { Badge, Button, Input, Label, SearchSelect, Select, Textarea, cn } from '@openbooks/ui'
import { defaultFormLayout, type FormLayoutConfig, type HeaderFieldPlacement } from '@openbooks/customization'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import { PdfButton } from '../../../components/pdf-button'
/**
 * The field-ticket flyout — the standard transaction drawer: configurable
 * header form (project → derives customer/PO/period), then the ticket's own
 * sections (crew hours grid, equipment & materials, totals, signatures).
 * Draft tickets edit in place; submitted/approved are read-only views with
 * lifecycle actions in the drawer header.
 */

interface Opt {
  id: string
  name: string
}
interface TimeTypeOpt extends Opt {
  bill_multiplier: string
}
interface ProjectOpt extends Opt {
  customerName: string | null
  period: string
}
interface ProjectTaskOpt extends Opt {
  code: string | null
  status: string
  estimatedHours: string | null
}
interface EquipmentOpt extends Opt {
  unitNumber: string
  chargeItemId: string
}

interface EntryRow {
  id: string
  employee_party_id: string
  employee_name: string
  item_id: string | null
  item_name: string | null
  time_type_id: string
  project_task_id: string | null
  project_task_name: string | null
  worked_on: string
  hours: string
  bill_rate: string | null
}

interface LineRow {
  id: string
  item_id: string | null
  item_name: string | null
  description: string | null
  quantity: string
  unit: string | null
  unit_price: string
  amount: string
  bill_rate: string | null
  bill_amount: string | null
  equipment_name: string | null
  rate_components: { rateLineId: string | null; unitCode: string; unitName: string; quantity: string; rate: string; amount: string }[]
}

interface RateUnitOpt {
  unitCode: string
  unitName: string
  baseQuantity: string
  costRate: string
  billRate: string
}

export interface TicketPayload {
  id: string
  documentNumber: string
  status: string
  documentDate: string
  referenceNumber: string | null
  memo: string | null
  customerName: string
  customerEmail?: string | null
  projectId: string | null
  projectName: string
  foremanName: string
  fieldTicket: {
    period: string
    periodStart: string
    periodEnd: string
    foremanPartyId: string | null
    rejectionReason?: string
    signatures?: { customer?: { name: string; at: string; image?: string | null } }
    send?: { to?: string | null; sentAt: string; expiresAt?: string | null; respondedAt?: string | null }
  }
  entries: EntryRow[]
  lines: LineRow[]
  laborTotal: string
  linesTotal: string
  grandTotal: string
}

interface GridRow {
  employeePartyId: string
  itemId: string | null
  projectTaskId: string | null
  cells: Record<string, string>
}

const STATUS_VARIANT: Record<string, 'secondary' | 'warning' | 'success' | 'outline'> = {
  draft: 'secondary',
  pending_approval: 'warning',
  approved: 'success',
  voided: 'outline',
}

function daysBetween(start: string, end: string): string[] {
  const out: string[] = []
  const [y, m, d] = start.split('-').map(Number)
  const cur = new Date(Date.UTC(y, m - 1, d, 12))
  for (let i = 0; i < 14; i++) {
    const isoDay = cur.toISOString().slice(0, 10)
    out.push(isoDay)
    if (isoDay >= end) break
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

function ticketWindow(period: string, anchor: string): { start: string; end: string } {
  const [y, m, d] = anchor.split('-').map(Number)
  if (period !== 'weekly') return { start: anchor, end: anchor }
  const date = new Date(Date.UTC(y, m - 1, d, 12))
  date.setUTCDate(date.getUTCDate() - date.getUTCDay())
  const start = date.toISOString().slice(0, 10)
  date.setUTCDate(date.getUTCDate() + 6)
  return { start, end: date.toISOString().slice(0, 10) }
}

function buildGrid(entries: EntryRow[]): GridRow[] {
  const byKey = new Map<string, GridRow>()
  for (const e of entries) {
    const k = `${e.employee_party_id}|${e.item_id ?? ''}|${e.project_task_id ?? ''}`
    let row = byKey.get(k)
    if (!row) {
      row = { employeePartyId: e.employee_party_id, itemId: e.item_id, projectTaskId: e.project_task_id, cells: {} }
      byKey.set(k, row)
    }
    row.cells[`${e.time_type_id}|${e.worked_on}`] = String(Number(e.hours))
  }
  return [...byKey.values()]
}

export function FieldTicketDrawer(props: {
  ticket: TicketPayload
  employees: Opt[]
  laborItems: Opt[]
  timeTypes: TimeTypeOpt[]
  catalogItems: { id: string; name: string; kind: string; default_rate: string | null }[]
  projects: ProjectOpt[]
  projectTasks: ProjectTaskOpt[]
  equipmentUnits: EquipmentOpt[]
  equipmentEnabled: boolean
  layout?: FormLayoutConfig
  availableLayouts?: { id: string; name: string }[]
  currentLayoutId?: string | null
  canCustomize?: boolean
  canManage: boolean
}) {
  const { money } = useMoney()
  const t = useTranslations('fieldTickets')
  const tCommon = useTranslations('common')
  const tNav = useTranslations('nav')
  const router = useRouter()
  const searchParams = useSearchParams()
  const [ticket, setTicket] = useState(props.ticket)
  // Record flyouts always open read-only. Draft editing is an explicit
  // Edit -> Save/Cancel cycle, consistent with the other transaction drawers.
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [grid, setGrid] = useState<GridRow[]>(() => buildGrid(props.ticket.entries))
  const [gridDirty, setGridDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendTo, setSendTo] = useState(props.ticket.customerEmail ?? '')
  const [sendMessage, setSendMessage] = useState('')
  const [customerName, setCustomerName] = useState(props.ticket.customerName)
  const [projectTasks, setProjectTasks] = useState(props.projectTasks)

  // Header form state (standard configurable form fields).
  const [projectId, setProjectId] = useState(props.ticket.projectId ?? '')
  const [documentDate, setDocumentDate] = useState(props.ticket.documentDate)
  const [referenceNumber, setReferenceNumber] = useState(props.ticket.referenceNumber ?? '')
  const [memo, setMemo] = useState(props.ticket.memo ?? '')
  const [period, setPeriod] = useState(props.ticket.fieldTicket.period)
  const [foreman, setForeman] = useState(props.ticket.fieldTicket.foremanPartyId ?? '')
  const [headerDirty, setHeaderDirty] = useState(false)

  // Add-line form.
  const [lineItem, setLineItem] = useState('')
  const [lineQty, setLineQty] = useState('1')
  const [lineRate, setLineRate] = useState('')
  const [lineAmount, setLineAmount] = useState('')
  const [lineEquipment, setLineEquipment] = useState('')
  const [lineRateUnit, setLineRateUnit] = useState('')
  const [lineRateUnits, setLineRateUnits] = useState<RateUnitOpt[]>([])
  const [lineRateLoading, setLineRateLoading] = useState(false)
  const [lineRateSource, setLineRateSource] = useState<'rate_book' | 'item_default' | ''>('')
  const [lineComponents, setLineComponents] = useState<{ unitName: string; quantity: string; rate: string; amount: string }[]>([])

  const effectiveLayout = props.layout ?? defaultFormLayout('field_ticket')
  const actionLayout = effectiveLayout.actions
  const canEditStatus = ticket.status === 'draft' && props.canManage
  const editable = mode === 'edit' && canEditStatus
  const gridHasHours = grid.some((row) => Object.values(row.cells).some((value) => Number(value) > 0))
  const visibleWindow = useMemo(
    () => editable && !gridHasHours
      ? ticketWindow(period, documentDate)
      : { start: ticket.fieldTicket.periodStart, end: ticket.fieldTicket.periodEnd },
    [documentDate, editable, gridHasHours, period, ticket.fieldTicket.periodEnd, ticket.fieldTicket.periodStart],
  )
  const days = useMemo(() => daysBetween(visibleWindow.start, visibleWindow.end), [visibleWindow])
  const sig = ticket.fieldTicket.signatures

  const selectedItem = props.catalogItems.find((item) => item.id === lineItem)
  const equipmentOptions = props.equipmentUnits.filter((unit) => unit.chargeItemId === lineItem)
  const requestedSection = searchParams.get('transactionTab')
  const activeSection = requestedSection === 'time' || requestedSection === 'items' || requestedSection === 'tasks'
    ? requestedSection
    : 'details'

  useEffect(() => {
    if (!editable || !projectId || !lineItem) {
      setLineRate('')
      setLineAmount('')
      setLineRateSource('')
      setLineComponents([])
      setLineRateUnit('')
      setLineRateUnits([])
      setLineRateLoading(false)
      return
    }
    if (!Number.isInteger(Number(lineQty)) || Number(lineQty) <= 0) {
      setLineRate('')
      setLineAmount('')
      setLineRateSource('')
      setLineComponents([])
      setLineRateLoading(false)
      return
    }
    const controller = new AbortController()
    let active = true
    setLineRateLoading(true)
    const query = new URLSearchParams({ projectId, itemId: lineItem, quantity: lineQty, onDate: visibleWindow.end })
    if (lineEquipment) query.set('equipmentUnitId', lineEquipment)
    if (lineRateUnit) query.set('rateUnitCode', lineRateUnit)
    void fetch(`/api/field-tickets/item-rate?${query}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error ?? 'Could not resolve item rate')
        if (!active) return
        const rateUnits = Array.isArray(body.rateUnits) ? body.rateUnits as RateUnitOpt[] : []
        setLineRateUnits(rateUnits)
        if (rateUnits.length === 0) setLineRateUnit('')
        else if (!rateUnits.some((unit) => unit.unitCode === lineRateUnit)) setLineRateUnit(rateUnits[0]!.unitCode)
        setLineRate(String(body.rate ?? ''))
        setLineAmount(String(body.amount ?? ''))
        setLineRateSource(body.source === 'rate_book' ? 'rate_book' : 'item_default')
        setLineComponents(Array.isArray(body.components) ? body.components : [])
      })
      .catch((error) => {
        if (active && error.name !== 'AbortError') {
          setLineRate('')
          setLineAmount('')
          setLineRateSource('')
          setLineComponents([])
          if (lineRateUnit) setLineRateUnit('')
        }
      })
      .finally(() => { if (active) setLineRateLoading(false) })
    return () => {
      active = false
      controller.abort()
    }
  }, [editable, lineEquipment, lineItem, lineQty, lineRateUnit, projectId, visibleWindow.end])

  function applyPayload(j: TicketPayload) {
    setTicket(j)
    setCustomerName(j.customerName)
    setGrid(buildGrid(j.entries))
    setGridDirty(false)
    setProjectId(j.projectId ?? '')
    setDocumentDate(j.documentDate)
    setReferenceNumber(j.referenceNumber ?? '')
    setMemo(j.memo ?? '')
    setPeriod(j.fieldTicket.period)
    setForeman(j.fieldTicket.foremanPartyId ?? '')
    setSendTo(j.fieldTicket.send?.to ?? j.customerEmail ?? '')
    setHeaderDirty(false)
  }

  async function selectProject(nextProjectId: string) {
    setProjectId(nextProjectId)
    setHeaderDirty(true)
    setLineEquipment('')
    setLineRateUnit('')
    setLineRateUnits([])
    const option = props.projects.find((project) => project.id === nextProjectId)
    setCustomerName(option?.customerName ?? '')
    if (!gridHasHours && option?.period) setPeriod(option.period)
    if (!nextProjectId) {
      setProjectTasks([])
      return
    }
    try {
      const response = await fetch(`/api/field-tickets/project-context?projectId=${encodeURIComponent(nextProjectId)}`)
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Could not load project')
      setCustomerName(body.customerName ?? '')
      setProjectTasks(Array.isArray(body.tasks) ? body.tasks : [])
      if (!gridHasHours && body.period) setPeriod(body.period)
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  async function call(
    method: 'POST' | 'PATCH',
    payload: Record<string, unknown>,
    options: { preserveDraft?: boolean } = {},
  ): Promise<boolean> {
    setBusy(true)
    try {
      const res = await fetch(`/api/field-tickets/${ticket.id}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      if (options.preserveDraft) {
        // Some ticket operations persist immediately (header, grid, item
        // lines). Keep the other unsaved work area intact while refreshing
        // server-owned totals and snapshots.
        setTicket(j)
        setCustomerName(j.customerName)
      } else {
        applyPayload(j)
      }
      router.refresh()
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function saveHeader(): Promise<boolean> {
    if (!headerDirty) return true
    const saved = await call('PATCH', {
      projectId: projectId || null,
      documentDate,
      referenceNumber: referenceNumber || null,
      memo: memo || null,
      period,
      foremanPartyId: foreman || null,
    }, { preserveDraft: true })
    if (saved) setHeaderDirty(false)
    return saved
  }

  async function saveGrid(): Promise<boolean> {
    const rows = grid
      .filter((r) => r.employeePartyId)
      .flatMap((r) => {
        const byType: Record<string, Record<string, number>> = {}
        for (const [k, v] of Object.entries(r.cells)) {
          const [timeTypeId, day] = k.split('|')
          const h = Number(v)
          if (!Number.isFinite(h) || h <= 0) continue
          ;(byType[timeTypeId] ??= {})[day] = h
        }
        return Object.entries(byType).map(([timeTypeId, hours]) => ({
          employeePartyId: r.employeePartyId,
          itemId: r.itemId,
          projectTaskId: r.projectTaskId,
          timeTypeId,
          hours,
        }))
      })
    const saved = await call('POST', { action: 'save-grid', rows }, { preserveDraft: true })
    if (saved) setGridDirty(false)
    return saved
  }

  async function addItemLine() {
    if (!lineItem) return toast.error(t('editor.lines.itemRequired'))
    if (!Number.isInteger(Number(lineQty)) || Number(lineQty) < 1) return
    // The quote uses the selected project and period. Persist that context
    // before stamping the identical rate-unit snapshot on the new line.
    if (headerDirty && !(await saveHeader())) return
    if (await call(
      'POST',
      { action: 'add-line', itemId: lineItem, quantity: Number(lineQty), rateUnitCode: lineRateUnit || null, equipmentUnitId: lineEquipment || null },
      { preserveDraft: true },
    )) {
      setLineItem('')
      setLineQty('1')
      setLineRate('')
      setLineAmount('')
      setLineEquipment('')
      setLineRateUnit('')
      setLineRateUnits([])
      setLineRateSource('')
      setLineComponents([])
    }
  }

  async function saveAll(): Promise<boolean> {
    if (headerDirty && !(await saveHeader())) return false
    if (gridDirty && !(await saveGrid())) return false
    return true
  }

  async function submit() {
    if (!(await saveAll())) return
    if (await call('POST', { action: 'submit' })) {
      setMode('view')
      toast.success(t('editor.submitted'))
    }
  }

  function cancelEdit() {
    const savedProjectId = ticket.projectId
    applyPayload(ticket)
    setLineItem('')
    setLineQty('1')
    setLineRate('')
    setLineAmount('')
    setLineEquipment('')
    setLineRateUnit('')
    setLineRateUnits([])
    setLineRateSource('')
    setLineComponents([])
    if (!savedProjectId) {
      setProjectTasks([])
    } else if (savedProjectId === props.ticket.projectId) {
      setProjectTasks(props.projectTasks)
    } else {
      void fetch(`/api/field-tickets/project-context?projectId=${encodeURIComponent(savedProjectId)}`)
        .then(async (response) => {
          const body = await response.json()
          if (response.ok) setProjectTasks(Array.isArray(body.tasks) ? body.tasks : [])
        })
        .catch(() => setProjectTasks([]))
    }
    setMode('view')
  }

  const markHeader = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v)
    setHeaderDirty(true)
  }

  // ---- standard configurable header form -----------------------------------
  const renderHeaderField = (placement: HeaderFieldPlacement, isEditable: boolean) => {
    const label = placement.labelOverride?.trim()
    switch (placement.key) {
      case 'project_id':
        return (
          <>
            <Label>{label || tCommon('labels.project')}{isEditable ? <span className="text-red-500"> *</span> : null}</Label>
            {isEditable ? (
              <SearchSelect
                options={props.projects.map((p) => ({ value: p.id, label: p.name }))}
                value={projectId}
                onChange={(value) => void selectProject(value ?? '')}
                placeholder={t('list.pickProject')}
              />
            ) : (
              <p className="text-sm">{ticket.projectName || '—'}</p>
            )}
          </>
        )
      case 'party_id':
        return (
          <>
            <Label>{label || tCommon('labels.customer')}</Label>
            {isEditable ? (
              <div className="flex min-h-10 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                {customerName || '—'}
              </div>
            ) : (
              <p className="text-sm text-slate-900 dark:text-slate-100">{customerName || '—'}</p>
            )}
          </>
        )
      case 'document_date':
        return (
          <>
            <Label>{label || tCommon('labels.date')}</Label>
            {isEditable ? (
              <Input type="date" value={documentDate} onChange={(e) => markHeader(setDocumentDate)(e.target.value)} />
            ) : (
              <p className="text-sm">{ticket.documentDate}</p>
            )}
          </>
        )
      case 'reference_number':
        return (
          <>
            <Label>{label || t('editor.po')}</Label>
            {isEditable ? (
              <Input value={referenceNumber} onChange={(e) => markHeader(setReferenceNumber)(e.target.value)} />
            ) : (
              <p className="text-sm">{ticket.referenceNumber || '—'}</p>
            )}
          </>
        )
      case 'period':
        return (
          <>
            <Label>{label || t('list.period')}</Label>
            {isEditable ? (
              <Select
                value={period}
                disabled={gridHasHours}
                title={gridHasHours ? t('editor.periodLocked') : undefined}
                onChange={(e) => markHeader(setPeriod)(e.target.value)}
              >
                <option value="shift">{t('period.shift')}</option>
                <option value="daily">{t('period.daily')}</option>
                <option value="weekly">{t('period.weekly')}</option>
              </Select>
            ) : (
              <p className="text-sm text-slate-900 dark:text-slate-100">{t(`period.${ticket.fieldTicket.period}`)}</p>
            )}
          </>
        )
      case 'foreman_party_id':
        return (
          <>
            <Label>{label || t('editor.foreman')}</Label>
            {isEditable ? (
              <SearchSelect
                options={[{ value: '', label: '—' }, ...props.employees.map((e) => ({ value: e.id, label: e.name }))]}
                value={foreman}
                onChange={markHeader((v: string) => setForeman(v ?? ''))}
                placeholder="—"
              />
            ) : (
              <p className="text-sm text-slate-900 dark:text-slate-100">{ticket.foremanName || '—'}</p>
            )}
          </>
        )
      case 'memo':
        return (
          <>
            <Label>{label || t('editor.workDescription')}</Label>
            {isEditable ? (
              <Textarea rows={2} value={memo} onChange={(e) => markHeader(setMemo)(e.target.value)} />
            ) : (
              <p className="whitespace-pre-wrap text-sm">{ticket.memo || '—'}</p>
            )}
          </>
        )
      default:
        return null
    }
  }

  async function setPreferredForm(layoutId: string | null) {
    const response = await fetch('/api/customization/form-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordType: 'field_ticket', layoutId }),
    })
    if (response.ok) toast.success(t('editor.form.preferredSaved'))
    else toast.error((await response.json()).error ?? t('editor.form.preferredFailed'))
  }

  const showFormPicker = mode === 'view' && !!props.availableLayouts?.length
  const customizeHref = props.canCustomize
    ? `/admin/customization?recordType=field_ticket&tab=forms${props.currentLayoutId ? `&form=${props.currentLayoutId}` : ''}`
    : null

  const renderFormAction = (key: string) => {
    switch (key) {
      case 'customize':
        return customizeHref ? <Button variant="ghost" asChild><Link href={customizeHref}>{tCommon('actions.customize')}</Link></Button> : null
      case 'pdf':
        return <PdfButton recordType="field_ticket" recordId={ticket.id} />
      case 'approval':
        return ticket.status === 'pending_approval' ? (
          <Button variant="outline" asChild>
            <Link href="/approvals">{tCommon('actions.view')} {tNav('approvals')}</Link>
          </Button>
        ) : null
      case 'submit':
        return ticket.status === 'draft' && props.canManage ? (
          <Button disabled={busy} onClick={submit}><Send size={14} /> {t('editor.submit')}</Button>
        ) : null
      case 'workflow':
        return ticket.status === 'approved' && props.canManage && !sig?.customer ? (
          <Button disabled={busy} onClick={() => setSending(true)}>
            <Mail size={14} /> {ticket.fieldTicket.send?.sentAt ? t('editor.resendSignature') : t('editor.sendSignature')}
          </Button>
        ) : null
      default:
        return null
    }
  }

  const rowHours = (r: GridRow) => Object.values(r.cells).reduce((a, v) => a + (Number(v) || 0), 0)
  const dayHours = (day: string) =>
    grid.reduce((a, r) => a + props.timeTypes.reduce((b, tt) => b + (Number(r.cells[`${tt.id}|${day}`]) || 0), 0), 0)
  const totalHours = grid.reduce((a, r) => a + rowHours(r), 0)
  const dayLabel = (isoDay: string) => {
    const d = new Date(`${isoDay}T12:00:00Z`)
    return { dow: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }), dom: isoDay.slice(5) }
  }

  return (
    <TransactionDrawer
      closeHref="/field-tickets"
      recordId={ticket.id}
      canEditAttachments={props.canManage}
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{ticket.documentNumber}</span>
          <Badge variant={STATUS_VARIANT[ticket.status] ?? 'secondary'}>{t(`status.${ticket.status}`)}</Badge>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {t(`period.${ticket.fieldTicket.period}`)}
          </span>
        </span>
      }
      description={
        mode === 'edit'
          ? tCommon('feedback.editingHint')
          : ticket.fieldTicket.period === 'weekly'
          ? `${ticket.fieldTicket.periodStart} → ${ticket.fieldTicket.periodEnd}`
          : ticket.fieldTicket.periodStart
      }
      primaryAction={
        canEditStatus && actionLayout.find((action) => action.key === 'edit')?.visible !== false ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs"
            disabled={busy}
            onClick={() => mode === 'edit' ? cancelEdit() : setMode('edit')}
          >
            {mode === 'edit' ? tCommon('actions.cancel') : tCommon('actions.edit')}
          </Button>
        ) : null
      }
      actionsMenuHeader={showFormPicker && !sending ? (
        <div className="mb-1.5 space-y-1.5 border-b border-slate-100 px-1 pb-2 dark:border-slate-800">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{t('editor.form.label')}</span>
          <Select
            value={props.currentLayoutId ?? ''}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams.toString())
              next.set('form', event.target.value)
              router.push(`/field-tickets?${next.toString()}`)
            }}
            aria-label={t('editor.form.label')}
            triggerClassName="!h-8 !min-h-0 !px-2 !py-0 !text-xs"
          >
            {props.availableLayouts!.map((availableLayout) => (
              <option key={availableLayout.id} value={availableLayout.id}>{availableLayout.name}</option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="sm"
            className="!h-8 w-full !justify-start !px-2 !text-xs"
            onClick={() => void setPreferredForm(props.currentLayoutId ?? null)}
            disabled={!props.currentLayoutId}
          >
            {t('editor.form.setPreferred')}
          </Button>
        </div>
      ) : null}
      detailTabs={[
        { key: 'time', label: t('editor.tabs.time') },
        { key: 'items', label: t('editor.tabs.items') },
        ...(projectTasks.length > 0 ? [{ key: 'tasks', label: t('editor.tabs.tasks') }] : []),
      ]}
      actions={
        <>
          {mode === 'edit' ? (
            <>
              {actionLayout.find((action) => action.key === 'customize')?.visible ? renderFormAction('customize') : null}
              <Button disabled={busy} onClick={async () => {
                if (await saveAll()) setMode('view')
              }}>
                {busy ? tCommon('actions.saving') : tCommon('actions.save')}
              </Button>
            </>
          ) : (
            sending ? (
              <div className="space-y-2.5 px-1 py-1">
                <div className="space-y-1">
                  <Label htmlFor="ft-send-to" className="text-xs">{t('editor.sendTo')}</Label>
                  <Input id="ft-send-to" type="email" value={sendTo} onChange={(event) => setSendTo(event.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ft-send-msg" className="text-xs">{t('editor.sendMessage')}</Label>
                  <Textarea id="ft-send-msg" rows={3} value={sendMessage} onChange={(event) => setSendMessage(event.target.value)} />
                </div>
                <p className="px-1 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{t('editor.signatures.deliveryHelp')}</p>
                <Button
                  disabled={busy || !sendTo.trim()}
                  onClick={async () => {
                    if (await call('POST', { action: 'send-signature', to: sendTo, message: sendMessage || null })) {
                      setSending(false)
                      setSendMessage('')
                      toast.success(t('editor.signatureSent', { to: sendTo }))
                    }
                  }}
                >
                  <Send size={14} /> {t('editor.send')}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setSending(false)}>{t('editor.cancel')}</Button>
              </div>
            ) : (
              <>
                {actionLayout.filter((action) => action.visible && action.key !== 'edit').map((action) => (
                  <Fragment key={action.key}>{renderFormAction(action.key)}</Fragment>
                ))}
              </>
            )
          )}
        </>
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {mode === 'edit' && (headerDirty || gridDirty) ? tCommon('feedback.unsavedChanges') : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm tabular-nums text-slate-600 dark:text-slate-300">
            {t('editor.totals.labor')} {money(ticket.laborTotal)} · {t('editor.totals.items')} {money(ticket.linesTotal)} ·{' '}
            <strong className="text-slate-900 dark:text-slate-100">{money(ticket.grandTotal)}</strong>
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        {activeSection === 'details' ? <>
        {ticket.fieldTicket.rejectionReason && ticket.status === 'draft' && (
          <div className="rounded-md bg-rose-50 p-2.5 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
            {t('editor.rejectionNote', { reason: ticket.fieldTicket.rejectionReason })}
          </div>
        )}

        <HeaderFields layout={effectiveLayout} editable={editable} renderField={renderHeaderField} />
        </> : null}

        {/* ---- crew hours ---- */}
        {activeSection === 'time' ? <section>
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('editor.crew.title')}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('editor.crew.hint')}</p>
            </div>
            <span className="text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
              {t('editor.crew.total', { hours: totalHours.toFixed(1) })}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                  <th className="py-1 pr-2 font-medium">{t('editor.crew.employee')}</th>
                  <th className="py-1 pr-2 font-medium">{t('editor.crew.laborItem')}</th>
                  {projectTasks.length > 0 ? <th className="py-1 pr-2 font-medium">{t('editor.crew.task')}</th> : null}
                  {days.map((d) => {
                    const l = dayLabel(d)
                    return (
                      <th key={d} className="px-1 py-1 text-center font-medium">
                        <div>{l.dow}</div>
                        <div className="font-normal text-slate-400">{l.dom}</div>
                      </th>
                    )
                  })}
                  <th className="py-1 pl-2 text-right font-medium">{t('editor.crew.rowTotal')}</th>
                  {editable && <th className="w-8" />}
                </tr>
              </thead>
              <tbody>
                {grid.map((row, i) => (
                  <tr key={i} className="border-t border-slate-100 align-top dark:border-slate-800">
                    <td className="min-w-40 py-1.5 pr-2">
                      {editable ? (
                        <SearchSelect
                          options={props.employees.map((emp) => ({ value: emp.id, label: emp.name }))}
                          value={row.employeePartyId}
                          onChange={(v) => {
                            setGrid((g) => g.map((r, j) => (j === i ? { ...r, employeePartyId: v ?? '' } : r)))
                            setGridDirty(true)
                          }}
                          placeholder="—"
                          triggerClassName="h-8"
                        />
                      ) : (
                        <span className="text-sm">{props.employees.find((e) => e.id === row.employeePartyId)?.name ?? '—'}</span>
                      )}
                    </td>
                    <td className="min-w-36 py-1.5 pr-2">
                      {editable ? (
                        <SearchSelect
                          options={[{ value: '', label: '—' }, ...props.laborItems.map((it) => ({ value: it.id, label: it.name }))]}
                          value={row.itemId ?? ''}
                          onChange={(v) => {
                            setGrid((g) => g.map((r, j) => (j === i ? { ...r, itemId: v || null } : r)))
                            setGridDirty(true)
                          }}
                          placeholder="—"
                          triggerClassName="h-8"
                        />
                      ) : (
                        <span className="text-xs text-slate-500">{props.laborItems.find((x) => x.id === row.itemId)?.name ?? '—'}</span>
                      )}
                    </td>
                    {projectTasks.length > 0 ? (
                      <td className="min-w-40 py-1.5 pr-2">
                        {editable ? (
                          <SearchSelect
                            options={[{ value: '', label: '—' }, ...projectTasks.map((task) => ({
                              value: task.id,
                              label: [task.code, task.name].filter(Boolean).join(' · '),
                            }))]}
                            value={row.projectTaskId ?? ''}
                            onChange={(value) => {
                              setGrid((current) => current.map((candidate, index) => index === i
                                ? { ...candidate, projectTaskId: value || null }
                                : candidate))
                              setGridDirty(true)
                            }}
                            placeholder="—"
                            triggerClassName="h-8"
                          />
                        ) : (
                          <span className="text-xs text-slate-500">
                            {projectTasks.find((task) => task.id === row.projectTaskId)?.name ?? '—'}
                          </span>
                        )}
                      </td>
                    ) : null}
                    {days.map((d) => (
                      <td key={d} className="px-1 py-1.5">
                        <div className="flex flex-col gap-0.5">
                          {props.timeTypes.map((tt) => {
                            const k = `${tt.id}|${d}`
                            const v = row.cells[k] ?? ''
                            return (
                              <div key={tt.id} className="flex items-center gap-0.5">
                                <span className="w-3 text-[10px] font-medium text-slate-400" title={tt.name}>
                                  {tt.name.charAt(0).toUpperCase()}
                                </span>
                                {editable ? (
                                  <input
                                    aria-label={`${tt.name} ${d}`}
                                    inputMode="decimal"
                                    className={cn(
                                      'h-6 w-11 rounded border border-slate-200 bg-white px-1 text-right text-xs tabular-nums',
                                      'focus:border-teal-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
                                      v && 'border-teal-300 bg-teal-50/50 dark:border-teal-700 dark:bg-teal-950/30',
                                    )}
                                    value={v}
                                    onChange={(e) => {
                                      setGrid((g) => g.map((r, j) => (j === i ? { ...r, cells: { ...r.cells, [k]: e.target.value } } : r)))
                                      setGridDirty(true)
                                    }}
                                  />
                                ) : (
                                  <span className="w-11 text-right text-xs tabular-nums">{v || '·'}</span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </td>
                    ))}
                    <td className="py-1.5 pl-2 text-right text-sm font-medium tabular-nums">{rowHours(row).toFixed(1)}</td>
                    {editable && (
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          aria-label={t('editor.crew.removeRow')}
                          className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                          onClick={() => {
                            setGrid((g) => g.filter((_, j) => j !== i))
                            setGridDirty(true)
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {grid.length > 0 && (
                  <tr className="border-t border-slate-200 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                    <td className="py-1.5 pr-2 font-medium">{t('editor.crew.dayTotals')}</td>
                    <td />
                    {projectTasks.length > 0 ? <td /> : null}
                    {days.map((d) => (
                      <td key={d} className="px-1 py-1.5 text-center tabular-nums">{dayHours(d) > 0 ? dayHours(d).toFixed(1) : '·'}</td>
                    ))}
                    <td className="py-1.5 pl-2 text-right font-semibold tabular-nums">{totalHours.toFixed(1)}</td>
                    {editable && <td />}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {editable && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => setGrid((g) => [...g, { employeePartyId: '', itemId: null, projectTaskId: null, cells: {} }])}
            >
              <Plus size={14} /> {t('editor.crew.addRow')}
            </Button>
          )}
        </section> : null}

        {/* ---- items & equipment ---- */}
        {activeSection === 'items' ? <section>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('editor.lines.title')}</h3>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">{t('editor.lines.hint')}</p>
          {editable && (
            <div className={cn(
              'mb-4 grid w-full items-end gap-3',
              lineRateUnits.length > 0
                ? 'md:grid-cols-[minmax(16rem,1fr)_7rem_9rem_9rem_9rem]'
                : 'md:grid-cols-[minmax(16rem,1fr)_7rem_9rem_9rem]',
            )}>
              <div className="min-w-0">
                <Label>{t('editor.lines.item')}</Label>
                <SearchSelect
                  options={props.catalogItems.map((it) => ({ value: it.id, label: it.name }))}
                  value={lineItem}
                  onChange={(v) => {
                    setLineItem(v ?? '')
                    setLineEquipment('')
                    setLineRateUnit('')
                    setLineRateUnits([])
                  }}
                  placeholder={t('editor.lines.pickItem')}
                />
              </div>
              <div>
                <Label htmlFor="ft-qty">{t('editor.lines.quantity')}</Label>
                <Input
                  id="ft-qty"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  className="w-24 text-right tabular-nums"
                  value={lineQty}
                  onChange={(e) => { if (/^\d*$/.test(e.target.value)) setLineQty(e.target.value) }}
                  onBlur={() => { if (!Number.isInteger(Number(lineQty)) || Number(lineQty) < 1) setLineQty('1') }}
                />
              </div>
              {lineRateUnits.length > 0 ? (
                <div>
                  <Label htmlFor="ft-rate-unit">{t('editor.lines.rateUnit')}</Label>
                  <Select id="ft-rate-unit" value={lineRateUnit} onChange={(event) => setLineRateUnit(event.target.value)}>
                    {lineRateUnits.map((unit) => (
                      <option key={unit.unitCode} value={unit.unitCode}>{unit.unitName} · {money(unit.billRate)}</option>
                    ))}
                  </Select>
                </div>
              ) : null}
              <div>
                <Label htmlFor="ft-rate">{t('editor.lines.rate')}</Label>
                <Input id="ft-rate" className="w-full cursor-not-allowed bg-slate-100 text-right tabular-nums text-slate-700 dark:bg-slate-900 dark:text-slate-300" value={lineRateLoading ? '…' : lineRate ? money(lineRate) : '—'} readOnly />
              </div>
              <div>
                <Label>{t('editor.lines.amount')}</Label>
                <Input className="w-full cursor-not-allowed bg-slate-100 text-right tabular-nums text-slate-700 dark:bg-slate-900 dark:text-slate-300" value={lineRateLoading ? '…' : lineAmount ? money(lineAmount) : '—'} readOnly />
              </div>
              {props.equipmentEnabled && selectedItem?.kind === 'equipment_charge' && equipmentOptions.length > 0 ? (
                <div className="min-w-0 md:col-span-2">
                  <Label>{t('editor.lines.equipment')}</Label>
                  <SearchSelect
                    options={[{ value: '', label: t('editor.lines.pooledItem') }, ...equipmentOptions.map((unit) => ({ value: unit.id, label: `${unit.unitNumber} · ${unit.name}` }))]}
                    value={lineEquipment}
                    onChange={(value) => {
                      setLineEquipment(value ?? '')
                      setLineRateUnit('')
                      setLineRateUnits([])
                    }}
                    placeholder={t('editor.lines.pooledItem')}
                  />
                </div>
              ) : null}
              {lineRateSource ? (
                <div className="text-xs text-slate-500 md:col-span-3 dark:text-slate-400">
                  {t(`editor.lines.rateSource.${lineRateSource}`)}
                  {lineComponents.length > 0 ? ` · ${lineComponents.map((component) => `${Number(component.quantity)} ${component.unitName} × ${money(component.rate)}`).join(' + ')}` : ''}
                </div>
              ) : null}
            </div>
          )}
          {ticket.lines.length === 0 ? (
            !editable ? <p className="py-3 text-center text-sm text-slate-400">{t('editor.lines.empty')}</p> : null
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                  <th className="py-1 pr-2 font-medium">{t('editor.lines.item')}</th>
                  <th className="py-1 pr-2 font-medium">{t('editor.lines.description')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{t('editor.lines.quantity')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{t('editor.lines.rate')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{t('editor.lines.amount')}</th>
                  {editable && <th className="w-8" />}
                </tr>
              </thead>
              <tbody>
                {ticket.lines.map((l) => (
                  <tr key={l.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5 pr-2"><div>{l.item_name ?? '—'}</div>{l.equipment_name ? <div className="text-xs text-slate-500">{l.equipment_name}</div> : null}</td>
                    <td className="py-1.5 pr-2 text-slate-500"><div>{l.description ?? '—'}</div>{l.rate_components?.length ? <div className="text-xs">{l.rate_components.map((component) => `${Number(component.quantity)} ${component.unitName}`).join(' + ')}</div> : null}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {Number(l.quantity)} {l.rate_components?.length === 1 ? l.rate_components[0]!.unitName : (l.unit ?? '')}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{money(l.bill_rate ?? l.unit_price)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{money(l.bill_amount ?? l.amount)}</td>
                    {editable && (
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          aria-label={t('editor.lines.remove')}
                          className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                          onClick={() => void call('POST', { action: 'remove-line', lineId: l.id }, { preserveDraft: true })}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {editable ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={busy || lineRateLoading || lineRate === '' || !Number.isInteger(Number(lineQty)) || Number(lineQty) < 1 || (lineRateUnits.length > 0 && !lineRateUnit)}
              onClick={() => void addItemLine()}
            >
              <Plus size={14} /> {t('editor.lines.add')}
            </Button>
          ) : null}
        </section> : null}

        {activeSection === 'tasks' ? (
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('editor.tasks.title')}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('editor.tasks.hint')}</p>
            </div>
            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  <tr><th className="px-3 py-2">{t('editor.tasks.code')}</th><th className="px-3 py-2">{t('editor.tasks.task')}</th><th className="px-3 py-2">{tCommon('labels.status')}</th><th className="px-3 py-2 text-right">{t('editor.tasks.estimatedHours')}</th></tr>
                </thead>
                <tbody>{projectTasks.map((task) => (
                  <tr key={task.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2 font-mono text-xs">{task.code || '—'}</td>
                    <td className="px-3 py-2">{task.name}</td>
                    <td className="px-3 py-2 capitalize text-slate-500">{task.status.replaceAll('_', ' ')}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{task.estimatedHours ?? '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        ) : null}

      </div>
    </TransactionDrawer>
  )
}
