'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Check, Mail, Plus, Send, Trash2, X } from 'lucide-react'
import { Badge, Button, Input, Label, SearchSelect, Select, Textarea, cn } from '@openbooks/ui'
import type { FormLayoutConfig, HeaderFieldPlacement } from '@openbooks/customization'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import { PdfButton } from '../../../components/pdf-button'
import { money } from '../../../lib/format'

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

interface EntryRow {
  id: string
  employee_party_id: string
  employee_name: string
  item_id: string | null
  item_name: string | null
  time_type_id: string
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
  unit_price: string
  amount: string
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
    send?: { sentAt: string; respondedAt?: string | null }
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

function buildGrid(entries: EntryRow[]): GridRow[] {
  const byKey = new Map<string, GridRow>()
  for (const e of entries) {
    const k = `${e.employee_party_id}|${e.item_id ?? ''}`
    let row = byKey.get(k)
    if (!row) {
      row = { employeePartyId: e.employee_party_id, itemId: e.item_id, cells: {} }
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
  catalogItems: { id: string; name: string; default_rate: string | null }[]
  projects: Opt[]
  layout?: FormLayoutConfig
  canApprove: boolean
  canManage: boolean
}) {
  const t = useTranslations('fieldTickets')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [ticket, setTicket] = useState(props.ticket)
  const [grid, setGrid] = useState<GridRow[]>(() => buildGrid(props.ticket.entries))
  const [gridDirty, setGridDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [sending, setSending] = useState(false)
  const [sendTo, setSendTo] = useState(props.ticket.customerEmail ?? '')
  const [sendMessage, setSendMessage] = useState('')

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

  const editable = ticket.status === 'draft' && props.canManage
  const days = useMemo(() => daysBetween(ticket.fieldTicket.periodStart, ticket.fieldTicket.periodEnd), [ticket.fieldTicket])
  const sig = ticket.fieldTicket.signatures

  function applyPayload(j: TicketPayload) {
    setTicket(j)
    setGrid(buildGrid(j.entries))
    setGridDirty(false)
    setProjectId(j.projectId ?? '')
    setDocumentDate(j.documentDate)
    setReferenceNumber(j.referenceNumber ?? '')
    setMemo(j.memo ?? '')
    setPeriod(j.fieldTicket.period)
    setForeman(j.fieldTicket.foremanPartyId ?? '')
    setHeaderDirty(false)
  }

  async function call(method: 'POST' | 'PATCH', payload: Record<string, unknown>): Promise<boolean> {
    setBusy(true)
    try {
      const res = await fetch(`/api/field-tickets/${ticket.id}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      applyPayload(j)
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
    return call('PATCH', {
      projectId: projectId || null,
      documentDate,
      referenceNumber: referenceNumber || null,
      memo: memo || null,
      period,
      foremanPartyId: foreman || null,
    })
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
          timeTypeId,
          hours,
        }))
      })
    return call('POST', { action: 'save-grid', rows })
  }

  async function saveAll(): Promise<boolean> {
    if (headerDirty && !(await saveHeader())) return false
    if (gridDirty && !(await saveGrid())) return false
    return true
  }

  async function submit() {
    if (!(await saveAll())) return
    if (await call('POST', { action: 'submit' })) toast.success(t('editor.submitted'))
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
                onChange={markHeader((v: string) => setProjectId(v ?? ''))}
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
            <p className="text-sm">{ticket.customerName || '—'}</p>
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
        ticket.fieldTicket.period === 'weekly'
          ? `${ticket.fieldTicket.periodStart} → ${ticket.fieldTicket.periodEnd}`
          : ticket.fieldTicket.periodStart
      }
      actions={
        <>
          {editable ? (
            <>
              {(headerDirty || gridDirty) && (
                <Button disabled={busy} onClick={saveAll}>
                  {busy ? tCommon('actions.saving') : tCommon('actions.save')}
                </Button>
              )}
              <Button variant={headerDirty || gridDirty ? 'outline' : 'default'} disabled={busy} onClick={submit}>
                <Send size={14} /> {t('editor.submit')}
              </Button>
            </>
          ) : null}
          {ticket.status === 'pending_approval' && props.canApprove ? (
            <>
              <Button disabled={busy} onClick={async () => (await call('POST', { action: 'approve' })) && toast.success(t('editor.approved'))}>
                <Check size={14} /> {t('editor.approve')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
                <X size={14} /> {t('editor.reject')}
              </Button>
            </>
          ) : null}
          {ticket.status === 'approved' && props.canManage && !sig?.customer ? (
            <Button disabled={busy} onClick={() => setSending(true)}>
              <Mail size={14} /> {t('editor.sendSignature')}
            </Button>
          ) : null}
          <PdfButton recordType="field_ticket" recordId={ticket.id} />
        </>
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {editable && (headerDirty || gridDirty) ? tCommon('feedback.unsavedChanges') : null}
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
        {ticket.fieldTicket.rejectionReason && ticket.status === 'draft' && (
          <div className="rounded-md bg-rose-50 p-2.5 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
            {t('editor.rejectionNote', { reason: ticket.fieldTicket.rejectionReason })}
          </div>
        )}

        {rejecting && (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="min-w-64 flex-1">
              <Label htmlFor="ft-reject">{t('editor.rejectReason')}</Label>
              <Input id="ft-reject" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            </div>
            <Button
              size="sm"
              disabled={busy || !rejectReason.trim()}
              onClick={async () => {
                if (await call('POST', { action: 'reject', reason: rejectReason })) {
                  setRejecting(false)
                  setRejectReason('')
                  toast.success(t('editor.rejected'))
                }
              }}
            >
              {t('editor.confirmReject')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>{t('editor.cancel')}</Button>
          </div>
        )}

        {sending && (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="min-w-64">
              <Label htmlFor="ft-send-to">{t('editor.sendTo')}</Label>
              <Input id="ft-send-to" type="email" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
            </div>
            <div className="min-w-72 flex-1">
              <Label htmlFor="ft-send-msg">{t('editor.sendMessage')}</Label>
              <Input id="ft-send-msg" value={sendMessage} onChange={(e) => setSendMessage(e.target.value)} />
            </div>
            <Button
              size="sm"
              disabled={busy || !sendTo.trim()}
              onClick={async () => {
                if (await call('POST', { action: 'send-signature', to: sendTo, message: sendMessage || null })) {
                  setSending(false)
                  toast.success(t('editor.signatureSent', { to: sendTo }))
                }
              }}
            >
              <Send size={14} /> {t('editor.send')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSending(false)}>{t('editor.cancel')}</Button>
          </div>
        )}

        {/* Standard configurable header form + the period control. */}
        <div className="space-y-3">
          {props.layout ? (
            <HeaderFields layout={props.layout} editable={editable} renderField={renderHeaderField} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {(['project_id', 'party_id', 'document_date', 'reference_number'] as const).map((key) => (
                <div key={key} className="space-y-1.5">{renderHeaderField({ key } as HeaderFieldPlacement, editable)}</div>
              ))}
              <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
                {renderHeaderField({ key: 'memo' } as HeaderFieldPlacement, editable)}
              </div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label>{t('list.period')}</Label>
              {editable ? (
                <Select value={period} onChange={(e) => markHeader(setPeriod)(e.target.value)}>
                  <option value="shift">{t('period.shift')}</option>
                  <option value="daily">{t('period.daily')}</option>
                  <option value="weekly">{t('period.weekly')}</option>
                </Select>
              ) : (
                <p className="text-sm">{t(`period.${ticket.fieldTicket.period}`)}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>{t('editor.foreman')}</Label>
              {editable ? (
                <SearchSelect
                  options={[{ value: '', label: '—' }, ...props.employees.map((e) => ({ value: e.id, label: e.name }))]}
                  value={foreman}
                  onChange={markHeader((v: string) => setForeman(v ?? ''))}
                  placeholder="—"
                />
              ) : (
                <p className="text-sm">{ticket.foremanName || '—'}</p>
              )}
            </div>
          </div>
        </div>

        {/* ---- crew hours ---- */}
        <section>
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
              onClick={() => setGrid((g) => [...g, { employeePartyId: '', itemId: null, cells: {} }])}
            >
              <Plus size={14} /> {t('editor.crew.addRow')}
            </Button>
          )}
        </section>

        {/* ---- equipment & materials ---- */}
        <section>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('editor.lines.title')}</h3>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">{t('editor.lines.hint')}</p>
          {editable && (
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <div className="w-72">
                <SearchSelect
                  options={props.catalogItems.map((it) => ({ value: it.id, label: it.name }))}
                  value={lineItem}
                  onChange={(v) => {
                    setLineItem(v ?? '')
                    const it = props.catalogItems.find((x) => x.id === v)
                    if (it?.default_rate != null) setLineRate(String(Number(it.default_rate)))
                  }}
                  placeholder={t('editor.lines.pickItem')}
                />
              </div>
              <div>
                <Label htmlFor="ft-qty">{t('editor.lines.quantity')}</Label>
                <Input id="ft-qty" type="number" min="0" step="0.25" className="w-24" value={lineQty} onChange={(e) => setLineQty(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="ft-rate">{t('editor.lines.rate')}</Label>
                <Input id="ft-rate" type="number" min="0" step="0.01" className="w-28" value={lineRate} onChange={(e) => setLineRate(e.target.value)} />
              </div>
              <Button
                size="sm"
                disabled={busy}
                onClick={async () => {
                  if (!lineItem) return toast.error(t('editor.lines.itemRequired'))
                  if (await call('POST', { action: 'add-line', itemId: lineItem, quantity: Number(lineQty) || 1, billRate: lineRate || null })) {
                    setLineItem('')
                    setLineQty('1')
                    setLineRate('')
                  }
                }}
              >
                <Plus size={14} /> {t('editor.lines.add')}
              </Button>
            </div>
          )}
          {ticket.lines.length === 0 ? (
            <p className="py-3 text-center text-sm text-slate-400">{t('editor.lines.empty')}</p>
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
                    <td className="py-1.5 pr-2">{l.item_name ?? '—'}</td>
                    <td className="py-1.5 pr-2 text-slate-500">{l.description ?? '—'}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{Number(l.quantity)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{money(l.unit_price)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{money(l.amount)}</td>
                    {editable && (
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          aria-label={t('editor.lines.remove')}
                          className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                          onClick={() => void call('POST', { action: 'remove-line', lineId: l.id })}
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
        </section>

        {/* ---- signature state ---- */}
        <section>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('editor.signatures.title')}</h3>
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-slate-500 dark:text-slate-400">{t('editor.signatures.customer')}</span>
            {sig?.customer ? (
              <Badge variant="success">{t('editor.signatures.signedBy', { name: sig.customer.name })}</Badge>
            ) : ticket.fieldTicket.send?.sentAt ? (
              <Badge variant="warning">{t('editor.signatures.waiting')}</Badge>
            ) : (
              <span className="text-xs text-slate-400">{t('editor.signatures.notSent')}</span>
            )}
          </div>
          {sig?.customer?.image && (
            <div className="mt-2 inline-block rounded-md border border-slate-100 bg-white p-2 dark:border-slate-800 dark:bg-slate-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={sig.customer.image} alt={t('editor.signatures.customer')} className="max-h-14" />
            </div>
          )}
        </section>
      </div>
    </TransactionDrawer>
  )
}
