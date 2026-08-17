'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle, Download, Lock, Upload } from 'lucide-react'
import { Badge, Button, FieldHelp, Input, Select, cn } from '@openbooks/ui'
import type {
  OpeningBalanceRow,
  OpeningBalanceYear,
} from '@openbooks/engine/src/payroll-opening-balances.ts'

interface FieldDescriptor {
  key: string
  label: string
  help: string
  packs: string[]
}

interface ComponentDescriptor {
  componentId: string
  code: string
  name: string
  basisCapAmountPerYear: string | null
  capped: boolean
}

interface SaveError {
  employeePartyId: string
  employeeName?: string
  message: string
}

/**
 * The adoption grid: every employee on one screen, one Save.
 *
 * Single-record editing is the wrong shape for this data. An employer adopting
 * mid-year holds ONE year-to-date report and needs the whole workforce carried
 * in together — a drawer opened three hundred times is how a row gets skipped,
 * and a skipped row costs that employee a second annual CPP/EI maximum. Files
 * go through the shared import wizard (/data/import, resource "Payroll opening
 * balances"); this screen is for entering, checking and correcting them.
 *
 * Rows a committed run has already consumed are read-only here and refused by
 * the API — the amounts are inside withholding that has left the bank.
 *
 * The grid carries BOTH dimensions of a year's carry-in: the statutory columns,
 * then one column per annually-capped pay component. They belong on the same row
 * because they are the same fact about the same employee and the same year, and
 * are frozen by the same committed run — a second screen would be a second place
 * to forget.
 */
export function OpeningBalancesView({
  year,
  initial,
  fields,
  components,
  canManage,
}: {
  year: number
  initial: OpeningBalanceYear
  fields: FieldDescriptor[]
  components: ComponentDescriptor[]
  canManage: boolean
}) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const text = (key: string, fallback: string) =>
    t.has(`openingBalances.${key}` as never) ? t(`openingBalances.${key}` as never) : fallback

  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})
  // Component openings are kept in their own draft rather than sharing the
  // statutory one: they are written to a different table, and one map keyed by
  // two unrelated key spaces is how a component id starts being read as a field.
  const [componentDraft, setComponentDraft] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<SaveError[]>([])
  const [onlyMissing, setOnlyMissing] = useState(false)

  const years = useMemo(() => {
    const span = new Set<number>(initial.years)
    const now = new Date().getUTCFullYear()
    for (let y = now + 1; y >= now - 4; y--) span.add(y)
    span.add(year)
    return [...span].sort((a, b) => b - a)
  }, [initial.years, year])

  // Only show a column some employee's country pack actually reads. A US-only
  // payroll has no CPP2, and a column of permanently blank boxes is noise that
  // makes the columns that matter harder to find.
  const packs = useMemo(() => {
    const present = new Set(initial.rows.map((r) => r.country ?? 'CA'))
    return present.size === 0 ? new Set(['CA']) : present
  }, [initial.rows])
  const visibleFields = useMemo(
    () => fields.filter((f) => f.packs.some((pack) => packs.has(pack))),
    [fields, packs],
  )

  const valueOf = (row: OpeningBalanceRow, key: string): string => {
    const edited = draft[row.employeePartyId]?.[key]
    if (edited !== undefined) return edited
    const stored = row.amounts?.[key]
    if (stored === undefined) return ''
    // Show a stored zero as blank: "nothing carried in" reads better empty.
    return Number(stored) === 0 ? '' : trimZeros(stored)
  }

  const setValue = (employeePartyId: string, key: string, value: string) => {
    setDraft((current) => ({
      ...current,
      [employeePartyId]: { ...(current[employeePartyId] ?? {}), [key]: value },
    }))
  }

  const componentValueOf = (row: OpeningBalanceRow, componentId: string): string => {
    const edited = componentDraft[row.employeePartyId]?.[componentId]
    if (edited !== undefined) return edited
    const stored = row.componentAmounts?.[componentId]
    if (stored === undefined) return ''
    return Number(stored) === 0 ? '' : trimZeros(stored)
  }

  const setComponentValue = (employeePartyId: string, componentId: string, value: string) => {
    setComponentDraft((current) => ({
      ...current,
      [employeePartyId]: { ...(current[employeePartyId] ?? {}), [componentId]: value },
    }))
  }

  const dirtyIds = [...new Set([...Object.keys(draft), ...Object.keys(componentDraft)])]
  const rows = onlyMissing
    ? initial.rows.filter((r) => r.amounts === null && !r.locked)
    : initial.rows
  const missingCount = initial.rows.filter((r) => r.amounts === null && !r.locked).length
  const lockedCount = initial.rows.filter((r) => r.locked).length

  const save = async () => {
    if (dirtyIds.length === 0) return
    setSaving(true)
    setErrors([])
    try {
      const payload = dirtyIds.map((employeePartyId) => {
        const row = initial.rows.find((r) => r.employeePartyId === employeePartyId)
        const amounts: Record<string, string> = {}
        for (const field of fields) {
          const edited = draft[employeePartyId]?.[field.key]
          amounts[field.key] = edited !== undefined
            ? edited.trim()
            : (row?.amounts?.[field.key] ?? '0')
        }
        // Every EDITABLE component is sent, edited or not: the service replaces
        // the set, so an omitted one would silently survive a clear. Components
        // whose annual cap has since been removed are read-only here and are
        // carried forward by the service, so they are deliberately not sent.
        const componentAmounts: Record<string, string> = {}
        for (const component of components) {
          if (!component.capped) continue
          const edited = componentDraft[employeePartyId]?.[component.componentId]
          componentAmounts[component.componentId] = edited !== undefined
            ? edited.trim()
            : (row?.componentAmounts?.[component.componentId] ?? '0')
        }
        return { employeePartyId, amounts, components: componentAmounts }
      })
      const response = await fetch('/api/payroll/opening-balances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taxYear: year, rows: payload }),
      })
      const body = (await response.json()) as {
        error?: string
        errors?: SaveError[]
        created?: number
        updated?: number
        deleted?: number
      }
      if (!response.ok) {
        setErrors(body.errors ?? [{ employeePartyId: '', message: body.error ?? 'save failed' }])
        toast.error(body.error ?? text('saveFailed', 'Nothing was saved.'))
        return
      }
      setDraft({})
      setComponentDraft({})
      toast.success(
        text('saved', 'Opening balances saved.') +
          ` (${body.created ?? 0} new, ${body.updated ?? 0} updated, ${body.deleted ?? 0} cleared)`,
      )
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={text('yearLabel', 'Tax year')}
          value={String(year)}
          onChange={(event) =>
            router.push(`/payroll/opening-balances?year=${event.target.value}` as never)
          }
          className="w-32"
        >
          {years.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </Select>
        <FieldHelp
          help={text(
            'hint',
            'Copy these from the outgoing provider’s year-to-date report as at the day before your first pay period here. Leave an employee blank if they had no pay from you earlier in the year.',
          )}
        />
        <Button
          variant={onlyMissing ? 'default' : 'outline'}
          size="sm"
          onClick={() => setOnlyMissing((current) => !current)}
        >
          {text('onlyMissing', 'Only employees with no carry-in')} ({missingCount})
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={'/data/import' as never}>
            <Upload size={14} aria-hidden />
            {text('bulkImport', 'Bulk load from a file')}
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={'/data/export' as never}>
            <Download size={14} aria-hidden />
            {text('export', 'Export')}
          </Link>
        </Button>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {text('entered', 'Carried in')}: {initial.entered} / {initial.rows.length}
            {lockedCount > 0 ? ` · ${lockedCount} ${text('lockedShort', 'locked')}` : ''}
          </span>
          {canManage && (
            <Button size="sm" disabled={saving || dirtyIds.length === 0} onClick={save}>
              {saving
                ? text('saving', 'Saving…')
                : `${text('save', 'Save')}${dirtyIds.length ? ` (${dirtyIds.length})` : ''}`}
            </Button>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm dark:border-red-900/60 dark:bg-red-950/40">
          <p className="flex items-center gap-2 font-medium text-red-800 dark:text-red-300">
            <AlertTriangle size={15} aria-hidden />
            {text('rejected', 'Nothing was saved — fix these first.')}
          </p>
          <ul className="mt-2 space-y-1 text-red-700 dark:text-red-300">
            {errors.map((error, index) => (
              <li key={`${error.employeePartyId}-${index}`}>
                {error.employeeName ? `${error.employeeName}: ` : ''}
                {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="w-full min-w-max text-sm">
          <thead className="bg-slate-50 text-left dark:bg-slate-900">
            <tr>
              <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 font-medium text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                {text('employee', 'Employee')}
              </th>
              {visibleFields.map((field) => (
                <th
                  key={field.key}
                  className="px-3 py-2 text-right font-medium whitespace-nowrap text-slate-600 dark:text-slate-300"
                >
                  <span className="inline-flex items-center gap-1">
                    {t.has(`openingBalances.fields.${field.key}` as never)
                      ? t(`openingBalances.fields.${field.key}` as never)
                      : field.label}
                    <FieldHelp help={field.help} />
                  </span>
                </th>
              ))}
              {components.map((component, index) => (
                <th
                  key={component.componentId}
                  className={cn(
                    'px-3 py-2 text-right font-medium whitespace-nowrap text-slate-600 dark:text-slate-300',
                    index === 0 && 'border-l border-slate-200 dark:border-slate-800',
                  )}
                >
                  <span className="inline-flex items-center gap-1">
                    {component.name}
                    <FieldHelp
                      help={
                        component.capped
                          ? text(
                              'componentHelp',
                              'How much of this component’s annual cap the employee has already used this year, at your previous payroll system. Without it the cap restarts at zero and the employee can contribute a second full annual limit.',
                            ) + ` (${text('componentCap', 'Annual cap')}: ${component.basisCapAmountPerYear ?? '—'})`
                          : text(
                              'componentInertHelp',
                              'This component no longer has an annual cap, so the amount below changes nothing and cannot be edited. It is kept because somebody entered it and a cap may be set again.',
                            )
                      }
                    />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={visibleFields.length + components.length + 1}
                  className="px-3 py-8 text-center text-slate-400 dark:text-slate-500"
                >
                  {text('empty', 'No employees have an active payroll profile yet.')}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.employeePartyId}
                className={cn(row.locked && 'bg-slate-50/60 dark:bg-slate-900/40')}
              >
                <td className="sticky left-0 z-10 bg-white px-3 py-1.5 whitespace-nowrap dark:bg-slate-950">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      {row.employeeName}
                    </span>
                    {row.employeeNumber && (
                      <span className="text-xs text-slate-400">{row.employeeNumber}</span>
                    )}
                    {row.locked && (
                      <Badge
                        variant="default"
                        title={
                          row.lockedBy
                            ? `${text('lockedBy', 'Committed pay run')} ${row.lockedBy.documentNumber ?? ''} · ${row.lockedBy.payDate}`
                            : undefined
                        }
                      >
                        <Lock size={11} aria-hidden />
                        {text('locked', 'Locked')}
                      </Badge>
                    )}
                    {!row.locked && row.amounts === null && (
                      <span className="text-xs text-amber-600 dark:text-amber-400">
                        {text('none', 'none')}
                      </span>
                    )}
                  </div>
                </td>
                {visibleFields.map((field) => {
                  const applies = field.packs.includes(row.country ?? 'CA')
                  return (
                    <td key={field.key} className="px-2 py-1.5 text-right">
                      {applies ? (
                        <Input
                          inputMode="decimal"
                          disabled={row.locked || !canManage}
                          aria-label={`${row.employeeName} — ${field.label}`}
                          className="w-32 text-right tabular-nums"
                          value={valueOf(row, field.key)}
                          placeholder="0.00"
                          onChange={(event) =>
                            setValue(row.employeePartyId, field.key, event.target.value)
                          }
                        />
                      ) : (
                        <span className="text-xs text-slate-300 dark:text-slate-700">—</span>
                      )}
                    </td>
                  )
                })}
                {components.map((component, index) => (
                  <td
                    key={component.componentId}
                    className={cn(
                      'px-2 py-1.5 text-right',
                      index === 0 && 'border-l border-slate-200 dark:border-slate-800',
                    )}
                  >
                    <Input
                      inputMode="decimal"
                      disabled={row.locked || !canManage || !component.capped}
                      aria-label={`${row.employeeName} — ${component.name}`}
                      className="w-32 text-right tabular-nums"
                      value={componentValueOf(row, component.componentId)}
                      placeholder="0.00"
                      onChange={(event) =>
                        setComponentValue(row.employeePartyId, component.componentId, event.target.value)
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 40000.0000 → 40000, 2380.5000 → 2380.50 — readable without losing cents. */
function trimZeros(value: string): string {
  if (!value.includes('.')) return value
  const [whole, fraction = ''] = value.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  if (trimmed === '') return whole!
  return `${whole}.${trimmed.length === 1 ? `${trimmed}0` : trimmed}`
}
