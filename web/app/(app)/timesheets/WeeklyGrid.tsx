'use client'

/**
 * WeeklyGrid — the weekly time-entry matrix. One row per "time line"
 * (project + item + time type + department + billable + memo); seven day
 * columns Sun…Sat, each a numeric hours cell; a computed row total, a footer
 * of per-day totals and a grand + billable total.
 *
 * This is a purpose-made grid, not LineGrid: the weekly matrix has a fixed
 * 7-column numeric block with per-column totals, a shape LineGrid's flat
 * column model doesn't express cleanly. Editing is disabled when the week is
 * approved or the user lacks time.manage.
 */

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, SearchSelect, Select, cn } from '@openbooks/ui'
import { DetailPageLayout } from '../../../components/page-layout'
import type {
  PickerOption,
  TimeTypeOption,
  TimesheetPickers,
  WeekPayload,
  WeekRow,
} from '../../api/timesheets/_lib'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
  empty: 'No hours',
}
const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'outline' | 'destructive'> = {
  draft: 'secondary',
  submitted: 'warning',
  approved: 'success',
  rejected: 'destructive',
  empty: 'outline',
}

interface GridRow {
  projectId: string
  itemId: string
  timeTypeId: string
  departmentId: string
  isBillable: boolean
  memo: string
  hours: string[]
}

function emptyRow(timeTypes: TimeTypeOption[]): GridRow {
  const def = timeTypes[0]
  return {
    projectId: '',
    itemId: '',
    timeTypeId: def?.value ?? '',
    departmentId: '',
    isBillable: def?.isBillableDefault ?? false,
    memo: '',
    hours: ['', '', '', '', '', '', ''],
  }
}

function fromPayload(rows: WeekRow[], timeTypes: TimeTypeOption[]): GridRow[] {
  if (rows.length === 0) return [emptyRow(timeTypes)]
  return rows.map((r) => ({
    projectId: r.projectId ?? '',
    itemId: r.itemId ?? '',
    timeTypeId: r.timeTypeId ?? '',
    departmentId: r.departmentId ?? '',
    isBillable: r.isBillable,
    memo: r.memo ?? '',
    hours: r.hours.map((h) => (h === '' ? '' : String(Number(h)))),
  }))
}

function num(v: string): number {
  if (v.trim() === '') return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : n
}

function fmt(n: number): string {
  return n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Format a day's ISO date as "Sun 13". */
function dayHeader(iso: string, i: number): string {
  const d = Number(iso.split('-')[2])
  return `${DAY_LABELS[i]} ${d}`
}

/** "Sun Jul 13 – Sat Jul 19, 2026" from the week's Sunday. */
function weekTitle(sundayIso: string): string {
  const [y, m, d] = sundayIso.split('-').map(Number)
  const sun = new Date(Date.UTC(y, m - 1, d, 12))
  const sat = new Date(sun)
  sat.setUTCDate(sat.getUTCDate() + 6)
  const fmtDate = (dt: Date, withYear: boolean) =>
    dt.toLocaleDateString('en-CA', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
      ...(withYear ? { year: 'numeric' } : {}),
    })
  return `Week of ${fmtDate(sun, false)} – ${fmtDate(sat, true)}`
}

/** Shift an ISO Sunday by ±7 days, returning the new Sunday ISO. */
function shiftWeek(sundayIso: string, deltaWeeks: number): string {
  const [y, m, d] = sundayIso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d, 12))
  dt.setUTCDate(dt.getUTCDate() + deltaWeeks * 7)
  return dt.toISOString().slice(0, 10)
}

function thisWeekSunday(): string {
  const now = new Date()
  const dt = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12))
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay())
  return dt.toISOString().slice(0, 10)
}

export function WeeklyGrid({
  employeeId,
  week,
  payload,
  pickers,
  canManage,
  canApprove,
}: {
  employeeId: string | null
  week: string
  payload: WeekPayload
  pickers: TimesheetPickers
  canManage: boolean
  canApprove: boolean
}) {
  const router = useRouter()
  const [rows, setRows] = useState<GridRow[]>(() => fromPayload(payload.rows, pickers.timeTypes))
  const [status, setStatus] = useState(payload.status)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)

  // Approved weeks and users without manage rights are read-only.
  const locked = status === 'approved' || !canManage || !employeeId
  const readOnly = locked

  const timeTypeById = useMemo(
    () => new Map(pickers.timeTypes.map((t) => [t.value, t])),
    [pickers.timeTypes],
  )

  const setRow = (i: number, patch: Partial<GridRow>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  const setCell = (i: number, day: number, value: string) => {
    setRows((rs) =>
      rs.map((r, j) => (j === i ? { ...r, hours: r.hours.map((h, k) => (k === day ? value : h)) } : r)),
    )
    setDirty(true)
  }
  const addRow = () => {
    setRows((rs) => [...rs, emptyRow(pickers.timeTypes)])
    setDirty(true)
  }
  const removeRow = (i: number) => {
    setRows((rs) => (rs.length <= 1 ? [emptyRow(pickers.timeTypes)] : rs.filter((_, j) => j !== i)))
    setDirty(true)
  }

  // When the time type changes, follow its billable default (only if the user
  // hasn't diverged — we keep it simple and always follow the default here).
  const onTimeType = (i: number, value: string) => {
    const tt = timeTypeById.get(value)
    setRow(i, { timeTypeId: value, isBillable: tt?.isBillableDefault ?? rows[i].isBillable })
  }

  const dayTotals = useMemo(() => {
    const totals = [0, 0, 0, 0, 0, 0, 0]
    for (const r of rows) for (let d = 0; d < 7; d++) totals[d] += num(r.hours[d])
    return totals
  }, [rows])
  const rowTotal = (r: GridRow) => r.hours.reduce((s, h) => s + num(h), 0)
  const grandTotal = dayTotals.reduce((s, t) => s + t, 0)
  const billableTotal = useMemo(
    () => rows.filter((r) => r.isBillable).reduce((s, r) => s + rowTotal(r), 0),
    [rows],
  )

  // ---- navigation (URL is the source of truth; no full reload) -------------
  const go = (nextEmployee: string | null, nextWeek: string) => {
    if (dirty && !confirm('Discard unsaved changes?')) return
    const emp = nextEmployee ?? employeeId
    if (!emp) return
    router.push(`/timesheets/entry?employee=${emp}&week=${nextWeek}`)
  }
  const onEmployee = (v: string) => {
    if (v && v !== employeeId) go(v, week)
  }

  // ---- actions -------------------------------------------------------------
  async function post(url: string, body: unknown, method: 'PUT' | 'POST' = 'POST') {
    setBusy(true)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error ?? 'Something went wrong')
        return null
      }
      return data as WeekPayload
    } catch {
      toast.error('Network error')
      return null
    } finally {
      setBusy(false)
    }
  }

  const applyPayload = (data: WeekPayload) => {
    setRows(fromPayload(data.rows, pickers.timeTypes))
    setStatus(data.status)
    setDirty(false)
    router.refresh()
  }

  const onSave = async () => {
    if (!employeeId) return
    const data = await post('/api/timesheets', {
      employee: employeeId,
      week,
      rows: rows.map((r) => ({
        projectId: r.projectId || null,
        itemId: r.itemId || null,
        timeTypeId: r.timeTypeId || null,
        departmentId: r.departmentId || null,
        isBillable: r.isBillable,
        memo: r.memo || null,
        hours: r.hours,
      })),
    }, 'PUT')
    if (data) {
      applyPayload(data)
      toast.success('Timesheet saved')
    }
  }

  const onSubmit = async () => {
    if (!employeeId) return
    if (dirty) {
      toast.error('Save your changes before submitting')
      return
    }
    const data = await post('/api/timesheets/submit', { employee: employeeId, week })
    if (data) {
      applyPayload(data)
      toast.success('Submitted for approval')
    }
  }

  const onApprove = async () => {
    if (!employeeId) return
    const data = await post('/api/timesheets/approve', { employee: employeeId, week })
    if (data) {
      applyPayload(data)
      toast.success('Timesheet approved')
    }
  }

  const canSave = canManage && !readOnly && employeeId != null
  const canSubmit = canManage && employeeId != null && (status === 'draft' || status === 'rejected')
  const canDoApprove = canApprove && employeeId != null && status === 'submitted'

  // Column widths mirror LineGrid's data-driven track model.
  const template = `minmax(160px,1.6fr) minmax(130px,1.2fr) 110px 120px 56px minmax(140px,1.4fr) ${'62px '.repeat(7)}72px 40px`

  const cellInput =
    'w-full rounded-sm border-0 bg-transparent px-1.5 py-1 text-sm outline-none focus:ring-2 focus:ring-teal-500/60 dark:text-slate-100'

  return (
    <DetailPageLayout
      header={
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Weekly timesheet</h1>
                <Badge variant={STATUS_VARIANT[status] ?? 'secondary'}>{STATUS_LABELS[status] ?? status}</Badge>
              </div>
              <div className="w-72">
                <SearchSelect
                  value={employeeId ?? ''}
                  onChange={onEmployee}
                  options={pickers.employees}
                  placeholder="Select employee…"
                  ariaLabel="Employee"
                />
              </div>
            </div>

            {/* Action buttons live at the top. */}
            <div className="flex flex-wrap items-center gap-2">
              {canSave ? (
                <Button size="sm" onClick={onSave} disabled={busy || !dirty}>
                  Save
                </Button>
              ) : null}
              {canSubmit ? (
                <Button size="sm" variant="outline" onClick={onSubmit} disabled={busy || dirty}>
                  Submit for approval
                </Button>
              ) : null}
              {canDoApprove ? (
                <Button size="sm" variant="outline" onClick={onApprove} disabled={busy}>
                  Approve
                </Button>
              ) : null}
            </div>
          </div>

          {/* Week navigator. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => go(employeeId, shiftWeek(week, -1))} disabled={!employeeId}>
              <ChevronLeft size={15} /> Prev
            </Button>
            <span className="min-w-[220px] text-center text-sm font-medium text-slate-700 dark:text-slate-200">
              {weekTitle(week)}
            </span>
            <Button size="sm" variant="outline" onClick={() => go(employeeId, shiftWeek(week, 1))} disabled={!employeeId}>
              Next <ChevronRight size={15} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => go(employeeId, thisWeekSunday())} disabled={!employeeId}>
              This week
            </Button>
            {readOnly && status === 'approved' ? (
              <span className="text-xs text-slate-400 dark:text-slate-500">Approved timesheets are read-only.</span>
            ) : !canManage ? (
              <span className="text-xs text-slate-400 dark:text-slate-500">You have view-only access.</span>
            ) : null}
          </div>
        </div>
      }
    >
      {!employeeId ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No employee selected. Pick an employee above to enter time.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="grid min-w-fit" style={{ gridTemplateColumns: template }}>
            {/* header */}
            {['Project', 'Service item', 'Time type', 'Department', 'Bill', 'Memo'].map((h) => (
              <div
                key={h}
                className="border-b border-slate-200 px-2.5 py-2 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400"
              >
                {h}
                {h === 'Project' && !readOnly ? <span className="text-red-500"> *</span> : null}
              </div>
            ))}
            {payload.days.map((iso, i) => (
              <div
                key={iso}
                className="border-b border-slate-200 px-1 py-2 text-center text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400"
              >
                {dayHeader(iso, i)}
              </div>
            ))}
            <div className="border-b border-slate-200 px-2 py-2 text-right text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400">
              Total
            </div>
            <div className="border-b border-slate-200 dark:border-slate-800" />

            {/* rows */}
            {rows.map((r, i) => {
              const total = rowTotal(r)
              return (
                <RowFragment
                  key={i}
                  r={r}
                  i={i}
                  total={total}
                  readOnly={readOnly}
                  pickers={pickers}
                  cellInput={cellInput}
                  onProject={(v) => setRow(i, { projectId: v })}
                  onItem={(v) => setRow(i, { itemId: v })}
                  onTimeType={(v) => onTimeType(i, v)}
                  onDept={(v) => setRow(i, { departmentId: v })}
                  onBillable={(v) => setRow(i, { isBillable: v })}
                  onMemo={(v) => setRow(i, { memo: v })}
                  onCell={(d, v) => setCell(i, d, v)}
                  onRemove={() => removeRow(i)}
                />
              )
            })}

            {/* footer totals */}
            <div className="col-span-6 border-t border-slate-200 px-2.5 py-2 text-right text-xs font-semibold text-slate-600 dark:border-slate-700 dark:text-slate-300">
              Daily totals
            </div>
            {dayTotals.map((t, d) => (
              <div
                key={d}
                className={cn(
                  'border-t border-slate-200 px-1 py-2 text-center text-sm tabular-nums dark:border-slate-700',
                  t > 0 ? 'font-semibold text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500',
                )}
              >
                {t > 0 ? fmt(t) : '—'}
              </div>
            ))}
            <div className="border-t border-slate-200 px-2 py-2 text-right text-sm font-bold tabular-nums text-teal-700 dark:border-slate-700 dark:text-teal-300">
              {fmt(grandTotal)}
            </div>
            <div className="border-t border-slate-200 dark:border-slate-700" />
          </div>
        </div>
      )}

      {employeeId ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          {!readOnly ? (
            <Button type="button" variant="outline" size="sm" onClick={addRow} disabled={busy}>
              <Plus size={14} /> Add line
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-5 text-sm">
            <span className="text-slate-500 dark:text-slate-400">
              Billable <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{fmt(billableTotal)}</span>
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              Total hours <span className="font-semibold tabular-nums text-teal-700 dark:text-teal-300">{fmt(grandTotal)}</span>
            </span>
          </div>
        </div>
      ) : null}
    </DetailPageLayout>
  )
}

function RowFragment({
  r,
  i,
  total,
  readOnly,
  pickers,
  cellInput,
  onProject,
  onItem,
  onTimeType,
  onDept,
  onBillable,
  onMemo,
  onCell,
  onRemove,
}: {
  r: GridRow
  i: number
  total: number
  readOnly: boolean
  pickers: TimesheetPickers
  cellInput: string
  onProject: (v: string) => void
  onItem: (v: string) => void
  onTimeType: (v: string) => void
  onDept: (v: string) => void
  onBillable: (v: boolean) => void
  onMemo: (v: string) => void
  onCell: (day: number, value: string) => void
  onRemove: () => void
}) {
  const cell = 'flex min-h-[42px] items-center border-b border-slate-100 px-1 dark:border-slate-800'
  const label = (opts: PickerOption[], v: string) => opts.find((o) => o.value === v)?.label ?? '—'

  return (
    <>
      <div className={cell}>
        {readOnly ? (
          <span className="px-1.5 text-sm">{label(pickers.projects, r.projectId)}</span>
        ) : (
          <SearchSelect
            value={r.projectId}
            onChange={onProject}
            options={pickers.projects}
            placeholder="Project…"
            ariaLabel={`Line ${i + 1} project`}
            className="w-full border-0 bg-transparent shadow-none"
          />
        )}
      </div>
      <div className={cell}>
        {readOnly ? (
          <span className="px-1.5 text-sm">{r.itemId ? label(pickers.items, r.itemId) : '—'}</span>
        ) : (
          <SearchSelect
            value={r.itemId}
            onChange={onItem}
            options={pickers.items}
            placeholder="—"
            clearable
            ariaLabel={`Line ${i + 1} item`}
            className="w-full border-0 bg-transparent shadow-none"
          />
        )}
      </div>
      <div className={cell}>
        {readOnly ? (
          <span className="px-1.5 text-sm">{label(pickers.timeTypes, r.timeTypeId)}</span>
        ) : (
          <Select
            value={r.timeTypeId}
            onChange={(e) => onTimeType(e.target.value)}
            className="w-full border-0 bg-transparent shadow-none"
          >
            {pickers.timeTypes.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className={cell}>
        {readOnly ? (
          <span className="px-1.5 text-sm">{r.departmentId ? label(pickers.departments, r.departmentId) : '—'}</span>
        ) : (
          <Select
            value={r.departmentId}
            onChange={(e) => onDept(e.target.value)}
            className="w-full border-0 bg-transparent shadow-none"
          >
            <option value="">—</option>
            {pickers.departments.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className={cn(cell, 'justify-center')}>
        <input
          type="checkbox"
          checked={r.isBillable}
          disabled={readOnly}
          onChange={(e) => onBillable(e.target.checked)}
          aria-label={`Line ${i + 1} billable`}
          className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
        />
      </div>
      <div className={cell}>
        {readOnly ? (
          <span className="truncate px-1.5 text-sm text-slate-500 dark:text-slate-400">{r.memo || '—'}</span>
        ) : (
          <input
            value={r.memo}
            onChange={(e) => onMemo(e.target.value)}
            placeholder="Memo"
            className={cellInput}
          />
        )}
      </div>
      {r.hours.map((h, d) => (
        <div key={d} className={cn(cell, 'px-0')}>
          {readOnly ? (
            <span className="w-full px-1 text-center text-sm tabular-nums">
              {h === '' || Number(h) === 0 ? '' : Number(h).toFixed(2)}
            </span>
          ) : (
            <input
              inputMode="decimal"
              type="number"
              min={0}
              step={0.25}
              value={h}
              onChange={(e) => onCell(d, e.target.value)}
              aria-label={`Line ${i + 1} ${DAY_LABELS[d]} hours`}
              className={cn(cellInput, 'text-center tabular-nums')}
              placeholder="0"
            />
          )}
        </div>
      ))}
      <div className={cn(cell, 'justify-end px-2 text-sm tabular-nums', total > 0 ? 'font-semibold text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500')}>
        {total > 0 ? total.toFixed(2) : '—'}
      </div>
      <div className={cn(cell, 'justify-center px-0')}>
        {!readOnly ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove line ${i + 1}`}
            className="flex h-7 w-7 items-center justify-center rounded text-slate-300 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
    </>
  )
}
