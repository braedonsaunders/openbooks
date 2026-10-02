'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ChevronRight,
  Download,
  Plus,
  Upload,
} from 'lucide-react'
import { Badge, Button, Drawer, FieldHelp, Input, Label } from '@openbooks/ui'
import { apiJson, ApiResponseError } from '../../../../lib/api-error'
import { PagedTable } from '../../../../components/paged-table'
import { MoneyInput, moneyFieldError } from '../../../../components/money-input'
import { isZeroDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'

interface DeclaredLevy {
  country: string
  levyKey: string
  label: string
  description: string
  scope: string
}

interface StoredLevyOpening {
  country: string
  levyKey: string
  region: string | null
  baseYtd: string
}

interface LevySaveError {
  levyKey: string
  region: string | null
  message: string
}

/** The employer-levies save endpoint's response body (success or failure). */
interface LevySaveResult {
  error?: unknown
  errors?: LevySaveError[]
  created?: number
  updated?: number
  deleted?: number
}

interface AddedRegionRow {
  id: number
  country: string
  levyKey: string
  region: string
  baseYtd: string
}

/** Aggregate employer carry-ins have an employer or regional scope, never an employee scope. */
type EmployerLevyOpeningsViewProps = {
  year: number
  levies: DeclaredLevy[]
  rows: StoredLevyOpening[]
  canManage: boolean
  onDirtyChange?: (count: number) => void
}

export function EmployerLevyOpeningsView(props: EmployerLevyOpeningsViewProps) {
  return <EmployerLevyOpeningsYearView key={props.year} {...props} />
}

function EmployerLevyOpeningsYearView({
  year,
  levies,
  rows,
  canManage,
  onDirtyChange,
}: EmployerLevyOpeningsViewProps) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const text = (key: string, fallback: string) =>
    t.has(`openingBalances.employerLevies.${key}` as never)
      ? (t(`openingBalances.employerLevies.${key}` as never) as string)
      : fallback

  // Draft base amounts keyed by levy + region; rows the operator adds for a
  // new region ride in their own list because their key does not exist yet.
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [added, setAdded] = useState<AddedRegionRow[]>([])
  const [nextId, setNextId] = useState(1)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<LevySaveError[]>([])

  const workspace = useTranslations('payroll.openingBalances.workspace')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const activeLevy = levies.find(
    (levy) => `${levy.country}:${levy.levyKey}` === activeKey,
  )

  const rowKey = (country: string, levyKey: string, region: string | null) =>
    `${country}${levyKey}${region ?? ''}`

  const storedFor = (levy: DeclaredLevy) =>
    rows.filter(
      (row) => row.country === levy.country && row.levyKey === levy.levyKey,
    )

  const valueOf = (
    country: string,
    levyKey: string,
    region: string | null,
  ): string => {
    const key = rowKey(country, levyKey, region)
    const edited = draft[key]
    if (edited !== undefined) return edited
    const stored = rows.find(
      (row) =>
        row.country === country &&
        row.levyKey === levyKey &&
        (row.region ?? null) === (region ?? null),
    )?.baseYtd
    if (stored === undefined) return ''
    return isZeroDecimal(stored) ? '' : trimZeros(stored)
  }

  const setAmount = (
    country: string,
    levyKey: string,
    region: string | null,
    value: string,
  ) => {
    const key = rowKey(country, levyKey, region)
    setDraft((current) => ({ ...current, [key]: value }))
  }

  // Every row carrying an amount the operator typed (a blanked cell is a
  // clear only where a carry-in is stored — the service deletes on zero, so
  // a blank over nothing sends nothing).
  const payload = (): {
    country: string
    levyKey: string
    region: string | null
    baseYtd: string
  }[] => {
    const out: {
      country: string
      levyKey: string
      region: string | null
      baseYtd: string
    }[] = []
    for (const [key, value] of Object.entries(draft)) {
      const baseYtd = value.trim()
      if (baseYtd === '') continue
      const [country, levyKey, region] = key.split('')
      out.push({
        country: country!,
        levyKey: levyKey!,
        region: region === '' ? null : (region ?? null),
        baseYtd,
      })
    }
    for (const row of added) {
      if (row.baseYtd.trim() === '') continue
      out.push({
        country: row.country,
        levyKey: row.levyKey,
        region: row.region.trim() === '' ? null : row.region.trim(),
        baseYtd: row.baseYtd.trim(),
      })
    }
    return out
  }

  const dirtyCount = payload().length
  useEffect(() => {
    onDirtyChange?.(dirtyCount)
  }, [dirtyCount, onDirtyChange])

  const save = async () => {
    const body_rows = payload()
    if (body_rows.length === 0) return
    const clientErrors = body_rows.flatMap((row) => {
      const levy = levies.find(
        (candidate) =>
          candidate.country === row.country &&
          candidate.levyKey === row.levyKey,
      )
      const refusal = moneyFieldError(
        levy?.label ?? row.levyKey,
        'a money amount',
        row.baseYtd,
        4,
      )
      return refusal
        ? [{ levyKey: row.levyKey, region: row.region, message: refusal }]
        : []
    })
    if (clientErrors.length) {
      setErrors(clientErrors)
      return
    }
    setSaving(true)
    setErrors([])
    try {
      const body = await apiJson<LevySaveResult>(
        '/api/payroll/opening-balances/employer-levies',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ taxYear: year, rows: body_rows }),
        },
        text('saveFailed', 'Nothing was saved.'),
      )
      setDraft({})
      setAdded([])
      toast.success(
        text('saved', 'Employer carry-ins saved.') +
          ` (${body.created ?? 0} new, ${body.updated ?? 0} updated, ${body.deleted ?? 0} cleared)`,
      )
      router.refresh()
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : text('saveFailed', 'Nothing was saved.')
      const reasons =
        error instanceof ApiResponseError
          ? (error.body as LevySaveResult | null)?.errors
          : undefined
      setErrors(
        reasons?.length ? reasons : [{ levyKey: '', region: null, message }],
      )
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  if (levies.length === 0) return null

  return (
    <section className="space-y-4" id="employer-levies">
      <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
        {text('title', 'Employer carry-ins (aggregate levies)')}
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <FieldHelp
          help={text(
            'hint',
            'The base your previous provider had already counted this year, per employer levy. Without it the first run prices the full annual allowance again. A zero clears a carry-in.',
          )}
        />
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
          {canManage && (
            <Button
              size="sm"
              disabled={saving || dirtyCount === 0}
              onClick={save}
            >
              {saving
                ? text('saving', 'Saving…')
                : `${text('save', 'Save')}${dirtyCount ? ` (${dirtyCount})` : ''}`}
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
              <li key={`${error.levyKey}-${error.region ?? ''}-${index}`}>
                {error.levyKey
                  ? `${error.levyKey}${error.region ? ` (${error.region})` : ''}: `
                  : ''}
                {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-sm text-slate-500 dark:text-slate-400">
        {workspace('employerHint', { year })}
      </p>
      <PagedTable
        source="payroll_opening_levies"
        rows={levies}
        searchable
        pageSize={25}
        rowKey={(levy) => `${levy.country}:${levy.levyKey}`}
        rowLabel={(levy) => levy.label}
        onRowClick={(levy) => setActiveKey(`${levy.country}:${levy.levyKey}`)}
        empty={workspace('noLevies')}
        columns={[
          {
            key: 'levy',
            header: text('levy', 'Levy'),
            search: (levy) =>
              `${levy.label} ${levy.country} ${levy.description} ${storedFor(
                levy,
              )
                .map((row) => row.region)
                .join(' ')}`,
            cell: (levy) => (
              <div>
                <p className="font-medium">{levy.label}</p>
                <p className="max-w-lg text-xs text-slate-500">
                  {levy.description}
                </p>
              </div>
            ),
          },
          {
            key: 'country',
            header: workspace('jurisdiction'),
            cell: (levy) => levy.country,
          },
          {
            key: 'scope',
            header: workspace('scope'),
            cell: (levy) => (
              <div>
                {levy.scope === 'region'
                  ? workspace('regional')
                  : workspace('employer')}
                <p className="text-xs text-slate-400">
                  {storedFor(levy)
                    .map((row) => row.region)
                    .filter(Boolean)
                    .join(', ')}
                </p>
              </div>
            ),
          },
          {
            key: 'status',
            header: workspace('status'),
            cell: (levy) => (
              <Badge variant="outline">
                {Object.keys(draft).some((key) =>
                  key.startsWith(`${levy.country}\u001f${levy.levyKey}\u001f`),
                ) ||
                added.some(
                  (row) =>
                    row.country === levy.country &&
                    row.levyKey === levy.levyKey,
                )
                  ? workspace('unsaved')
                  : storedFor(levy).length
                    ? workspace('recorded')
                    : workspace('noCarryIn')}
              </Badge>
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
        open={!!activeLevy}
        onClose={() => {
          if (!saving) setActiveKey(null)
        }}
        title={activeLevy?.label ?? workspace('employer')}
        description={`${year} · ${activeLevy?.country ?? ''}`}
        size="lg"
        footer={
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">{workspace('draftHint')}</p>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setActiveKey(null)}
            >
              {workspace('done')}
            </Button>
            {canManage && (
              <Button disabled={saving || dirtyCount === 0} onClick={save}>
                {saving
                  ? text('saving', 'Saving…')
                  : `${workspace('saveAll')} (${dirtyCount})`}
              </Button>
            )}
          </div>
        }
      >
        {activeLevy && (
          <div className="space-y-5">
            <p className="text-sm text-slate-500">{activeLevy.description}</p>
            <p className="text-sm text-slate-500">
              {text(
                'hint',
                'The base already counted this year. Enter zero to clear a carry-in.',
              )}
            </p>
            {errors.length > 0 && (
              <div
                role="alert"
                className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
              >
                {errors.map((error, index) => (
                  <p key={index}>
                    {error.levyKey} {error.region} {error.message}
                  </p>
                ))}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {(storedFor(activeLevy).length
                ? storedFor(activeLevy)
                : activeLevy.scope === 'region'
                  ? []
                  : [
                      {
                        country: activeLevy.country,
                        levyKey: activeLevy.levyKey,
                        region: null,
                        baseYtd: '0',
                      },
                    ]
              ).map((row) => (
                <div
                  key={rowKey(row.country, row.levyKey, row.region)}
                  className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-800"
                >
                  <Label>
                    {row.region ?? workspace('employer')} ·{' '}
                    {text('baseYtd', 'Base year-to-date')}
                  </Label>
                  <MoneyInput
                    ariaLabel={`${activeLevy.label} base year-to-date${row.region ? `, ${row.region}` : ''}`}
                    value={valueOf(row.country, row.levyKey, row.region)}
                    onChange={(value) =>
                      setAmount(row.country, row.levyKey, row.region, value)
                    }
                    field={activeLevy.label}
                    noun="a money amount"
                    maxScale={4}
                    disabled={!canManage || saving}
                    className="text-right tabular-nums"
                  />
                </div>
              ))}
              {added
                .filter(
                  (row) =>
                    row.country === activeLevy.country &&
                    row.levyKey === activeLevy.levyKey,
                )
                .map((row) => (
                  <div
                    key={row.id}
                    className="space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800"
                  >
                    <Label>{text('regionLabel', 'Region code')}</Label>
                    <Input
                      aria-label={text('regionLabel', 'Region code')}
                      placeholder={text('regionPlaceholder', 'e.g. ON')}
                      value={row.region}
                      disabled={saving}
                      onChange={(event) =>
                        setAdded((current) =>
                          current.map((candidate) =>
                            candidate.id === row.id
                              ? { ...candidate, region: event.target.value }
                              : candidate,
                          ),
                        )
                      }
                    />
                    <Label>{text('baseYtd', 'Base year-to-date')}</Label>
                    <MoneyInput
                      ariaLabel={`${activeLevy.label} · ${text('newBaseLabel', 'New region base year-to-date')}${row.region ? ` · ${row.region}` : ''}`}
                      value={row.baseYtd}
                      onChange={(value) =>
                        setAdded((current) =>
                          current.map((candidate) =>
                            candidate.id === row.id
                              ? { ...candidate, baseYtd: value }
                              : candidate,
                          ),
                        )
                      }
                      field={activeLevy.label}
                      noun="a money amount"
                      maxScale={4}
                      disabled={saving}
                      className="text-right tabular-nums"
                    />
                  </div>
                ))}
            </div>
            {activeLevy.scope === 'region' && canManage && (
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setNextId(nextId + 1)
                  setAdded((current) => [
                    ...current,
                    {
                      id: nextId,
                      country: activeLevy.country,
                      levyKey: activeLevy.levyKey,
                      region: '',
                      baseYtd: '',
                    },
                  ])
                }}
              >
                <Plus size={14} aria-hidden />
                {text('addRegion', 'Add a region')}
              </Button>
            )}
          </div>
        )}
      </Drawer>
    </section>
  )
}

function trimZeros(value: string): string {
  if (!value.includes('.')) return value
  return value.replace(/0+$/, '').replace(/\.$/, '')
}
