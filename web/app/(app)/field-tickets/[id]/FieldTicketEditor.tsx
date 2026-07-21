'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, Check, Plus, Send, Trash2, X } from 'lucide-react'
import { Badge, Button, Input, Label, Select, Textarea, cn } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'
import { money } from '../../../../lib/format'

/**
 * The field-ticket editor — a desktop-class "super sales order" for T&M:
 * crew hours grid (employees × days × time types), item/equipment lines, and
 * the submit → approve → sign lifecycle. Rates preview live; approval
 * snapshots them for good through the same chain as personal timesheets.
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
  time_type_name: string
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
  customerName: string
  projectName: string
  foremanName: string
  fieldTicket: {
    period: string
    periodStart: string
    periodEnd: string
    poNumber: string | null
    workDescription: string | null
    foremanPartyId: string | null
    rejectionReason?: string
    signatures?: { foreman?: { name: string; at: string }; customer?: { name: string; at: string; image?: string | null } }
    send?: { sentAt: string; respondedAt?: string | null }
  }
  entries: EntryRow[]
  lines: LineRow[]
  laborTotal: string
  linesTotal: string
  grandTotal: string
}

/** Grid model: one row per employee(+labor item); cells keyed timeType|date. */
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

export function FieldTicketEditor(props: {
  initial: TicketPayload
  employees: Opt[]
  laborItems: Opt[]
  timeTypes: TimeTypeOpt[]
  catalogItems: { id: string; name: string; kind: string; default_rate: string | null }[]
  canApprove: boolean
  canManage: boolean
}) {
  const t = useTranslations('fieldTickets')
  const router = useRouter()
  const [ticket, setTicket] = useState(props.initial)
  const [grid, setGrid] = useState<GridRow[]>(() => buildGrid(props.initial.entries))
  const [gridDirty, setGridDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  // header fields
  const [po, setPo] = useState(props.initial.fieldTicket.poNumber ?? '')
  const [description, setDescription] = useState(props.initial.fieldTicket.workDescription ?? '')
  const [foreman, setForeman] = useState(props.initial.fieldTicket.foremanPartyId ?? '')

  // add-line form
  const [lineItem, setLineItem] = useState('')
  const [lineQty, setLineQty] = useState('1')
  const [lineRate, setLineRate] = useState('')

  const editable = ticket.status === 'draft' && props.canManage
  const days = useMemo(() => daysBetween(ticket.fieldTicket.periodStart, ticket.fieldTicket.periodEnd), [ticket.fieldTicket])
  const dayLabel = (isoDay: string) => {
    const d = new Date(`${isoDay}T12:00:00Z`)
    return { dow: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }), dom: isoDay.slice(5) }
  }
  const rateFor = (row: GridRow, timeTypeId: string): string | null => {
    const e = ticket.entries.find(
      (x) => x.employee_party_id === row.employeePartyId && (x.item_id ?? '') === (row.itemId ?? '') && x.time_type_id === timeTypeId,
    )
    return e?.bill_rate ?? null
  }

  async function action(payload: Record<string, unknown>): Promise<boolean> {
    setBusy(true)
    try {
      const res = await fetch(`/api/field-tickets/${ticket.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      setTicket(j)
      setGrid(buildGrid(j.entries))
      setGridDirty(false)
      return true
    } catch (e) {
      toast.error((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function saveGrid(): Promise<boolean> {
    const rows = grid
      .filter((r) => r.employeePartyId)
      .map((r) => {
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
      .flat()
    return action({ action: 'save-grid', rows })
  }

  async function saveHeader() {
    await action({ action: 'patch', poNumber: po || null, workDescription: description || null, foremanPartyId: foreman || null })
  }

  async function submit() {
    if (gridDirty && !(await saveGrid())) return
    if (await action({ action: 'submit' })) toast.success(t('editor.submitted'))
  }
  async function approve() {
    if (await action({ action: 'approve' })) toast.success(t('editor.approved'))
  }
  async function reject() {
    if (await action({ action: 'reject', reason: rejectReason })) {
      setRejecting(false)
      setRejectReason('')
      toast.success(t('editor.rejected'))
    }
  }

  async function addLine() {
    if (!lineItem) return toast.error(t('editor.lines.itemRequired'))
    const ok = await action({ action: 'add-line', itemId: lineItem, quantity: Number(lineQty) || 1, billRate: lineRate || null })
    if (ok) {
      setLineItem('')
      setLineQty('1')
      setLineRate('')
    }
  }

  const setCell = (rowIdx: number, key: string, value: string) => {
    setGrid((g) => g.map((r, i) => (i === rowIdx ? { ...r, cells: { ...r.cells, [key]: value } } : r)))
    setGridDirty(true)
  }

  const rowHours = (r: GridRow) => Object.values(r.cells).reduce((a, v) => a + (Number(v) || 0), 0)
  const dayHours = (day: string) => grid.reduce((a, r) => a + props.timeTypes.reduce((b, tt) => b + (Number(r.cells[`${tt.id}|${day}`]) || 0), 0), 0)
  const totalHours = grid.reduce((a, r) => a + rowHours(r), 0)
  const sig = ticket.fieldTicket.signatures

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      {/* ---- header bar ---- */}
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/field-tickets" className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
          <ArrowLeft size={15} /> {t('editor.back')}
        </Link>
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{ticket.documentNumber}</h1>
        <Badge variant={STATUS_VARIANT[ticket.status] ?? 'outline'}>{t(`status.${ticket.status}`)}</Badge>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          {t(`period.${ticket.fieldTicket.period}`)}
        </span>
        <span className="text-sm tabular-nums text-slate-500">
          {ticket.fieldTicket.period === 'weekly'
            ? `${ticket.fieldTicket.periodStart} → ${ticket.fieldTicket.periodEnd}`
            : ticket.fieldTicket.periodStart}
        </span>
        <div className="flex-1" />
        {editable && (
          <>
            {gridDirty && (
              <Button size="sm" variant="outline" onClick={saveGrid} disabled={busy}>{t('editor.saveHours')}</Button>
            )}
            <Button size="sm" onClick={submit} disabled={busy}>
              <Send size={14} /> {t('editor.submit')}
            </Button>
          </>
        )}
        {ticket.status === 'pending_approval' && props.canApprove && (
          <>
            <Button size="sm" onClick={approve} disabled={busy}>
              <Check size={14} /> {t('editor.approve')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRejecting(true)} disabled={busy}>
              <X size={14} /> {t('editor.reject')}
            </Button>
          </>
        )}
      </div>

      {ticket.fieldTicket.rejectionReason && ticket.status === 'draft' && (
        <div className="rounded-md bg-rose-50 p-2.5 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {t('editor.rejectionNote', { reason: ticket.fieldTicket.rejectionReason })}
        </div>
      )}

      {rejecting && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
          <div className="min-w-72 flex-1">
            <Label htmlFor="ft-reject">{t('editor.rejectReason')}</Label>
            <Input id="ft-reject" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          </div>
          <Button size="sm" onClick={reject} disabled={busy || !rejectReason.trim()}>{t('editor.confirmReject')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>{t('editor.cancel')}</Button>
        </div>
      )}

      {/* ---- meta ---- */}
      <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <Label>{t('editor.project')}</Label>
          <p className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">{ticket.projectName || '—'}</p>
        </div>
        <div>
          <Label>{t('editor.customer')}</Label>
          <p className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">{ticket.customerName || '—'}</p>
        </div>
        <div>
          <Label htmlFor="ft-po">{t('editor.po')}</Label>
          {editable ? (
            <Input id="ft-po" value={po} onChange={(e) => setPo(e.target.value)} onBlur={saveHeader} />
          ) : (
            <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{ticket.fieldTicket.poNumber || '—'}</p>
          )}
        </div>
        <div>
          <Label htmlFor="ft-foreman">{t('editor.foreman')}</Label>
          {editable ? (
            <Select id="ft-foreman" value={foreman} onChange={(e) => { setForeman(e.target.value) }} onBlur={saveHeader}>
              <option value="">—</option>
              {props.employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </Select>
          ) : (
            <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{ticket.foremanName || '—'}</p>
          )}
        </div>
        <div className="sm:col-span-2 lg:col-span-4">
          <Label htmlFor="ft-desc">{t('editor.workDescription')}</Label>
          {editable ? (
            <Textarea id="ft-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} onBlur={saveHeader} />
          ) : (
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
              {ticket.fieldTicket.workDescription || '—'}
            </p>
          )}
        </div>
      </section>

      {/* ---- crew hours ---- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('editor.crew.title')}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('editor.crew.hint')}</p>
          </div>
          <span className="text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
            {t('editor.crew.total', { hours: totalHours.toFixed(1) })}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                <th className="sticky left-0 z-10 bg-white py-1 pr-2 font-medium dark:bg-slate-900">{t('editor.crew.employee')}</th>
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
                  <td className="sticky left-0 z-10 bg-white py-1.5 pr-2 dark:bg-slate-900">
                    {editable ? (
                      <Select
                        aria-label={t('editor.crew.employee')}
                        triggerClassName="h-8"
                        value={row.employeePartyId}
                        onChange={(e) => {
                          const v = e.target.value
                          setGrid((g) => g.map((r, j) => (j === i ? { ...r, employeePartyId: v } : r)))
                          setGridDirty(true)
                        }}
                      >
                        <option value="">—</option>
                        {props.employees.map((emp) => (
                          <option key={emp.id} value={emp.id}>{emp.name}</option>
                        ))}
                      </Select>
                    ) : (
                      <span className="text-sm text-slate-800 dark:text-slate-100">
                        {props.employees.find((e) => e.id === row.employeePartyId)?.name ?? '—'}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    {editable ? (
                      <Select
                        aria-label={t('editor.crew.laborItem')}
                        triggerClassName="h-8"
                        value={row.itemId ?? ''}
                        onChange={(e) => {
                          const v = e.target.value || null
                          setGrid((g) => g.map((r, j) => (j === i ? { ...r, itemId: v } : r)))
                          setGridDirty(true)
                        }}
                      >
                        <option value="">—</option>
                        {props.laborItems.map((it) => (
                          <option key={it.id} value={it.id}>{it.name}</option>
                        ))}
                      </Select>
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
                                  onChange={(e) => setCell(i, k, e.target.value)}
                                />
                              ) : (
                                <span className="w-11 text-right text-xs tabular-nums text-slate-700 dark:text-slate-200">
                                  {v || '·'}
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </td>
                  ))}
                  <td className="py-1.5 pl-2 text-right text-sm font-medium tabular-nums text-slate-800 dark:text-slate-100">
                    {rowHours(row).toFixed(1)}
                  </td>
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
                  <td className="sticky left-0 bg-white py-1.5 pr-2 font-medium dark:bg-slate-900">{t('editor.crew.dayTotals')}</td>
                  <td />
                  {days.map((d) => (
                    <td key={d} className="px-1 py-1.5 text-center tabular-nums">{dayHours(d) > 0 ? dayHours(d).toFixed(1) : '·'}</td>
                  ))}
                  <td className="py-1.5 pl-2 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                    {totalHours.toFixed(1)}
                  </td>
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
            onClick={() => {
              setGrid((g) => [...g, { employeePartyId: '', itemId: null, cells: {} }])
            }}
          >
            <Plus size={14} /> {t('editor.crew.addRow')}
          </Button>
        )}
      </section>

      {/* ---- item lines ---- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('editor.lines.title')}</h2>
        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">{t('editor.lines.hint')}</p>
        {editable && (
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <Select aria-label={t('editor.lines.item')} className="w-72" value={lineItem} onChange={(e) => {
              setLineItem(e.target.value)
              const it = props.catalogItems.find((x) => x.id === e.target.value)
              if (it?.default_rate != null) setLineRate(String(Number(it.default_rate)))
            }}>
              <option value="">{t('editor.lines.pickItem')}</option>
              {props.catalogItems.map((it) => (
                <option key={it.id} value={it.id}>{it.name}</option>
              ))}
            </Select>
            <div>
              <Label htmlFor="ft-qty">{t('editor.lines.quantity')}</Label>
              <Input id="ft-qty" type="number" min="0" step="0.25" className="w-24" value={lineQty} onChange={(e) => setLineQty(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ft-rate">{t('editor.lines.rate')}</Label>
              <Input id="ft-rate" type="number" min="0" step="0.01" className="w-28" value={lineRate} onChange={(e) => setLineRate(e.target.value)} />
            </div>
            <Button size="sm" onClick={addLine} disabled={busy}>
              <Plus size={14} /> {t('editor.lines.add')}
            </Button>
          </div>
        )}
        <PagedTable
          rows={ticket.lines}
          rowKey={(l) => l.id}
          pageSize={15}
          empty={<p className="py-4 text-center text-sm text-slate-400">{t('editor.lines.empty')}</p>}
          columns={[
            { key: 'item', header: t('editor.lines.item'), cell: (l) => l.item_name ?? l.description ?? '—' },
            { key: 'desc', header: t('editor.lines.description'), cell: (l) => l.description ?? '—' },
            { key: 'qty', header: t('editor.lines.quantity'), cell: (l) => <span className="tabular-nums">{Number(l.quantity)}</span> },
            { key: 'rate', header: t('editor.lines.rate'), cell: (l) => <span className="tabular-nums">{money(l.unit_price)}</span> },
            { key: 'amount', header: t('editor.lines.amount'), cell: (l) => <span className="tabular-nums">{money(l.amount)}</span> },
            ...(editable
              ? [
                  {
                    key: 'actions',
                    header: '',
                    cell: (l: LineRow) => (
                      <button
                        type="button"
                        aria-label={t('editor.lines.remove')}
                        className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                        onClick={() => void action({ action: 'remove-line', lineId: l.id })}
                      >
                        <Trash2 size={13} />
                      </button>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </section>

      {/* ---- totals + signatures ---- */}
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('editor.totals.title')}</h2>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500 dark:text-slate-400">{t('editor.totals.labor')}</dt>
              <dd className="tabular-nums font-medium text-slate-800 dark:text-slate-100">{money(ticket.laborTotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500 dark:text-slate-400">{t('editor.totals.items')}</dt>
              <dd className="tabular-nums font-medium text-slate-800 dark:text-slate-100">{money(ticket.linesTotal)}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-1 dark:border-slate-800">
              <dt className="font-medium text-slate-700 dark:text-slate-200">{t('editor.totals.grand')}</dt>
              <dd className="tabular-nums font-semibold text-slate-900 dark:text-slate-50">{money(ticket.grandTotal)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            {ticket.status === 'draft' ? t('editor.totals.previewNote') : t('editor.totals.snappedNote')}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('editor.signatures.title')}</h2>
          <div className="mt-2 space-y-1.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-400">{t('editor.signatures.customer')}</span>
              {sig?.customer ? (
                <Badge variant="success">{t('editor.signatures.signedBy', { name: sig.customer.name })}</Badge>
              ) : ticket.fieldTicket.send?.sentAt ? (
                <Badge variant="warning">{t('editor.signatures.waiting')}</Badge>
              ) : (
                <span className="text-xs text-slate-400">{t('editor.signatures.notSent')}</span>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
