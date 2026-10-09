'use client'

import { useCallback, useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select } from '@openbooks/ui'
import { useBusinessToday } from '../../../components/business-date-provider'
import { PagedTable } from '../../../components/paged-table'
import { canonicalDecimal } from '../../../lib/exact-decimal'
import { confirmDialog } from '@/lib/confirm'

interface AssignmentRow {
  id: string
  employeePartyId: string
  employmentId: string | null
  componentId: string
  componentCode: string
  componentName: string
  componentKind: string
  componentBasis: string
  value: string | null
  runApplicability: "standard_runs" | "regular_only"
  componentValue: string | null
  effectiveFrom: string
  effectiveTo: string | null
  isCurrent: boolean
}

interface ComponentOption {
  id: string
  code: string
  name: string
  kind: string
  basis: string
  value: string | null
  paymentKind: string
  country: string | null
}

interface EmploymentOption {
  id: string
  serviceStart: string | null
  subsidiaryName: string | null
}

interface AssignmentsResponse {
  assignments: AssignmentRow[]
  components: ComponentOption[]
  employments: EmploymentOption[]
}

/**
 * Recurring per-employee pay-component assignments — fixed deductions,
 * taxable benefits and employee premiums priced every regular run. Same
 * composition as the wage-rates panel: an add form over a paged history with
 * end-today and delete, and a refused save stays visible on the record.
 */
export function EmployeePayComponents({
  partyId,
  readOnly = false,
  onDirtyChange,
}: {
  partyId: string
  readOnly?: boolean
  onDirtyChange?: (dirty: boolean) => void
}) {
  const t = useTranslations('parties.drawer.payComponents')
  const tc = useTranslations('common')
  const format = useFormatter()
  const today = useBusinessToday()
  const [data, setData] = useState<AssignmentsResponse | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  // A refused save/end/delete stays visible on the record until the next
  // mutation attempt — a toast alone once let a refused change read as a
  // silent no-op. The detail is the server's refusal text when present.
  const [actionError, setActionError] = useState<string | null>(null)
  const [componentId, setComponentId] = useState('')
  const [runApplicability, setRunApplicability] = useState<'standard_runs' | 'regular_only'>('standard_runs')
  const [value, setValue] = useState('')
  const [employmentId, setEmploymentId] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(today)
  const [effectiveTo, setEffectiveTo] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    onDirtyChange?.(dirty)
  })

  const load = useCallback((signal?: AbortSignal) => {
    fetch(`/api/payroll/employee-components?employee=${encodeURIComponent(partyId)}`, { signal })
      .then((response) => {
        if (!response.ok) throw new Error('load failed')
        return (response.json() as Promise<Partial<AssignmentsResponse>>).then((next) => {
          // A drifted payload must read as empty, never crash the drawer.
          setData({
            assignments: Array.isArray(next.assignments) ? (next.assignments as AssignmentRow[]) : [],
            components: Array.isArray(next.components) ? (next.components as ComponentOption[]) : [],
            employments: Array.isArray(next.employments) ? (next.employments as EmploymentOption[]) : [],
          })
        })
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setLoadError(true)
        setData(null)
      })
  }, [partyId])

  // Reset when the employee changes, during render (same committed values, no
  // extra render — and no one-commit flash of a stale error banner).
  const [prevPartyId, setPrevPartyId] = useState(partyId)
  if (prevPartyId !== partyId) {
    setRunApplicability('standard_runs')
    setPrevPartyId(partyId)
    setData(null)
    setLoadError(false)
    setActionError(null)
    setDirty(false)
  }

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const selectedComponent = (data?.components ?? []).find((c) => c.id === componentId) ?? null

  function markDirty() {
    setDirty(true)
  }

  async function mutate(payload: Record<string, unknown>, successMessage: string) {
    setBusy(true)
    setActionError(null)
    try {
      const response = await fetch('/api/payroll/employee-components', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        let detail: string | null = null
        try {
          const body = (await response.json()) as { error?: unknown }
          if (typeof body.error === 'string' && body.error.trim()) detail = body.error.trim()
        } catch {
          detail = null
        }
        setActionError(detail ?? t('saveFailed'))
        throw new Error('mutation failed')
      }
      setLoadError(false)
      await load()
      setDirty(false)
      toast.success(successMessage)
      return true
    } catch {
      // A transport failure reaches here with no server detail pinned yet —
      // still leave the generic refusal on the record, not only the toast.
      setActionError((current) => current ?? t('saveFailed'))
      toast.error(t('saveFailed'))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function addAssignment() {
    if (!componentId) {
      toast.error(t('componentRequired'))
      return
    }
    // Keep the override as decimal text all the way to the API. Converting
    // a valid numeric(19,4) value through Number can round it before the exact
    // boundary validator gets a chance to persist it.
    const trimmed = value.trim()
    const canonical = trimmed === '' ? null : canonicalDecimal(trimmed, 4)
    if (trimmed !== '' && canonical === null) {
      toast.error(t('valueRequired'))
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      toast.error(t('effectiveFromRequired'))
      return
    }
    if (effectiveTo !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveTo)) {
      toast.error(t('effectiveToInvalid'))
      return
    }
    const saved = await mutate({
      action: 'save-assignment',
      employeePartyId: partyId,
      employmentId: employmentId === '' ? null : employmentId,
      componentId,
      runApplicability,
      value: canonical,
      effectiveFrom,
      effectiveTo: effectiveTo === '' ? null : effectiveTo,
    }, t('saved'))
    if (saved) {
      setRunApplicability('standard_runs')
      setValue('')
      setEffectiveTo('')
    }
  }

  const formatDate = (value: string) => format.dateTime(new Date(`${value}T12:00:00Z`), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

  const kindLabel = (kind: string) => kind === 'earning' ? t('earning') : kind === 'deduction' ? t('deduction') : t('employerContribution')
  const basisLabel = (basis: string) => basis === 'per_hour' ? t('ratePerHour') : basis === 'percent_of_gross' ? t('percentOfGross') : t('amountPerPeriod')

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('hint')}</p>
        </div>
      </div>

      {actionError ? (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {t('saveFailed')}{actionError === t('saveFailed') ? null : `: ${actionError}`}
        </p>
      ) : null}

      {readOnly ? null : (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-900/60" inert={busy}>
          <div>
            <Label htmlFor="employee-pay-component">{t('component')}</Label>
            <Select
              id="employee-pay-component"
              className="w-52"
              value={componentId}
              onChange={(event) => { setComponentId(event.target.value); markDirty() }}
            >
              <option value="">{t('chooseComponent')}</option>
              {(data?.components ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name} ({kindLabel(c.kind)}, {basisLabel(c.basis)})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="employee-pay-value">
              {selectedComponent ? basisLabel(selectedComponent.basis) : t('value')}
            </Label>
            <Input
              id="employee-pay-value"
              type="number"
              min="0"
              step="0.0001"
              className="w-32"
              placeholder={t('useDefault')}
              value={value}
              onChange={(event) => { setValue(event.target.value); markDirty() }}
            />
          </div>
          {(data?.employments.length ?? 0) > 1 ? (
            <div>
              <Label htmlFor="employee-pay-employment">{t('employment')}</Label>
              <Select
                id="employee-pay-employment"
                className="w-44"
                value={employmentId}
                onChange={(event) => { setEmploymentId(event.target.value); markDirty() }}
              >
                <option value="">{t('allEmployments')}</option>
                {(data?.employments ?? []).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.serviceStart ? formatDate(e.serviceStart) : e.id.slice(0, 8)}{e.subsidiaryName ? ` · ${e.subsidiaryName}` : ''}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <div>
            <Label htmlFor="employee-pay-run-applicability">{t('runApplicability')}</Label>
            <Select id="employee-pay-run-applicability" value={runApplicability}
              disabled={busy} onChange={(event) => { setRunApplicability(event.target.value as 'standard_runs' | 'regular_only'); markDirty() }}>
              <option value="standard_runs">{t('standardRuns')}</option>
              <option value="regular_only">{t('regularOnly')}</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="employee-pay-effective-from">{t('effectiveFrom')}</Label>
            <Input
              id="employee-pay-effective-from"
              type="date"
              className="w-40"
              value={effectiveFrom}
              onChange={(event) => { setEffectiveFrom(event.target.value); markDirty() }}
            />
          </div>
          <div>
            <Label htmlFor="employee-pay-effective-to">{t('effectiveTo')}</Label>
            <Input
              id="employee-pay-effective-to"
              type="date"
              className="w-40"
              value={effectiveTo}
              onChange={(event) => { setEffectiveTo(event.target.value); markDirty() }}
            />
          </div>
          <Button size="sm" onClick={() => void addAssignment()} disabled={busy || data === null}>
            <Plus size={14} aria-hidden /> {t('add')}
          </Button>
        </div>
      )}

      {loadError ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-center dark:border-rose-900 dark:bg-rose-950/30">
          <p className="text-sm text-rose-700 dark:text-rose-300">{tc('feedback.loadFailed')}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => { setLoadError(false); void load() }}>
            {tc('actions.retry')}
          </Button>
        </div>
      ) : data === null ? (
        <p className="py-6 text-center text-sm text-slate-400">{tc('feedback.loading')}</p>
      ) : (
        <PagedTable
          rows={data.assignments}
          rowKey={(row) => row.id}
          rowClassName={(row) => row.isCurrent ? 'bg-teal-50/80 dark:bg-teal-950/30' : undefined}
          // Read mode renders values with no editors: the payroll tab's
          // contract counts every input, including a table filter.
          searchable={!readOnly}
          pageSize={10}
          empty={<p className="py-6 text-center text-sm text-slate-400">{t('empty')}</p>}
          columns={[
            {
              key: 'component',
              header: t('component'),
              search: (row) => `${row.componentCode} ${row.componentName}`,
              cell: (row) => (
                <span className="inline-flex items-center gap-2">
                  <span className="font-medium tabular-nums">{row.componentCode}</span>
                  <span className="text-slate-500 dark:text-slate-400">{row.componentName}</span>
                  {row.isCurrent ? <Badge variant="success">{t('current')}</Badge> : null}
                </span>
              ),
            },
            {
              key: 'kind',
              header: t('kind'),
              search: (row) => kindLabel(row.componentKind),
              cell: (row) => kindLabel(row.componentKind),
            },
            {
              key: 'value',
              header: t('value'),
              align: 'right',
              search: (row) => row.value ?? row.componentValue ?? '',
              cell: (row) => (
                <span className="tabular-nums">
                  {row.value ?? row.componentValue ?? '—'}
                  {row.value == null && row.componentValue != null ? ` (${t('defaultValue')})` : null}
                </span>
              ),
            },
            {
              key: 'runApplicability',
              header: t('runApplicability'),
              search: (row) => row.runApplicability,
              cell: (row) => row.runApplicability === 'regular_only' ? t('regularOnly') : row.runApplicability === 'standard_runs' ? t('standardRuns') : t('unknownApplicability'),
            },
            {
              key: 'from',
              header: t('effectiveFrom'),
              search: (row) => row.effectiveFrom,
              cell: (row) => <span className="tabular-nums">{formatDate(row.effectiveFrom)}</span>,
            },
            {
              key: 'to',
              header: t('effectiveTo'),
              search: (row) => row.effectiveTo ?? '',
              cell: (row) => <span className="tabular-nums">{row.effectiveTo ? formatDate(row.effectiveTo) : '—'}</span>,
            },
            ...(readOnly ? [] : [{
              key: 'actions',
              header: tc('labels.actions'),
              align: 'right' as const,
              cell: (row: AssignmentRow) => (
                <div className="flex justify-end gap-1">
                  {row.isCurrent ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={async () => {
                        if (!(await confirmDialog(t('confirmEnd')))) return
                        void mutate({ action: 'end-assignment', id: row.id, effectiveTo: today }, t('ended'))
                      }}
                    >
                      {t('endToday')}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t('delete')}
                    onClick={async () => {
                      if (!(await confirmDialog(t('confirmDelete')))) return
                      void mutate({ action: 'delete-assignment', id: row.id }, t('deleted'))
                    }}
                  >
                    <Trash2 size={14} aria-hidden />
                  </Button>
                </div>
              ),
            }]),
          ]}
        />
      )}
    </section>
  )
}
