'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowUpRight,
  CircleCheck,
  Download,
  Scale,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  Badge,
  Button,
  Drawer,
  FieldHelp,
  Input,
  Label,
  Select,
  cn,
} from '@openbooks/ui'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { useMoney } from '../../../../components/money-provider'

/* ------------------------------------------------------------------ */
/* Shapes (mirror engine/src/payroll-parallel-run-store.ts)            */
/* ------------------------------------------------------------------ */

interface UnmappedColumn {
  column: string
  valuedRows: number
}

interface Register {
  id: string
  name: string
  providerName: string | null
  periodStart: string
  periodEnd: string
  payDate: string
  employeeCount: number
  amountCount: number
  statedGross: string
  statedNet: string
  unmappedColumns: UnmappedColumn[]
}

interface PayRun {
  documentId: string
  label: string
  periodStart: string
  periodEnd: string
  payDate: string
  runStatus: string
  employeeCount: number
}

interface Tolerance {
  id?: string
  kind: string
  slot: string
  tolerance: string
  reason: string
}

interface Comparison {
  id: string
  registerId: string
  registerName: string
  payRunDocumentId: string
  payRunNumber: string
  status: string
  blockedReason: string | null
  comparedAt: string
  priorEmployeeCount: number
  ourEmployeeCount: number
  comparedEmployeeCount: number
  matchCount: number
  withinToleranceCount: number
  differenceCount: number
  oneSidedCount: number
  priorGross: string
  ourGross: string
  priorNet: string
  ourNet: string
  grossDifference: string
  netDifference: string
  unattributedNet: string
  tolerancesApplied: Tolerance[]
  unmappedColumns: UnmappedColumn[]
}

interface Finding {
  id: string
  employeePartyId: string | null
  employeeName: string
  kind: string
  slot: string
  slotLabel: string
  classification: string
  priorAmount: string | null
  ourAmount: string | null
  difference: string | null
  toleranceApplied: string
  sourceColumn: string | null
}

interface Slot {
  fieldKey: string
  kind: string
  slot: string
  label: string
}

/**
 * Is a canonical numeric(19,4) string zero?
 *
 * Deliberately NOT `Number(value) === 0`: money never crosses the
 * floating-point boundary in this product, not even to decide the colour of a
 * cell. Every amount reaching this component is already canonical four-decimal
 * text produced by engine/src/money.ts, so a pattern match is both exact and
 * cheaper than a parse.
 */
function isZeroAmount(value: string | null | undefined): boolean {
  return value == null || /^[-+]?0(\.0+)?$/.test(value.trim())
}

/* ------------------------------------------------------------------ */

/**
 * Classification presentation.
 *
 * `match` is the only quiet one. Everything else is a finding, and a one-sided
 * employee is styled as loudly as a material difference on purpose: a parallel
 * run whose populations differ has verified nothing, and that must not read as
 * a smaller problem than a cent.
 */
const CLASS_TONE: Record<string, string> = {
  match: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  within_tolerance: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  difference: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  prior_only: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  our_only: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  employee_prior_only: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  employee_our_only: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  unattributed: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
}

const CLASS_FALLBACK: Record<string, string> = {
  match: 'Exact match',
  within_tolerance: 'Within tolerance',
  difference: 'Difference',
  prior_only: 'Only in the prior system',
  our_only: 'Only here',
  employee_prior_only: 'Employee missing from our run',
  employee_our_only: 'Employee missing from the register',
  unattributed: 'Unexplained by any component',
}

const STATUS_FALLBACK: Record<string, string> = {
  clean: 'Reconciled exactly',
  clean_within_tolerance: 'Reconciled within tolerance',
  differences: 'Differences to resolve',
  no_comparable_data: 'Nothing was compared',
}

const KIND_FALLBACK: Record<string, string> = {
  earning: 'Earning',
  deduction: 'Deduction',
  employer_contribution: 'Employer contribution',
  total: 'Stated total',
}

export function ParallelRunView({
  registers,
  runs,
  comparisons,
  tolerances,
  slots,
  canManage,
}: {
  registers: Register[]
  runs: PayRun[]
  comparisons: Comparison[]
  tolerances: Tolerance[]
  slots: Slot[]
  canManage: boolean
}) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const { money } = useMoney()
  const text = (key: string, fallback: string) =>
    t.has(`parallelRun.${key}` as never) ? t(`parallelRun.${key}` as never) : fallback

  const [registerId, setRegisterId] = useState(registers[0]?.id ?? '')
  const [payRunDocumentId, setPayRunDocumentId] = useState('')
  const [running, setRunning] = useState(false)
  const [openComparison, setOpenComparison] = useState<Comparison | null>(null)
  const [findings, setFindings] = useState<Finding[]>([])
  const [loadingFindings, setLoadingFindings] = useState(false)
  const [employeeFilter, setEmployeeFilter] = useState<string | null>(null)
  const [showMatches, setShowMatches] = useState(false)
  const [toleranceOpen, setToleranceOpen] = useState(false)
  const [liveTolerances, setLiveTolerances] = useState(tolerances)

  const register = registers.find((row) => row.id === registerId) ?? null

  // The run whose PERIOD matches the register. Offered, never assumed: silently
  // pairing a register with the wrong period produces a screen full of
  // differences nobody can explain.
  const suggested = useMemo(() => {
    if (!register) return null
    const exact = runs.filter((run) => run.payDate === register.payDate)
    return exact.length === 1 ? exact[0]! : null
  }, [register, runs])

  const effectiveRunId = payRunDocumentId || suggested?.documentId || ''
  const selectedRun = runs.find((run) => run.documentId === effectiveRunId) ?? null

  const compare = async () => {
    if (!registerId || !effectiveRunId) return
    setRunning(true)
    try {
      const response = await fetch('/api/payroll/parallel-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ registerId, payRunDocumentId: effectiveRunId }),
      })
      const body = (await response.json()) as {
        error?: string
        comparison?: { status: string; blockedReason: string | null }
      }
      if (!response.ok) {
        toast.error(body.error ?? text('compareFailed', 'The comparison could not be run.'))
        return
      }
      const status = body.comparison?.status
      if (status === 'no_comparable_data') {
        toast.error(body.comparison?.blockedReason ?? STATUS_FALLBACK.no_comparable_data!)
      } else if (status === 'clean') {
        toast.success(text('cleanToast', 'Every amount reconciled exactly.'))
      } else if (status === 'clean_within_tolerance') {
        toast.success(text('toleranceToast', 'Reconciled, with a tolerance applied.'))
      } else {
        toast.warning(text('differencesToast', 'Differences found — open the comparison.'))
      }
      router.refresh()
    } finally {
      setRunning(false)
    }
  }

  const openDrawer = async (comparison: Comparison, employeePartyId?: string) => {
    setOpenComparison(comparison)
    setEmployeeFilter(employeePartyId ?? null)
    setLoadingFindings(true)
    setFindings([])
    try {
      const qs = employeePartyId ? `?employeePartyId=${employeePartyId}` : ''
      const response = await fetch(
        `/api/payroll/parallel-run/comparisons/${comparison.id}${qs}`,
      )
      const body = (await response.json()) as { findings?: Finding[]; error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'could not load the comparison')
        return
      }
      setFindings(body.findings ?? [])
    } finally {
      setLoadingFindings(false)
    }
  }

  const discardRegister = async (row: Register) => {
    const response = await fetch(`/api/payroll/parallel-run/registers/${row.id}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      const body = (await response.json()) as { error?: string }
      toast.error(body.error ?? 'could not discard the register')
      return
    }
    toast.success(text('registerDiscarded', 'The imported register was discarded.'))
    router.refresh()
  }

  /* --- comparison list ------------------------------------------------- */

  const comparisonColumns: PagedColumn<Comparison>[] = [
    {
      key: 'status',
      header: text('columns.outcome', 'Outcome'),
      cell: (row) => <StatusBadge status={row.status} text={text} />,
      search: (row) => row.status,
    },
    {
      key: 'register',
      header: text('columns.register', 'Prior register'),
      cell: (row) => (
        <span className="font-medium text-slate-700 dark:text-slate-200">{row.registerName}</span>
      ),
      search: (row) => row.registerName,
    },
    {
      key: 'run',
      header: text('columns.payRun', 'Pay run'),
      cell: (row) => row.payRunNumber,
      search: (row) => row.payRunNumber,
    },
    {
      key: 'population',
      header: (
        <span className="inline-flex items-center gap-1">
          {text('columns.compared', 'Compared')}
          <FieldHelp
            help={text(
              'help.compared',
              'Employees present on BOTH sides, out of each side’s own count. A comparison that compared nobody is reported as “Nothing was compared”, never as agreement.',
            )}
          />
        </span>
      ),
      align: 'right',
      cell: (row) => (
        <span
          className={cn(
            'tabular-nums',
            row.comparedEmployeeCount === 0 && 'font-medium text-red-700 dark:text-red-400',
          )}
        >
          {row.comparedEmployeeCount} / {row.priorEmployeeCount} · {row.ourEmployeeCount}
        </span>
      ),
    },
    {
      key: 'differences',
      header: text('columns.differences', 'Differences'),
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums">
          {row.differenceCount > 0 ? (
            <span className="font-medium text-red-700 dark:text-red-400">{row.differenceCount}</span>
          ) : (
            <span className="text-slate-400">0</span>
          )}
          {row.oneSidedCount > 0 && (
            <span className="ml-2 text-red-700 dark:text-red-400">
              +{row.oneSidedCount} {text('oneSidedShort', 'one-sided')}
            </span>
          )}
          {row.withinToleranceCount > 0 && (
            <span className="ml-2 text-amber-700 dark:text-amber-400">
              {row.withinToleranceCount} {text('toleratedShort', 'tolerated')}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'net',
      header: text('columns.netDifference', 'Net difference'),
      align: 'right',
      cell: (row) => <Delta difference={row.netDifference} money={money} />,
    },
    {
      key: 'when',
      header: text('columns.comparedAt', 'Compared'),
      align: 'right',
      cell: (row) => (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {row.comparedAt.slice(0, 16).replace('T', ' ')}
        </span>
      ),
    },
  ]

  /* --- register list --------------------------------------------------- */

  const registerColumns: PagedColumn<Register>[] = [
    {
      key: 'name',
      header: text('columns.register', 'Prior register'),
      cell: (row) => (
        <div>
          <div className="font-medium text-slate-700 dark:text-slate-200">{row.name}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {row.providerName ? `${row.providerName} · ` : ''}
            {row.periodStart} → {row.periodEnd} · {text('paid', 'paid')} {row.payDate}
          </div>
        </div>
      ),
      search: (row) => `${row.name} ${row.providerName ?? ''}`,
    },
    {
      key: 'rows',
      header: text('columns.loaded', 'Loaded'),
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums">
          {row.employeeCount} {text('employeesShort', 'employees')} · {row.amountCount}{' '}
          {text('amountsShort', 'amounts')}
        </span>
      ),
    },
    {
      key: 'stated',
      header: text('columns.stated', 'Stated gross / net'),
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums">
          {money(row.statedGross)} / {money(row.statedNet)}
        </span>
      ),
    },
    {
      key: 'unmapped',
      header: (
        <span className="inline-flex items-center gap-1">
          {text('columns.unmapped', 'Unmapped columns')}
          <FieldHelp
            help={text(
              'help.unmapped',
              'Columns in your file that no component claimed. Nothing in them is compared, so an amount could be sitting there unaccounted for. Re-import with them mapped, or confirm they carry no money.',
            )}
          />
        </span>
      ),
      cell: (row) =>
        row.unmappedColumns.length === 0 ? (
          <span className="text-xs text-slate-400">{text('allMapped', 'All mapped')}</span>
        ) : (
          <span className="text-xs text-red-700 dark:text-red-400">
            {row.unmappedColumns
              .map((column) => `${column.column} (${column.valuedRows})`)
              .join(', ')}
          </span>
        ),
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right' as const,
            cell: (row: Register) => (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void discardRegister(row)}
                aria-label={text('discard', 'Discard')}
              >
                <Trash2 size={14} aria-hidden />
              </Button>
            ),
          },
        ]
      : []),
  ]

  /* --- findings in the drawer ------------------------------------------ */

  const visibleFindings = showMatches
    ? findings
    : findings.filter((finding) => finding.classification !== 'match')

  const findingColumns: PagedColumn<Finding>[] = [
    {
      key: 'employee',
      header: text('columns.employee', 'Employee'),
      cell: (row) => row.employeeName,
      search: (row) => row.employeeName,
    },
    {
      key: 'component',
      header: text('columns.component', 'Component'),
      cell: (row) => (
        <div>
          <div>{row.slotLabel}</div>
          <div className="text-xs text-slate-400">
            {text(`kinds.${row.kind}`, KIND_FALLBACK[row.kind] ?? row.kind)}
            {row.sourceColumn ? ` · ${text('fromColumn', 'from')} “${row.sourceColumn}”` : ''}
          </div>
        </div>
      ),
      search: (row) => `${row.slotLabel} ${row.slot} ${row.sourceColumn ?? ''}`,
    },
    {
      key: 'prior',
      header: text('columns.priorSystem', 'Prior system'),
      align: 'right',
      cell: (row) => <Amount value={row.priorAmount} money={money} text={text} />,
    },
    {
      key: 'ours',
      header: text('columns.thisSystem', 'This system'),
      align: 'right',
      cell: (row) => <Amount value={row.ourAmount} money={money} text={text} />,
    },
    {
      key: 'difference',
      header: text('columns.difference', 'Difference'),
      align: 'right',
      cell: (row) =>
        row.difference === null ? (
          <span className="text-slate-400">—</span>
        ) : (
          <span
            className={cn(
              'tabular-nums',
              row.classification === 'match'
                ? 'text-slate-400'
                : 'font-medium text-red-700 dark:text-red-400',
            )}
          >
            {money(row.difference)}
          </span>
        ),
    },
    {
      key: 'tolerance',
      header: (
        <span className="inline-flex items-center gap-1">
          {text('columns.tolerance', 'Tolerance')}
          <FieldHelp
            help={text(
              'help.tolerance',
              'Every component compares exactly unless somebody configured an allowance for it. Any allowance in force is shown here and on the comparison, because a tolerance nobody can see would defeat the whole exercise.',
            )}
          />
        </span>
      ),
      align: 'right',
      cell: (row) =>
        isZeroAmount(row.toleranceApplied) ? (
          <span className="text-xs text-slate-400">{text('exact', 'exact')}</span>
        ) : (
          <span className="tabular-nums text-amber-700 dark:text-amber-400">
            ±{money(row.toleranceApplied)}
          </span>
        ),
    },
    {
      key: 'classification',
      header: text('columns.result', 'Result'),
      cell: (row) => <ClassBadge classification={row.classification} text={text} />,
      search: (row) => row.classification,
    },
  ]

  return (
    <div className="space-y-5">
      {/* Compare */}
      <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64">
            <Label
              htmlFor="parallel-register"
              help={text(
                'help.register',
                'A register imported from the payroll system you are leaving — one pay period, one row per employee. Load it through Import & Export, resource “Prior payroll register”, where you map the old system’s column names onto this payroll’s components.',
              )}
            >
              {text('fields.register', 'Prior register')}
            </Label>
            <Select
              id="parallel-register"
              value={registerId}
              onChange={(event) => {
                setRegisterId(event.target.value)
                setPayRunDocumentId('')
              }}
            >
              <option value="">{text('fields.registerPlaceholder', 'Select a register…')}</option>
              {registers.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} — {row.employeeCount} {text('employeesShort', 'employees')}
                </option>
              ))}
            </Select>
          </div>

          <div className="min-w-64">
            <Label
              htmlFor="parallel-run"
              help={text(
                'help.payRun',
                'The run to check against. Calculated runs count: the point of a parallel run is to prove the numbers before the money leaves. A draft run has no stubs and cannot be compared.',
              )}
            >
              {text('fields.payRun', 'Our pay run')}
            </Label>
            <Select
              id="parallel-run"
              value={effectiveRunId}
              onChange={(event) => setPayRunDocumentId(event.target.value)}
            >
              <option value="">{text('fields.payRunPlaceholder', 'Select a pay run…')}</option>
              {runs.map((run) => (
                <option key={run.documentId} value={run.documentId}>
                  {run.label} — {run.periodStart} → {run.periodEnd} ({run.runStatus},{' '}
                  {run.employeeCount} {text('employeesShort', 'employees')})
                </option>
              ))}
            </Select>
          </div>

          {canManage && (
            <Button disabled={!registerId || !effectiveRunId || running} onClick={compare}>
              <Scale size={15} aria-hidden />
              {running ? text('comparing', 'Comparing…') : text('compare', 'Compare')}
            </Button>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={'/data/import' as never}>
                <Upload size={14} aria-hidden />
                {text('importRegister', 'Import a register')}
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={'/data/export' as never}>
                <Download size={14} aria-hidden />
                {text('export', 'Export')}
              </Link>
            </Button>
            {canManage && (
              <Button variant="outline" size="sm" onClick={() => setToleranceOpen(true)}>
                {text('tolerances', 'Tolerances')} ({liveTolerances.length})
              </Button>
            )}
          </div>
        </div>

        {/* Inline text below a control is validation/state only. */}
        {register && selectedRun && register.payDate !== selectedRun.payDate && (
          <p className="mt-3 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle size={15} aria-hidden />
            {text(
              'periodMismatch',
              'These two sides cover different pay dates. Comparing them will report differences that are really a period mismatch.',
            )}
          </p>
        )}
        {register && register.employeeCount === 0 && (
          <p className="mt-3 flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
            <AlertTriangle size={15} aria-hidden />
            {text(
              'emptyRegister',
              'This register holds no employees. A comparison against it will report “Nothing was compared”, not a clean result.',
            )}
          </p>
        )}
        {register && register.unmappedColumns.length > 0 && (
          <p className="mt-3 flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
            <AlertTriangle size={15} aria-hidden />
            {text('unmappedWarning', 'Columns in this register were never mapped:')}{' '}
            {register.unmappedColumns.map((column) => column.column).join(', ')}
          </p>
        )}
        {registers.length === 0 && (
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            {text(
              'noRegisters',
              'No prior register has been imported yet. Start with Import a register.',
            )}
          </p>
        )}
      </section>

      {/* Comparisons */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            {text('comparisonsTitle', 'Comparisons')}
          </h2>
          <Button variant="ghost" size="sm" asChild>
            <Link href={'/reports' as never}>
              {text('openReport', 'Open the reconciliation report')}
              <ArrowUpRight size={14} aria-hidden />
            </Link>
          </Button>
        </div>
        <PagedTable
          rows={comparisons}
          columns={comparisonColumns}
          rowKey={(row) => row.id}
          searchable
          pageSize={10}
          onRowClick={(row) => void openDrawer(row)}
          empty={
            <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
              {text('noComparisons', 'No comparison has been run yet.')}
            </p>
          }
        />
      </section>

      {/* Registers */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {text('registersTitle', 'Imported registers')}
        </h2>
        <PagedTable
          rows={registers}
          columns={registerColumns}
          rowKey={(row) => row.id}
          searchable
          pageSize={10}
          empty={
            <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
              {text('noRegistersRow', 'Nothing imported yet.')}
            </p>
          }
        />
      </section>

      {/* Detail */}
      <Drawer
        open={openComparison !== null}
        onClose={() => setOpenComparison(null)}
        size="2xl"
        title={
          openComparison
            ? `${openComparison.registerName} → ${openComparison.payRunNumber}`
            : undefined
        }
        description={
          openComparison ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge status={openComparison.status} text={text} />
              <span className="text-xs">
                {openComparison.comparedEmployeeCount}{' '}
                {text('comparedOf', 'compared of')} {openComparison.priorEmployeeCount}{' '}
                {text('onRegister', 'on the register')} / {openComparison.ourEmployeeCount}{' '}
                {text('inRun', 'in the run')}
              </span>
            </span>
          ) : undefined
        }
      >
        {openComparison && (
          <div className="space-y-4">
            {openComparison.blockedReason && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
                <p className="flex items-center gap-2 font-medium">
                  <AlertTriangle size={15} aria-hidden />
                  {text('nothingCompared', 'Nothing was compared')}
                </p>
                <p className="mt-1">{openComparison.blockedReason}</p>
              </div>
            )}

            {openComparison.unmappedColumns.length > 0 && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
                <p className="font-medium">
                  {text('unmappedTitle', 'Source columns nobody mapped')}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {openComparison.unmappedColumns.map((column) => (
                    <li key={column.column}>
                      {column.column} —{' '}
                      {text('valuedRows', 'carried a value in')} {column.valuedRows}{' '}
                      {text('rowsShort', 'row(s)')}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {openComparison.tolerancesApplied.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                <p className="font-medium">{text('toleranceTitle', 'Tolerances in force')}</p>
                <ul className="mt-1 space-y-0.5">
                  {openComparison.tolerancesApplied.map((tolerance) => (
                    <li key={`${tolerance.kind}/${tolerance.slot}`}>
                      {tolerance.slot} ±{money(tolerance.tolerance)} — {tolerance.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile
                label={text('tiles.gross', 'Gross')}
                prior={openComparison.priorGross}
                ours={openComparison.ourGross}
                money={money}
                text={text}
              />
              <Tile
                label={text('tiles.net', 'Net')}
                prior={openComparison.priorNet}
                ours={openComparison.ourNet}
                money={money}
                text={text}
              />
              <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                  {text('tiles.unattributed', 'Unexplained net')}
                  <FieldHelp
                    help={text(
                      'help.unattributed',
                      'The part of the net difference the compared components do not account for. Anything other than zero means an amount moved a total with no comparable component behind it — most often a source column nobody mapped.',
                    )}
                  />
                </div>
                <div
                  className={cn(
                    'mt-1 text-lg font-semibold tabular-nums',
                    isZeroAmount(openComparison.unattributedNet)
                      ? 'text-slate-700 dark:text-slate-200'
                      : 'text-red-700 dark:text-red-400',
                  )}
                >
                  {money(openComparison.unattributedNet)}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {text('tiles.cells', 'Cells')}
                </div>
                <div className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                  <span className="font-semibold tabular-nums">{openComparison.matchCount}</span>{' '}
                  {text('matched', 'matched')}
                  {openComparison.differenceCount > 0 && (
                    <>
                      {' · '}
                      <span className="font-semibold tabular-nums text-red-700 dark:text-red-400">
                        {openComparison.differenceCount}
                      </span>{' '}
                      {text('differ', 'differ')}
                    </>
                  )}
                  {openComparison.oneSidedCount > 0 && (
                    <>
                      {' · '}
                      <span className="font-semibold tabular-nums text-red-700 dark:text-red-400">
                        {openComparison.oneSidedCount}
                      </span>{' '}
                      {text('oneSidedShort', 'one-sided')}
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={showMatches ? 'default' : 'outline'}
                size="sm"
                onClick={() => setShowMatches((current) => !current)}
              >
                {text('showMatches', 'Show exact matches')} (
                {findings.filter((finding) => finding.classification === 'match').length})
              </Button>
              {employeeFilter && (
                <Button variant="outline" size="sm" onClick={() => void openDrawer(openComparison)}>
                  {text('clearEmployee', 'All employees')}
                </Button>
              )}
              {openComparison.status === 'clean' && (
                <span className="ml-auto flex items-center gap-1.5 text-sm text-teal-700 dark:text-teal-300">
                  <CircleCheck size={15} aria-hidden />
                  {text(
                    'cleanNote',
                    'Every compared amount agreed to the penny, with no tolerance and no unmapped column.',
                  )}
                </span>
              )}
            </div>

            {loadingFindings ? (
              <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                {text('loading', 'Loading…')}
              </p>
            ) : (
              <PagedTable
                rows={visibleFindings}
                columns={findingColumns}
                rowKey={(row) => row.id}
                searchable
                pageSize={15}
                onRowClick={(row) =>
                  row.employeePartyId && !employeeFilter
                    ? void openDrawer(openComparison, row.employeePartyId)
                    : undefined
                }
                empty={
                  <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    {findings.length === 0
                      ? text('noFindings', 'This comparison has no findings at all.')
                      : text('noExceptions', 'No exceptions — every cell matched exactly.')}
                  </p>
                }
              />
            )}
          </div>
        )}
      </Drawer>

      <ToleranceDrawer
        open={toleranceOpen}
        onClose={() => setToleranceOpen(false)}
        slots={slots}
        tolerances={liveTolerances}
        onChange={setLiveTolerances}
        text={text}
        money={money}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Presentation helpers                                                */
/* ------------------------------------------------------------------ */

function StatusBadge({
  status,
  text,
}: {
  status: string
  text: (key: string, fallback: string) => string
}) {
  const tone =
    status === 'clean'
      ? 'bg-teal-100 text-teal-800 dark:bg-teal-950/60 dark:text-teal-300'
      : status === 'clean_within_tolerance'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
        : 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300'
  return (
    <Badge className={cn('whitespace-nowrap', tone)}>
      {text(`statuses.${status}`, STATUS_FALLBACK[status] ?? status)}
    </Badge>
  )
}

function ClassBadge({
  classification,
  text,
}: {
  classification: string
  text: (key: string, fallback: string) => string
}) {
  return (
    <Badge className={cn('whitespace-nowrap', CLASS_TONE[classification])}>
      {text(`classes.${classification}`, CLASS_FALLBACK[classification] ?? classification)}
    </Badge>
  )
}

/** A missing amount reads as "not present", never as zero. */
function Amount({
  value,
  money,
  text,
}: {
  value: string | null
  money: (value: string) => string
  text: (key: string, fallback: string) => string
}) {
  if (value === null) {
    return (
      <span className="text-xs text-slate-400 italic">{text('notPresent', 'not present')}</span>
    )
  }
  return <span className="tabular-nums">{money(value)}</span>
}

/** The difference is computed by the engine; this only colours it. */
function Delta({
  difference,
  money,
}: {
  difference: string
  money: (value: string) => string
}) {
  return (
    <span
      className={cn(
        'tabular-nums',
        isZeroAmount(difference)
          ? 'text-slate-400'
          : 'font-medium text-red-700 dark:text-red-400',
      )}
    >
      {money(difference)}
    </span>
  )
}

function Tile({
  label,
  prior,
  ours,
  money,
  text,
}: {
  label: string
  prior: string
  ours: string
  money: (value: string) => string
  text: (key: string, fallback: string) => string
}) {
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-sm tabular-nums text-slate-700 dark:text-slate-200">
        {money(prior)}
      </div>
      <div className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
        {text('vsOurs', 'ours')} {money(ours)}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tolerance configuration                                             */
/* ------------------------------------------------------------------ */

/**
 * Per-component tolerance. Zero is the default and removing a row restores it,
 * so the list only ever shows allowances somebody deliberately created — each
 * with the reason that justifies it.
 */
function ToleranceDrawer({
  open,
  onClose,
  slots,
  tolerances,
  onChange,
  text,
  money,
}: {
  open: boolean
  onClose: () => void
  slots: Slot[]
  tolerances: Tolerance[]
  onChange: (next: Tolerance[]) => void
  text: (key: string, fallback: string) => string
  money: (value: string) => string
}) {
  const [slotKey, setSlotKey] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const selected = slots.find((slot) => `${slot.kind}/${slot.slot}` === slotKey) ?? null

  const save = async () => {
    if (!selected) return
    setSaving(true)
    try {
      const response = await fetch('/api/payroll/parallel-run/tolerances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: selected.kind,
          slot: selected.slot,
          tolerance: amount,
          reason,
        }),
      })
      const body = (await response.json()) as { tolerances?: Tolerance[]; error?: string }
      if (!response.ok) {
        toast.error(body.error ?? 'could not save the tolerance')
        return
      }
      onChange(body.tolerances ?? [])
      setSlotKey('')
      setAmount('')
      setReason('')
      toast.success(text('toleranceSaved', 'Tolerance saved.'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (tolerance: Tolerance) => {
    const response = await fetch(
      `/api/payroll/parallel-run/tolerances?kind=${tolerance.kind}&slot=${encodeURIComponent(tolerance.slot)}`,
      { method: 'DELETE' },
    )
    const body = (await response.json()) as { tolerances?: Tolerance[]; error?: string }
    if (!response.ok) {
      toast.error(body.error ?? 'could not remove the tolerance')
      return
    }
    onChange(body.tolerances ?? [])
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title={text('tolerances', 'Tolerances')}
      description={text(
        'tolerancesDescription',
        'Every component compares exactly by default. Add an allowance only where the old system genuinely rounds differently — it will be shown on every comparison that uses it.',
      )}
    >
      <div className="space-y-5">
        <div className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <div>
            <Label
              htmlFor="tolerance-slot"
              help={text(
                'help.toleranceSlot',
                'The component, or one of the register’s stated totals. A tolerance is per employee, per period.',
              )}
            >
              {text('fields.component', 'Component')}
            </Label>
            <Select
              id="tolerance-slot"
              value={slotKey}
              onChange={(event) => setSlotKey(event.target.value)}
            >
              <option value="">{text('fields.componentPlaceholder', 'Select…')}</option>
              {slots.map((slot) => (
                <option key={`${slot.kind}/${slot.slot}`} value={`${slot.kind}/${slot.slot}`}>
                  {slot.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label
              htmlFor="tolerance-amount"
              help={text(
                'help.toleranceAmount',
                'An absolute amount, never a percentage: a percentage of a moving base is how a tolerance quietly grows. Zero removes the allowance.',
              )}
            >
              {text('fields.tolerance', 'Allowance')}
            </Label>
            <Input
              id="tolerance-amount"
              value={amount}
              inputMode="decimal"
              placeholder="0.01"
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
          <div>
            <Label
              htmlFor="tolerance-reason"
              help={text(
                'help.toleranceReason',
                'Required. Agreeing to stop looking at a difference is a decision that has to be attributable to somebody and a reason.',
              )}
            >
              {text('fields.reason', 'Reason')}
            </Label>
            <Input
              id="tolerance-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <Button disabled={!selected || saving || !reason.trim()} onClick={save}>
            {saving ? text('saving', 'Saving…') : text('addTolerance', 'Add tolerance')}
          </Button>
        </div>

        {tolerances.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {text('noTolerances', 'No tolerance is configured — every component compares exactly.')}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {tolerances.map((tolerance) => (
              <li
                key={`${tolerance.kind}/${tolerance.slot}`}
                className="flex items-start justify-between gap-3 py-3"
              >
                <div>
                  <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    {tolerance.slot} ±{money(tolerance.tolerance)}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {tolerance.reason}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void remove(tolerance)}>
                  <Trash2 size={14} aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  )
}
