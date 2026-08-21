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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { confirmDialog } from '../../../lib/confirm'
import { promptDialog } from '../../../lib/prompt'
import { ChevronLeft, ChevronRight, FilePenLine, Lock, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Badge, Button, SearchSelect, Select, UrlDrawer, cn } from '@openbooks/ui'
import { type CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { CustomFieldInput } from '../../../components/custom-field-input'
import type {
  PickerOption,
  TimeTypeOption,
  TimesheetPickers,
  WeekPayload,
  WeekRow,
} from '../../api/timesheets/_lib'

// Day-of-week catalog keys, Sunday-first to match the grid columns.
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** Statuses whose label lives in common.status; the rest live in timesheets.status. */
const COMMON_STATUS_KEYS = new Set(['draft', 'approved', 'rejected'])
const LOCAL_STATUS_KEYS = new Set(['submitted', 'empty'])
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
  custom: Record<string, unknown>
  immutable: boolean
  amendsEntryId: string | null
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
    custom: {},
    immutable: false,
    amendsEntryId: null,
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
    custom: r.custom ?? {},
    immutable: r.immutable,
    amendsEntryId: r.amendsEntryId,
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

/** Day-of-month from a day's ISO date ("2026-07-13" → 13). */
function dayOfMonth(iso: string): number {
  return Number(iso.split('-')[2])
}

/** Formatted week endpoints from the week's Sunday, for the "Week of …" title. */
function weekRange(sundayIso: string): { from: string; to: string } {
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
  return { from: fmtDate(sun, false), to: fmtDate(sat, true) }
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
  canReopen,
  requireApproval = true,
  fieldDefs = [],
  closeHref = '/timesheets',
}: {
  employeeId: string | null
  week: string
  payload: WeekPayload
  pickers: TimesheetPickers
  canManage: boolean
  canApprove: boolean
  /** Holds time.reopen — deliberately separate from approve, so the person who
   * signs off on hours is not automatically the one who can unwind that. */
  canReopen: boolean
  /** Org policy: when false, saved hours are usable immediately and the
   * submit/approve round trip is not offered at all. */
  requireApproval?: boolean
  /** Org-defined custom fields for a timesheet LINE (target table time_entries).
   * A week has no record of its own — it is an aggregate over its lines — so
   * tenant extension lives on the line, rendered as extra grid columns. */
  fieldDefs?: CustomFieldDefClient[]
  /** Where the flyout's close/escape returns to (the list, filters intact). */
  closeHref?: string
}) {
  const t = useTranslations('timesheets')
  const tCommon = useTranslations('common')
  const statusLabel = (s: string) =>
    COMMON_STATUS_KEYS.has(s) ? tCommon(`status.${s}`) : LOCAL_STATUS_KEYS.has(s) ? t(`status.${s}`) : s
  const router = useRouter()
  const [rows, setRows] = useState<GridRow[]>(() => fromPayload(payload.rows, pickers.timeTypes))
  const [status, setStatus] = useState(payload.status)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)

  // The employee/week live in the URL, so switching either re-renders THIS
  // component instance with a new payload — a `useState` initializer would not
  // re-run and the grid would keep showing the previous week's hours under the
  // new heading (and, worse, one employee's hours under another's name).
  // Re-seed whenever the identity of the loaded week changes.
  const loadedKey = `${employeeId ?? ''}:${week}`
  const seededKey = useRef(loadedKey)
  useEffect(() => {
    if (seededKey.current === loadedKey) return
    seededKey.current = loadedKey
    setRows(fromPayload(payload.rows, pickers.timeTypes))
    setStatus(payload.status)
    setDirty(false)
  }, [loadedKey, payload, pickers.timeTypes])

  // Approved weeks and users without manage rights are read-only.
  const locked = status === 'approved' || !canManage || !employeeId
  const readOnly = locked

  const timeTypeById = useMemo(
    () => new Map(pickers.timeTypes.map((t) => [t.value, t])),
    [pickers.timeTypes],
  )

  const setRow = (i: number, patch: Partial<GridRow>) => {
    if (rows[i]?.immutable) return
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  const setCell = (i: number, day: number, value: string) => {
    if (rows[i]?.immutable) return
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
    if (rows[i]?.immutable) return
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
    if (dirty && !confirm(t('grid.discardConfirm'))) return
    const emp = nextEmployee ?? employeeId
    if (!emp) return
    // Stay in the flyout and keep the list's filters: closeHref is the list URL
    // this drawer was opened over. (Built here, not passed as a prop — a server
    // component cannot hand a function to a client component.)
    const params = new URLSearchParams({ timesheet: `${emp}:${nextWeek}` })
    if (closeHref !== '/timesheets') params.set('drawerReturn', closeHref)
    const [base, existing] = closeHref.split('?')
    if (existing) for (const [k, v] of new URLSearchParams(existing)) if (!params.has(k)) params.set(k, v)
    router.push(`${base}?${params.toString()}` as never)
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
        toast.error(data?.error ?? tCommon('feedback.somethingWentWrong'))
        return null
      }
      return data as WeekPayload
    } catch {
      toast.error(t('grid.networkError'))
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
      rows: rows.filter((r) => !r.immutable).map((r) => ({
        projectId: r.projectId || null,
        itemId: r.itemId || null,
        timeTypeId: r.timeTypeId || null,
        departmentId: r.departmentId || null,
        isBillable: r.isBillable,
        memo: r.memo || null,
        hours: r.hours,
        custom: r.custom,
      })),
    }, 'PUT')
    if (data) {
      applyPayload(data)
      toast.success(t('grid.saved'))
    }
  }

  const onSubmit = async () => {
    if (!employeeId) return
    if (dirty) {
      toast.error(t('grid.saveBeforeSubmit'))
      return
    }
    const data = await post('/api/timesheets/submit', { employee: employeeId, week })
    if (data) {
      applyPayload(data)
      toast.success(t('grid.submittedToast'))
    }
  }

  const onApprove = async () => {
    if (!employeeId) return
    const data = await post('/api/timesheets/approve', { employee: employeeId, week })
    if (data) {
      applyPayload(data)
      toast.success(t('grid.approvedToast'))
    }
  }

  const onReject = async () => {
    if (!employeeId) return
    const reason = await promptDialog({
      title: t('grid.rejectTitle'),
      label: t('grid.rejectReasonLabel'),
      placeholder: t('grid.rejectPlaceholder'),
      confirmLabel: t('grid.reject'),
    })
    if (!reason) return
    const data = await post('/api/timesheets/reject', { employee: employeeId, week, reason })
    if (data) {
      applyPayload(data)
      toast.success(t('grid.rejectedToast'))
    }
  }

  const onReopen = async () => {
    if (!employeeId) return
    const ok = await confirmDialog({
      title: t('grid.reopenTitle'),
      message: t('grid.reopenMessage'),
      confirmLabel: t('grid.reopen'),
    })
    if (!ok) return
    const data = await post('/api/timesheets/reopen', { employee: employeeId, week })
    if (data) {
      applyPayload(data)
      toast.success(t('grid.reopenedToast'))
    }
  }

  const onAmend = async () => {
    if (!employeeId) return
    const ok = await confirmDialog({
      title: t('grid.amendTitle'),
      message: t('grid.amendMessage'),
      confirmLabel: t('grid.amend'),
    })
    if (!ok) return
    const data = await post('/api/timesheets/amend', { employee: employeeId, week })
    if (data) {
      applyPayload(data)
      toast.success(t('grid.amendedToast'))
    }
  }

  const canSave = canManage && !readOnly && employeeId != null
  const canSubmit = requireApproval && canManage && employeeId != null && (status === 'draft' || status === 'rejected')
  const canDoApprove = requireApproval && canApprove && employeeId != null && status === 'submitted'
  const canDoReject = requireApproval && canApprove && employeeId != null && status === 'submitted'
  // Reopen is offered only when it will actually succeed: approved, held by
  // nothing downstream, and the user carries the separate reopen right.
  const weekLocked = (payload.lockReasons?.length ?? 0) > 0
  const canDoReopen = canReopen && employeeId != null && status === 'approved' && !weekLocked
  const canDoAmend = canReopen && employeeId != null && status === 'approved' && weekLocked

  // Column widths mirror LineGrid's data-driven track model.
  // Org-defined line fields become real grid columns, between the built-in
  // line metadata and the seven day cells.
  const customCols = useMemo(
    () => fieldDefs.filter((d) => d.config.displayMode !== 'hidden'),
    [fieldDefs],
  )
  const fixedCols = 6 + customCols.length
  const template = `minmax(160px,1.6fr) minmax(130px,1.2fr) 110px 120px 56px minmax(140px,1.4fr) ${'minmax(120px,1fr) '.repeat(customCols.length)}${'62px '.repeat(7)}72px 40px`

  const cellInput =
    'w-full rounded-sm border-0 bg-transparent px-1.5 py-1 text-sm outline-none focus:ring-2 focus:ring-teal-500/60 dark:text-slate-100'

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      // Seven day columns plus the line metadata need ~1260px; open expanded so
      // the matrix is readable, and leave the header's toggle to collapse it.
      initialFullscreen
      title={
        <span className="flex flex-wrap items-center gap-2.5">
          {t('grid.title')}
          <Badge variant={STATUS_VARIANT[status] ?? 'secondary'}>{statusLabel(status)}</Badge>
        </span>
      }
      headerActions={
        <>
          {canSave ? (
            <Button size="sm" onClick={onSave} disabled={busy || !dirty}>
              {tCommon('actions.save')}
            </Button>
          ) : null}
          {canSubmit ? (
            <Button size="sm" variant="outline" onClick={onSubmit} disabled={busy || dirty}>
              {t('grid.submitForApproval')}
            </Button>
          ) : null}
          {canDoApprove ? (
            <Button size="sm" variant="outline" onClick={onApprove} disabled={busy}>
              {tCommon('actions.approve')}
            </Button>
          ) : null}
          {canDoReject ? (
            <Button size="sm" variant="outline" onClick={onReject} disabled={busy}>
              {t('grid.reject')}
            </Button>
          ) : null}
          {canDoReopen ? (
            <Button size="sm" variant="outline" onClick={onReopen} disabled={busy}>
              <RotateCcw size={14} /> {t('grid.reopen')}
            </Button>
          ) : null}
          {canDoAmend ? (
            <Button size="sm" variant="outline" onClick={onAmend} disabled={busy}>
              <FilePenLine size={14} /> {t('grid.amend')}
            </Button>
          ) : null}
        </>
      }
    >
      {/* Employee + week navigator. pb keeps the controls off the grid below. */}
      <div className="mb-5 space-y-3 border-b border-slate-200 pb-4 dark:border-slate-800">
        <div className="w-72">
          <SearchSelect
            value={employeeId ?? ''}
            onChange={onEmployee}
            options={pickers.employees}
            placeholder={t('grid.selectEmployee')}
            ariaLabel={tCommon('labels.employee')}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => go(employeeId, shiftWeek(week, -1))} disabled={!employeeId}>
            <ChevronLeft size={15} /> {t('grid.prev')}
          </Button>
          <span className="min-w-[220px] text-center text-sm font-medium text-slate-700 dark:text-slate-200">
            {t('grid.weekOf', weekRange(week))}
          </span>
          <Button size="sm" variant="outline" onClick={() => go(employeeId, shiftWeek(week, 1))} disabled={!employeeId}>
            {tCommon('actions.next')} <ChevronRight size={15} />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => go(employeeId, thisWeekSunday())} disabled={!employeeId}>
            {t('grid.thisWeek')}
          </Button>
          {readOnly && status === 'approved' ? (
            <span className="text-xs text-slate-400 dark:text-slate-500">{t('grid.approvedReadOnly')}</span>
          ) : !canManage ? (
            <span className="text-xs text-slate-400 dark:text-slate-500">{t('grid.viewOnly')}</span>
          ) : null}
        </div>

        {/* Say WHY the week is pinned rather than leaving a dead Reopen button.
            The same reasons the API enforces are the ones shown here. */}
        {weekLocked ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
            <Lock size={13} className="mt-0.5 shrink-0" />
            <span>
              {t('grid.lockedBecause', {
                reasons: (payload.lockReasons ?? []).map((r) => t(`grid.lockReason.${r}`)).join(', '),
                count: payload.lockedCount ?? 0,
              })}
            </span>
          </div>
        ) : null}

        {status === 'rejected' && payload.rejectionReason ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
            {t('grid.rejectedBecause', { reason: payload.rejectionReason })}
          </div>
        ) : null}
      </div>

      {!employeeId ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('grid.noEmployee')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="grid min-w-fit" style={{ gridTemplateColumns: template }}>
            {/* header */}
            {[
              { id: 'project', label: tCommon('labels.project'), required: true },
              { id: 'item', label: t('labels.serviceItem') },
              { id: 'timeType', label: t('labels.timeType') },
              { id: 'department', label: tCommon('labels.department') },
              { id: 'bill', label: t('labels.bill') },
              { id: 'memo', label: tCommon('labels.memo') },
              ...customCols.map((d) => ({ id: `cf_${d.key}`, label: d.label, required: d.isRequired })),
            ].map((h) => (
              <div
                key={h.id}
                className="border-b border-slate-200 px-2.5 py-2 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400"
              >
                {h.label}
                {h.required && !readOnly ? <span className="text-red-500"> *</span> : null}
              </div>
            ))}
            {payload.days.map((iso, i) => (
              <div
                key={iso}
                className="border-b border-slate-200 px-1 py-2 text-center text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400"
              >
                {t(`days.${DAY_KEYS[i]}`)} {dayOfMonth(iso)}
              </div>
            ))}
            <div className="border-b border-slate-200 px-2 py-2 text-right text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400">
              {tCommon('labels.total')}
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
                  readOnly={readOnly || r.immutable}
                  pickers={pickers}
                  cellInput={cellInput}
                  onProject={(v) => setRow(i, { projectId: v })}
                  onItem={(v) => setRow(i, { itemId: v })}
                  onTimeType={(v) => onTimeType(i, v)}
                  onDept={(v) => setRow(i, { departmentId: v })}
                  onBillable={(v) => setRow(i, { isBillable: v })}
                  onMemo={(v) => setRow(i, { memo: v })}
                  customCols={customCols}
                  onCustom={(v) => setRow(i, { custom: v })}
                  onCell={(d, v) => setCell(i, d, v)}
                  onRemove={() => removeRow(i)}
                />
              )
            })}

            {/* footer totals */}
            <div style={{ gridColumn: `span ${fixedCols}` }} className="border-t border-slate-200 px-2.5 py-2 text-right text-xs font-semibold text-slate-600 dark:border-slate-700 dark:text-slate-300">
              {t('labels.dailyTotals')}
            </div>
            {dayTotals.map((tot, d) => (
              <div
                key={d}
                className={cn(
                  'border-t border-slate-200 px-1 py-2 text-center text-sm tabular-nums dark:border-slate-700',
                  tot > 0 ? 'font-semibold text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500',
                )}
              >
                {tot > 0 ? fmt(tot) : '—'}
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
              <Plus size={14} /> {t('grid.addLine')}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-5 text-sm">
            <span className="text-slate-500 dark:text-slate-400">
              {t('labels.billable')} <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{fmt(billableTotal)}</span>
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              {t('labels.totalHours')} <span className="font-semibold tabular-nums text-teal-700 dark:text-teal-300">{fmt(grandTotal)}</span>
            </span>
          </div>
        </div>
      ) : null}

    </UrlDrawer>
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
  customCols,
  onCustom,
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
  customCols: CustomFieldDefClient[]
  onCustom: (values: Record<string, unknown>) => void
  onCell: (day: number, value: string) => void
  onRemove: () => void
}) {
  const t = useTranslations('timesheets')
  const tCommon = useTranslations('common')
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
            placeholder={t('grid.projectPlaceholder')}
            ariaLabel={t('grid.lineProjectAria', { line: i + 1 })}
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
            ariaLabel={t('grid.lineItemAria', { line: i + 1 })}
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
          aria-label={t('grid.lineBillableAria', { line: i + 1 })}
          className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
        />
      </div>
      <div className={cell}>
        {r.amendsEntryId ? (
          <Badge variant="outline" className="mr-1 shrink-0">{t('grid.amendmentLine')}</Badge>
        ) : null}
        {readOnly ? (
          <span className="truncate px-1.5 text-sm text-slate-500 dark:text-slate-400">{r.memo || '—'}</span>
        ) : (
          <input
            value={r.memo}
            onChange={(e) => onMemo(e.target.value)}
            placeholder={tCommon('labels.memo')}
            className={cellInput}
          />
        )}
      </div>
      {customCols.map((def) => (
        <div key={def.key} className={cn(cell, 'px-0.5')}>
          <CustomFieldInput
            def={def}
            value={r.custom[def.key]}
            onChange={(v) => onCustom({ ...r.custom, [def.key]: v })}
            readOnly={readOnly}
            hideLabel
          />
        </div>
      ))}
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
              aria-label={t('grid.lineHoursAria', { line: i + 1, day: t(`days.${DAY_KEYS[d]}`) })}
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
            aria-label={t('grid.removeLineAria', { line: i + 1 })}
            className="flex h-7 w-7 items-center justify-center rounded text-slate-300 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
    </>
  )
}
