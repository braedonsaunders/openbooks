'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Download,
  Lock,
  Upload,
  ChevronRight,
} from 'lucide-react'
import { Badge, Button, Drawer, FieldHelp, Label, Select } from '@openbooks/ui'
import {
  canonicalDecimal,
  isZeroDecimal,
} from '@openbooks/engine/src/money/exact-decimal.ts'
import { apiJson, ApiResponseError } from '../../../../lib/api-error'
import { PagedTable } from '../../../../components/paged-table'
import { RecordTabs } from '../../../../components/module-home/record-tabs'
import { MoneyInput, moneyFieldError } from '../../../../components/money-input'
import { PeriodOpeningForm, type PeriodOpeningDraft } from './PeriodOpeningForm'
import type {
  OpeningBalanceRow,
  OpeningBalanceYear,
} from '@openbooks/engine/src/payroll/opening-balances.ts'

interface FieldDescriptor {
  key: string
  label: string
  help: string
  packs: string[]
}

interface ProgramDescriptor {
  key: string
  label: string
  help: string
  packs: string[]
}

interface SuiStateDescriptor {
  key: string
  label: string
  help: string
  packs: string[]
}

type SuiCarryRow = OpeningBalanceRow & {
  suiStateAmounts?: Record<string, string>
}

interface AccountProgramDescriptor {
  key: string
  programKey: string
  label: string
  help: string
  country: string
  filingAccountId: string
  region: string | null
  requiresRegion: boolean
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

/** Employee carry-ins share one draft and bulk save across searched pages and drawers. */
type OpeningBalancesViewProps = {
  year: number
  /** Organization business year — not the UTC calendar year. */
  currentYear: number
  initial: OpeningBalanceYear
  fields: FieldDescriptor[]
  /** One carry-in column per pack-declared contribution program. */
  programs: ProgramDescriptor[]
  /** One carry-in column per US state for SUI-insurable wages. */
  suiStates?: SuiStateDescriptor[]
  /** Per EIN / state account bases declared by the country pack. */
  accountPrograms?: AccountProgramDescriptor[]
  components: ComponentDescriptor[]
  canManage: boolean
  hideYearPicker?: boolean
  onDirtyChange?: (count: number) => void
}

export function OpeningBalancesView(props: OpeningBalancesViewProps) {
  return <OpeningBalancesYearView key={props.year} {...props} />
}

function OpeningBalancesYearView({
  year,
  currentYear,
  initial,
  fields,
  programs,
  suiStates = [],
  accountPrograms = [],
  components,
  canManage,
  hideYearPicker = false,
  onDirtyChange,
}: OpeningBalancesViewProps) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const text = (key: string, fallback: string) =>
    t.has(`openingBalances.${key}` as never)
      ? t(`openingBalances.${key}` as never)
      : fallback

  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})
  // Component openings are kept in their own draft rather than sharing the
  // statutory one: they are written to a different table, and one map keyed by
  // two unrelated key spaces is how a component id starts being read as a field.
  const [componentDraft, setComponentDraft] = useState<
    Record<string, Record<string, string>>
  >({})
  // Program carry-ins get the same treatment: a third table, a third key
  // space (pack-declared program keys), a third draft.
  const [programDraft, setProgramDraft] = useState<
    Record<string, Record<string, string>>
  >({})
  // State SUI carry-ins get the same treatment again: a fourth table keyed
  // by US state code, so a state code can never be read as a program key.
  const [suiDraft, setSuiDraft] = useState<
    Record<string, Record<string, string>>
  >({})
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<SaveError[]>([])
  const [skipped, setSkipped] = useState<SaveError[]>([])
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [section, setSection] = useState<'ytd' | 'bases' | 'caps' | 'period'>('ytd')
  const [periodDrafts, setPeriodDrafts] = useState<Record<string, PeriodOpeningDraft>>({})
  const [periodBusy, setPeriodBusy] = useState(false)
  const workspace = useTranslations('payroll.openingBalances.workspace')

  const years = useMemo(() => {
    const span = new Set<number>(initial.years)
    for (let y = currentYear + 1; y >= currentYear - 4; y--) span.add(y)
    span.add(year)
    return [...span].sort((a, b) => b - a)
  }, [initial.years, year, currentYear])

  // Only show a column some employee's country pack actually reads. A US-only
  // payroll has no CPP2, and a column of permanently blank boxes is noise that
  // makes the columns that matter harder to find.
  //
  // Unknown country (an orphan row whose profile is gone) assumes NOTHING:
  // every pack's columns stay offered rather than defaulting the row to
  // Canada — the exact silent-Canada fallthrough the engine refuses
  // (engine/src/payroll/packs.ts). An empty grid offers no pack columns:
  // there is nobody to carry anything in for.
  const packs = useMemo(() => {
    const present = new Set<string>()
    for (const row of initial.rows) {
      if (row.country) present.add(row.country)
      else
        for (const field of fields)
          for (const pack of field.packs) present.add(pack)
    }
    return present
  }, [initial.rows, fields])
  const visibleFields = useMemo(
    () => fields.filter((f) => f.packs.some((pack) => packs.has(pack))),
    [fields, packs],
  )
  // Program columns follow the same pack rule: a program only its declaring
  // pack reads stays hidden everywhere else, like the statutory columns.
  const visiblePrograms = useMemo(
    () => programs.filter((p) => p.packs.some((pack) => packs.has(pack))),
    [programs, packs],
  )
  // State SUI columns follow the same pack rule: they appear only where a
  // US (or orphan) row can carry them, like the program columns.
  const visibleSuiStates = useMemo(
    () => suiStates.filter((s) => s.packs.some((pack) => packs.has(pack))),
    [suiStates, packs],
  )
  const visibleAccountPrograms = useMemo(
    () => accountPrograms.filter((p) => packs.has(p.country)),
    [accountPrograms, packs],
  )

  const valueOf = (row: OpeningBalanceRow, key: string): string => {
    const edited = draft[row.employeePartyId]?.[key]
    if (edited !== undefined) return edited
    const stored = row.amounts?.[key]
    if (stored === undefined) return ''
    // Show a stored zero as blank: "nothing carried in" reads better empty.
    // A decimal-string comparison, never Number(): floats cannot read money.
    // Non-canonical text (which the server would never have written) still
    // displays raw rather than throwing out of the render.
    return stored !== '' &&
      canonicalDecimal(stored, 4) !== null &&
      isZeroDecimal(stored)
      ? ''
      : trimZeros(stored)
  }

  const setValue = (employeePartyId: string, key: string, value: string) => {
    setDraft((current) => ({
      ...current,
      [employeePartyId]: { ...(current[employeePartyId] ?? {}), [key]: value },
    }))
  }

  const componentValueOf = (
    row: OpeningBalanceRow,
    componentId: string,
  ): string => {
    const edited = componentDraft[row.employeePartyId]?.[componentId]
    if (edited !== undefined) return edited
    const stored = row.componentAmounts?.[componentId]
    if (stored === undefined) return ''
    return stored !== '' &&
      canonicalDecimal(stored, 4) !== null &&
      isZeroDecimal(stored)
      ? ''
      : trimZeros(stored)
  }

  const setComponentValue = (
    employeePartyId: string,
    componentId: string,
    value: string,
  ) => {
    setComponentDraft((current) => ({
      ...current,
      [employeePartyId]: {
        ...(current[employeePartyId] ?? {}),
        [componentId]: value,
      },
    }))
  }

  const programValueOf = (
    row: OpeningBalanceRow,
    program: ProgramDescriptor,
  ): string => {
    const edited = programDraft[row.employeePartyId]?.[program.key]
    if (edited !== undefined) return edited
    const stored = row.programAmounts?.[program.key]
    if (stored === undefined) return ''
    return stored !== '' &&
      canonicalDecimal(stored, 4) !== null &&
      isZeroDecimal(stored)
      ? ''
      : trimZeros(stored)
  }

  const accountProgramValueOf = (
    row: OpeningBalanceRow,
    program: AccountProgramDescriptor,
  ): string => {
    const edited = programDraft[row.employeePartyId]?.[`account:${program.key}`]
    if (edited !== undefined) return edited
    const stored = row.accountBases.find(
      (base) =>
        base.programKey === program.programKey &&
        base.filingAccountId === program.filingAccountId &&
        base.region === program.region,
    )?.insurableYtd
    if (stored === undefined) return ''
    return stored !== '' &&
      canonicalDecimal(stored, 4) !== null &&
      isZeroDecimal(stored)
      ? ''
      : trimZeros(stored)
  }

  const setProgramValue = (
    employeePartyId: string,
    key: string,
    value: string,
  ) => {
    setProgramDraft((current) => ({
      ...current,
      [employeePartyId]: { ...(current[employeePartyId] ?? {}), [key]: value },
    }))
  }

  const suiValueOf = (row: SuiCarryRow, key: string): string => {
    const edited = suiDraft[row.employeePartyId]?.[key]
    if (edited !== undefined) return edited
    const stored = row.suiStateAmounts?.[key]
    if (stored === undefined) return ''
    return stored !== '' &&
      canonicalDecimal(stored, 4) !== null &&
      isZeroDecimal(stored)
      ? ''
      : trimZeros(stored)
  }

  const setSuiValue = (employeePartyId: string, key: string, value: string) => {
    setSuiDraft((current) => ({
      ...current,
      [employeePartyId]: { ...(current[employeePartyId] ?? {}), [key]: value },
    }))
  }

  const dirtyIds = [
    ...new Set([
      ...Object.keys(draft),
      ...Object.keys(componentDraft),
      ...Object.keys(programDraft),
      ...Object.keys(suiDraft),
    ]),
  ]
  const rows = onlyMissing
    ? initial.rows.filter((r) => r.amounts === null && !r.locked)
    : initial.rows
  const activeRow = initial.rows.find((row) => row.employeePartyId === activeId)
  const unsavedEmployeeCount = new Set([...dirtyIds, ...Object.entries(periodDrafts)
    .filter(([, period]) => period.dirty).map(([employeeId]) => employeeId)]).size
  useEffect(() => {
    onDirtyChange?.(unsavedEmployeeCount)
  }, [unsavedEmployeeCount, onDirtyChange])
  const missingCount = initial.rows.filter(
    (r) => r.amounts === null && !r.locked,
  ).length
  const lockedCount = initial.rows.filter((r) => r.locked).length

  const save = async () => {
    if (dirtyIds.length === 0 || periodBusy || saving) return
    setSaving(true)
    setErrors([])
    const fallback = text('saveFailed', 'Nothing was saved.')
    setSkipped([])
    try {
      const payload = dirtyIds.map((employeePartyId) => {
        const row: SuiCarryRow | undefined = initial.rows.find(
          (r) => r.employeePartyId === employeePartyId,
        )
        const amounts: Record<string, string> = {}
        for (const field of fields) {
          const edited = draft[employeePartyId]?.[field.key]
          // Untouched-absent replays as blank, not '0': the server treats
          // blank as omitted and keeps what is stored. Replaying '0' would
          // conjure carry-ins the operator never entered — for the IT
          // assessed-saldo columns a conjured zero would silence the
          // installment channel's refusal. Generic amounts normalize blank
          // to zero identically, so statutory behavior is unchanged.
          amounts[field.key] =
            edited !== undefined
              ? edited.trim()
              : (row?.amounts?.[field.key] ?? '')
        }
        // Every EDITABLE component is sent, edited or not: the service replaces
        // the set, so an omitted one would silently survive a clear. Components
        // whose annual cap has since been removed are read-only here and are
        // carried forward by the service, so they are deliberately not sent.
        const componentAmounts: Record<string, string> = {}
        for (const component of components) {
          if (!component.capped) continue
          const edited =
            componentDraft[employeePartyId]?.[component.componentId]
          componentAmounts[component.componentId] =
            edited !== undefined
              ? edited.trim()
              : (row?.componentAmounts?.[component.componentId] ?? '0')
        }
        // Only VISIBLE programs are sent, edited or not (same replace-the-set
        // rule as components). A program hidden by the pack filter is omitted
        // entirely so the service keeps what is stored: sending it would
        // clear a carry-in the operator cannot see.
        let programAmounts: Record<string, string> | undefined
        if (visiblePrograms.length > 0) {
          programAmounts = {}
          for (const program of visiblePrograms) {
            const edited = programDraft[employeePartyId]?.[program.key]
            programAmounts[program.key] =
              edited !== undefined
                ? edited.trim()
                : (row?.programAmounts?.[program.key] ?? '0')
          }
        }
        // Only VISIBLE states are sent, edited or not (same replace-the-set
        // rule as programs). A state hidden by the pack filter is omitted
        // entirely so the service keeps what is stored.
        let suiStateAmounts: Record<string, string> | undefined
        if (visibleSuiStates.length > 0) {
          suiStateAmounts = {}
          for (const sui of visibleSuiStates) {
            const edited = suiDraft[employeePartyId]?.[sui.key]
            suiStateAmounts[sui.key] =
              edited !== undefined
                ? edited.trim()
                : (row?.suiStateAmounts?.[sui.key] ?? '0')
          }
        }
        const accountBases = (row?.accountBases ?? [])
          .filter(
            (base) =>
              !visibleAccountPrograms.some(
                (program) =>
                  program.programKey === base.programKey &&
                  program.filingAccountId === base.filingAccountId &&
                  program.region === base.region,
              ),
          )
          .map((base) => ({ ...base }))
        for (const program of visibleAccountPrograms) {
          const draftKey = `account:${program.key}`
          const edited = programDraft[employeePartyId]?.[draftKey]
          accountBases.push({
            programKey: program.programKey,
            filingAccountId: program.filingAccountId,
            region: program.region,
            insurableYtd:
              edited !== undefined
                ? edited.trim()
                : (row?.accountBases.find(
                    (base) =>
                      base.programKey === program.programKey &&
                      base.filingAccountId === program.filingAccountId &&
                      base.region === program.region,
                  )?.insurableYtd ?? '0'),
          })
        }
        // The row's loader-served version: a carry-in someone else saved
        // after this snapshot refuses with a named 409 instead of being
        // silently overwritten by these replayed full-row amounts.
        return {
          employeePartyId,
          updatedAt: row?.updatedAt ?? null,
          amounts,
          components: componentAmounts,
          programs: programAmounts,
          suiStates: suiStateAmounts,
          ...(visibleAccountPrograms.length > 0 ? { accountBases } : {}),
        }
      })
      // Client-side decimal gate: every EDITED non-blank value is classified
      // through the shared decimal helper before anything is posted, so an
      // unreadable carry-in names its cause and remedy without a round trip.
      // Blank clears (the server treats it as omitted); untouched cells were
      // already accepted when they were written.
      const clientErrors: SaveError[] = []
      for (const employeePartyId of dirtyIds) {
        const row = initial.rows.find(
          (r) => r.employeePartyId === employeePartyId,
        )
        for (const field of fields) {
          const edited = draft[employeePartyId]?.[field.key]
          if (edited === undefined || edited.trim() === '') continue
          const refusal = moneyFieldError(
            field.label,
            'a money amount',
            edited,
            4,
          )
          if (refusal !== null) {
            clientErrors.push({
              employeePartyId,
              employeeName: row?.employeeName,
              message: refusal,
            })
          }
        }
        for (const component of components) {
          if (!component.capped) continue
          const edited =
            componentDraft[employeePartyId]?.[component.componentId]
          if (edited === undefined || edited.trim() === '') continue
          const refusal = moneyFieldError(
            component.name,
            'a money amount',
            edited,
            4,
          )
          if (refusal !== null) {
            clientErrors.push({
              employeePartyId,
              employeeName: row?.employeeName,
              message: refusal,
            })
          }
        }
        for (const program of visiblePrograms) {
          const edited = programDraft[employeePartyId]?.[program.key]
          if (edited === undefined || edited.trim() === '') continue
          const refusal = moneyFieldError(
            program.label,
            'a money amount',
            edited,
            4,
          )
          if (refusal !== null) {
            clientErrors.push({
              employeePartyId,
              employeeName: row?.employeeName,
              message: refusal,
            })
          }
        }
        for (const sui of visibleSuiStates) {
          const edited = suiDraft[employeePartyId]?.[sui.key]
          if (edited === undefined || edited.trim() === '') continue
          const refusal = moneyFieldError(
            sui.label,
            'a money amount',
            edited,
            4,
          )
          if (refusal !== null) {
            clientErrors.push({
              employeePartyId,
              employeeName: row?.employeeName,
              message: refusal,
            })
          }
        }
        for (const program of visibleAccountPrograms) {
          const edited =
            programDraft[employeePartyId]?.[`account:${program.key}`]
          if (edited === undefined || edited.trim() === '') continue
          const refusal = moneyFieldError(
            program.label,
            'a money amount',
            edited,
            4,
          )
          if (refusal !== null) {
            clientErrors.push({
              employeePartyId,
              employeeName: row?.employeeName,
              message: refusal,
            })
          }
        }
      }
      if (clientErrors.length > 0) {
        setErrors(clientErrors)
        toast.error(fallback)
        return
      }
      const body = await apiJson<{
        created?: number
        updated?: number
        deleted?: number
        skipped?: SaveError[]
      }>(
        '/api/payroll/opening-balances',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ taxYear: year, rows: payload }),
        },
        fallback,
      )
      setDraft({})
      setComponentDraft({})
      setProgramDraft({})
      setSuiDraft({})
      // A non-strict bulk load leaves locked employees untouched: their
      // carry-in is already inside a committed run. The save still succeeds
      // for everyone else, so the skipped rows are listed by name rather than
      // reported as an error — otherwise the operator believes the load
      // applied while that employee restarts YTD at zero.
      const skippedRows = body.skipped ?? []
      setSkipped(skippedRows)
      toast.success(
        text('saved', 'Opening balances saved.') +
          ` (${body.created ?? 0} new, ${body.updated ?? 0} updated, ${body.deleted ?? 0} cleared` +
          (skippedRows.length > 0 ? `, ${skippedRows.length} skipped` : '') +
          `)`,
      )
      router.refresh()
    } catch (e) {
      // A thrown fetch (the network is down, the server hung up) is a
      // failure with a toast, never an unhandled rejection that leaves the
      // grid showing stale edits as saved.
      const message = e instanceof Error ? e.message : fallback
      const reasons =
        e instanceof ApiResponseError
          ? (e.body as { errors?: SaveError[] } | null)?.errors
          : undefined
      setErrors(reasons?.length ? reasons : [{ employeePartyId: '', message }])
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {!hideYearPicker && (
          <Select
            aria-label={text('yearLabel', 'Tax year')}
            value={String(year)}
            onChange={(event) =>
              router.push(
                `/payroll/opening-balances?year=${event.target.value}` as never,
              )
            }
            className="w-32"
          >
            {years.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        )}
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
          {text('onlyMissing', 'Only employees with no carry-in')} (
          {missingCount})
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
            {text('entered', 'Carried in')}: {initial.entered} /{' '}
            {initial.rows.length}
            {lockedCount > 0
              ? ` · ${lockedCount} ${text('lockedShort', 'locked')}`
              : ''}
          </span>
          {canManage && (
            <Button
              size="sm"
              disabled={saving || dirtyIds.length === 0}
              onClick={save}
            >
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

      {skipped.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/40">
          <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
            <Lock size={15} aria-hidden />
            {text(
              'skipped',
              `${skipped.length} ${skipped.length === 1 ? 'employee was' : 'employees were'} left unchanged — a committed run already consumed their carry-in. Everyone else was saved.`,
            )}
          </p>
          <ul className="mt-2 space-y-1 text-amber-700 dark:text-amber-300">
            {skipped.map((row, index) => (
              <li key={`${row.employeePartyId}-${index}`}>
                {row.employeeName ? `${row.employeeName}: ` : ''}
                {row.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-sm text-slate-500 dark:text-slate-400">
        {workspace('employeeHint')}
      </p>
      <PagedTable
        source="payroll_opening_employees"
        rows={rows}
        searchable
        pageSize={25}
        rowKey={(row) => row.employeePartyId}
        rowLabel={(row) => row.employeeName}
        onRowClick={(row) => {
          setActiveId(row.employeePartyId)
          setSection('ytd')
        }}
        empty={text(
          'empty',
          'No employees have an active payroll profile yet.',
        )}
        columns={[
          {
            key: 'employee',
            header: text('employee', 'Employee'),
            search: (row) => `${row.employeeName} ${row.employeeNumber ?? ''}`,
            cell: (row) => (
              <div>
                <span className="font-medium">{row.employeeName}</span>
                <p className="text-xs text-slate-400">
                  {row.employeeNumber ?? '—'}
                </p>
              </div>
            ),
          },
          {
            key: 'jurisdiction',
            header: workspace('jurisdiction'),
            search: (row) => `${row.country ?? ''} ${row.province ?? ''}`,
            cell: (row) =>
              [row.country, row.province].filter(Boolean).join(' · ') || '—',
          },
          {
            key: 'status',
            header: workspace('status'),
            cell: (row) => (
              <Badge variant="outline">
                {row.locked ? (
                  <>
                    <Lock size={11} aria-hidden />
                    {text('locked', 'Locked')}
                  </>
                ) : dirtyIds.includes(row.employeePartyId) ? (
                  workspace('unsaved')
                ) : row.amounts !== null ? (
                  workspace('recorded')
                ) : (
                  workspace('noCarryIn')
                )}
              </Badge>
            ),
          },
          {
            key: 'gross',
            header: workspace('grossYtd'),
            align: 'right',
            cell: (row) => (
              <span className="tabular-nums">
                {valueOf(row, 'grossYtd') || '—'}
              </span>
            ),
          },
          {
            key: 'open',
            header: <span className="sr-only">{workspace('review')}</span>,
            align: 'right',
            cell: () => (
              <ChevronRight
                size={16}
                className="ml-auto text-slate-400"
                aria-hidden
              />
            ),
          },
        ]}
      />
      <Drawer
        open={!!activeRow}
        onClose={() => {
          if (!saving && !periodBusy) setActiveId(null)
        }}
        title={activeRow?.employeeName ?? workspace('employees')}
        description={`${year} · ${[activeRow?.employeeNumber, activeRow?.country, activeRow?.province].filter(Boolean).join(' · ')}`}
        size="lg"
        subtabs={
          <RecordTabs
            label={workspace('balanceSections')}
            active={section}
            onChange={next => { if (!periodBusy) setSection(next) }}
            tabs={[
              { key: 'ytd', label: workspace('ytd') },
              {
                key: 'bases',
                label: workspace('bases'),
                count:
                  visiblePrograms.length +
                  visibleSuiStates.length +
                  visibleAccountPrograms.length,
              },
              {
                key: 'caps',
                label: workspace('caps'),
                count: components.length,
              },
              { key: 'period', label: t('openingBalances.period.title'), disabled: periodBusy },
            ]}
          />
        }
        footer={
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">{workspace('draftHint')}</p>
            <Button
              variant="outline"
              disabled={saving || periodBusy}
              onClick={() => setActiveId(null)}
            >
              {workspace('done')}
            </Button>
            {canManage && (
              <Button disabled={saving || periodBusy || dirtyIds.length === 0} onClick={save}>
                {saving
                  ? text('saving', 'Saving…')
                  : `${workspace('saveAll')} (${dirtyIds.length})`}
              </Button>
            )}
          </div>
        }
      >
        {activeRow && (
          <div className="space-y-5">
            {section === 'period' && <PeriodOpeningForm
              employeePartyId={activeRow.employeePartyId} employeeName={activeRow.employeeName} year={year}
              draft={periodDrafts[activeRow.employeePartyId]} canManage={canManage} locked={activeRow.locked}
              annualDirty={dirtyIds.includes(activeRow.employeePartyId)} onBusyChange={setPeriodBusy}
              onChange={next => setPeriodDrafts(current => ({ ...current, [activeRow.employeePartyId]: next }))}
              onSaved={() => router.refresh()}
            />}
            {activeRow.locked && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-900">
                <Lock size={14} className="mr-2 inline" aria-hidden />
                {text('lockedBy', 'Committed pay run')}{' '}
                {activeRow.lockedBy?.documentNumber} ·{' '}
                {activeRow.lockedBy?.payDate}
              </div>
            )}
            {errors.length > 0 && (
              <div
                role="alert"
                className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
              >
                {errors.map((error, index) => (
                  <p key={index}>
                    {error.employeeName ? `${error.employeeName}: ` : ''}
                    {error.message}
                  </p>
                ))}
              </div>
            )}
            <div
              hidden={section !== 'ytd'}
              className="grid gap-4 sm:grid-cols-2"
            >
              {visibleFields
                .filter(
                  (field) =>
                    activeRow.country == null ||
                    field.packs.includes(activeRow.country),
                )
                .map((field) => (
                  <div key={field.key} className="space-y-1.5">
                    <Label help={field.help}>
                      {t.has(`openingBalances.fields.${field.key}` as never)
                        ? t(`openingBalances.fields.${field.key}` as never)
                        : field.label}
                    </Label>
                    <MoneyInput
                      ariaLabel={`${activeRow.employeeName} — ${field.label}`}
                      value={valueOf(activeRow, field.key)}
                      onChange={(value) =>
                        setValue(activeRow.employeePartyId, field.key, value)
                      }
                      field={field.label}
                      noun="a money amount"
                      maxScale={4}
                      placeholder="0.00"
                      disabled={activeRow.locked || !canManage || saving}
                      className="text-right tabular-nums"
                    />
                  </div>
                ))}
            </div>
            <div hidden={section !== 'bases'} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                {visiblePrograms
                  .filter(
                    (program) =>
                      activeRow.country == null ||
                      program.packs.includes(activeRow.country),
                  )
                  .map((program) => (
                    <div key={program.key} className="space-y-1.5">
                      <Label help={program.help}>{program.label}</Label>
                      <MoneyInput
                        ariaLabel={`${activeRow.employeeName} — ${program.label}`}
                        value={programValueOf(activeRow, program)}
                        onChange={(value) =>
                          setProgramValue(
                            activeRow.employeePartyId,
                            program.key,
                            value,
                          )
                        }
                        field={program.label}
                        noun="a money amount"
                        maxScale={4}
                        placeholder="0.00"
                        disabled={activeRow.locked || !canManage || saving}
                        className="text-right tabular-nums"
                      />
                    </div>
                  ))}
                {visibleAccountPrograms
                  .filter(
                    (program) =>
                      activeRow.country == null ||
                      activeRow.country === program.country,
                  )
                  .map((program) => (
                    <div key={program.key} className="space-y-1.5">
                      <Label help={program.help}>{program.label}</Label>
                      <MoneyInput
                        ariaLabel={`${activeRow.employeeName} — ${program.label}`}
                        value={accountProgramValueOf(activeRow, program)}
                        onChange={(value) =>
                          setProgramValue(
                            activeRow.employeePartyId,
                            `account:${program.key}`,
                            value,
                          )
                        }
                        field={program.label}
                        noun="a money amount"
                        maxScale={4}
                        placeholder="0.00"
                        disabled={activeRow.locked || !canManage || saving}
                        className="text-right tabular-nums"
                      />
                    </div>
                  ))}
              </div>
              {visibleSuiStates.length > 0 &&
                (activeRow.country == null || activeRow.country === 'US') && (
                  <details className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                    <summary className="cursor-pointer text-sm font-medium">
                      {workspace('stateWages')}
                    </summary>
                    <div className="mt-4 grid gap-4 sm:grid-cols-3">
                      {visibleSuiStates.map((state) => (
                        <div key={state.key} className="space-y-1.5">
                          <Label help={state.help}>{state.label}</Label>
                          <MoneyInput
                            ariaLabel={`${activeRow.employeeName} — ${state.label}`}
                            value={suiValueOf(activeRow, state.key)}
                            onChange={(value) =>
                              setSuiValue(
                                activeRow.employeePartyId,
                                state.key,
                                value,
                              )
                            }
                            field={state.label}
                            noun="a money amount"
                            maxScale={4}
                            placeholder="0.00"
                            disabled={activeRow.locked || !canManage || saving}
                            className="text-right tabular-nums"
                          />
                        </div>
                      ))}
                    </div>
                  </details>
                )}
            </div>
            <div
              hidden={section !== 'caps'}
              className="grid gap-4 sm:grid-cols-2"
            >
              {components.length === 0 && (
                <p className="text-sm text-slate-500">{workspace('noCaps')}</p>
              )}
              {components.map((component) => (
                <div key={component.componentId} className="space-y-1.5">
                  <Label
                    help={
                      component.capped
                        ? text(
                            'componentHelp',
                            'The annual cap already used at your previous payroll system.',
                          )
                        : text(
                            'componentInertHelp',
                            'This component no longer has an annual cap and cannot be edited.',
                          )
                    }
                  >
                    {component.name}
                  </Label>
                  <p className="text-xs text-slate-500">
                    {text('componentCap', 'Annual cap')}:{' '}
                    {component.basisCapAmountPerYear ?? '—'}
                  </p>
                  <MoneyInput
                    ariaLabel={`${activeRow.employeeName} — ${component.name}`}
                    value={componentValueOf(activeRow, component.componentId)}
                    onChange={(value) =>
                      setComponentValue(
                        activeRow.employeePartyId,
                        component.componentId,
                        value,
                      )
                    }
                    field={component.name}
                    noun="a money amount"
                    maxScale={4}
                    placeholder="0.00"
                    disabled={
                      activeRow.locked ||
                      !canManage ||
                      !component.capped ||
                      saving
                    }
                    className="text-right tabular-nums"
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </Drawer>
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
