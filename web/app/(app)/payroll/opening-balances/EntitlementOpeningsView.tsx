'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ChevronRight,
  Download,
  Info,
  Lock,
  Upload,
} from 'lucide-react'
import { Badge, Button, Drawer, Input, Label } from '@openbooks/ui'
import {
  canonicalDecimal,
  isZeroDecimal,
} from '@openbooks/engine/src/money/exact-decimal.ts'
import { apiJson, ApiResponseError } from '../../../../lib/api-error'
import { PagedTable } from '../../../../components/paged-table'
import { MoneyInput, moneyFieldError } from '../../../../components/money-input'
import type { EntitlementOpeningsResult } from '@openbooks/engine/src/payroll/entitlements.ts'

interface SaveError {
  employeePartyId: string
  employeeName?: string
  message: string
}

/** Entitlement banks are lifetime balances, dated at adoption rather than by tax year. */
export function EntitlementOpeningsView({
  initial,
  canManage,
  onDirtyChange,
}: {
  initial: EntitlementOpeningsResult
  canManage: boolean
  onDirtyChange?: (count: number) => void
}) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const text = (key: string, fallback: string) =>
    t.has(`openingBalances.entitlements.${key}` as never)
      ? t(`openingBalances.entitlements.${key}` as never)
      : fallback

  const [asOf, setAsOf] = useState(initial.asOf)
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<SaveError[]>([])
  const [warnings, setWarnings] = useState<SaveError[]>([])

  const workspace = useTranslations('payroll.openingBalances.workspace')
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeRow = initial.rows.find((row) => row.employeePartyId === activeId)
  const plans = initial.plans
  const legacyCount = useMemo(
    () =>
      initial.rows.filter((row) => row.legacyVacationBalance !== null).length,
    [initial.rows],
  )
  const vacationPlan = useMemo(
    () => plans.find((plan) => plan.systemKey === 'vacation') ?? null,
    [plans],
  )

  const valueOf = (employeePartyId: string, planId: string): string => {
    const edited = draft[employeePartyId]?.[planId]
    if (edited !== undefined) return edited
    const stored = initial.rows.find(
      (r) => r.employeePartyId === employeePartyId,
    )?.amounts[planId]
    if (stored === undefined) return ''
    return stored !== '' &&
      canonicalDecimal(stored, 4) !== null &&
      isZeroDecimal(stored)
      ? ''
      : trimZeros(stored)
  }

  const setValue = (employeePartyId: string, planId: string, value: string) => {
    setDraft((current) => ({
      ...current,
      [employeePartyId]: {
        ...(current[employeePartyId] ?? {}),
        [planId]: value,
      },
    }))
  }

  const dirtyIds = Object.keys(draft)
  useEffect(() => {
    onDirtyChange?.(dirtyIds.length)
  }, [dirtyIds.length, onDirtyChange])

  const save = async () => {
    if (dirtyIds.length === 0) return
    setSaving(true)
    setErrors([])
    setWarnings([])
    const fallback = text('saveFailed', 'Nothing was saved.')
    try {
      const payload = dirtyIds.map((employeePartyId) => ({
        employeePartyId,
        amounts: draft[employeePartyId] ?? {},
      }))
      // Client-side decimal gate, like the statutory grid above: every
      // EDITED non-blank carry-in names its cause and remedy without a
      // round trip. Blank clears; untouched banks were already accepted.
      const clientErrors: SaveError[] = []
      for (const employeePartyId of dirtyIds) {
        const row = initial.rows.find(
          (r) => r.employeePartyId === employeePartyId,
        )
        for (const plan of plans) {
          const edited = draft[employeePartyId]?.[plan.id]
          if (edited === undefined || edited.trim() === '') continue
          const refusal = moneyFieldError(
            plan.name,
            plan.unit === 'hours' ? 'a number of hours' : 'a money amount',
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
        warnings?: SaveError[]
      }>(
        '/api/payroll/opening-balances/entitlements',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ movementDate: asOf, rows: payload }),
        },
        fallback,
      )
      setDraft({})
      setWarnings(body.warnings ?? [])
      toast.success(
        text('saved', 'Bank carry-ins saved.') +
          ` (${body.created ?? 0} new, ${body.updated ?? 0} updated, ${body.deleted ?? 0} cleared)`,
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

  if (plans.length === 0) {
    return (
      <section className="space-y-3" id="entitlements">
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          {text('title', 'Bank carry-ins (vacation, banked time)')}
        </h2>
        <p className="rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {text(
            'noPlans',
            'No entitlement plans are set up, so there is no bank to carry a balance into.',
          )}{' '}
          <Link
            href={'/admin/setup/entitlement-plans' as never}
            className="underline"
          >
            {text('configurePlans', 'Set up entitlement plans')}
          </Link>
        </p>
      </section>
    )
  }

  return (
    <section className="space-y-4" id="entitlements">
      <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
        {text('title', 'Bank carry-ins (vacation, banked time)')}
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label
            htmlFor="entitlement-openings-asof"
            help={text(
              'asOfHelp',
              'The adoption date the carry-in is dated. A pay run only counts movements dated on or before its pay date, so this must fall before your first pay run here. It is not a tax year: a bank has one lifetime balance.',
            )}
          >
            {text('asOf', 'Carried in as at')}
          </Label>
          <Input
            id="entitlement-openings-asof"
            type="date"
            value={asOf}
            disabled={!canManage || saving}
            className="w-40"
            onChange={(event) => setAsOf(event.target.value)}
          />
        </div>
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

      {legacyCount > 0 && vacationPlan && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
          <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
            <Info size={15} aria-hidden />
            {text('legacyTitle', 'Unmigrated vacation balances found')}
          </p>
          <p className="mt-1 text-amber-700 dark:text-amber-300">
            {text(
              'legacyBody',
              'These employees carry a vacation balance on the retired opening-balances column that no bank shows. It is a liability nobody is tracking. Load it here, or run scripts/migrate-vacation-to-entitlements.ts to replay the whole history.',
            )}{' '}
            ({legacyCount})
          </p>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() =>
                setDraft((current) => {
                  const next = { ...current }
                  for (const row of initial.rows) {
                    if (row.legacyVacationBalance === null) continue
                    next[row.employeePartyId] = {
                      ...(next[row.employeePartyId] ?? {}),
                      [vacationPlan.id]: trimZeros(row.legacyVacationBalance),
                    }
                  }
                  return next
                })
              }
            >
              {text('legacyPrefill', 'Copy them into the Vacation column')}
            </Button>
          )}
        </div>
      )}

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

      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
          <ul className="space-y-1 text-amber-800 dark:text-amber-300">
            {warnings.map((warning, index) => (
              <li key={`${warning.employeePartyId}-${index}`}>
                {warning.employeeName ? `${warning.employeeName}: ` : ''}
                {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-sm text-slate-500 dark:text-slate-400">
        {workspace('bankHint')}
      </p>
      <PagedTable
        source="payroll_opening_banks"
        rows={initial.rows}
        pageSize={25}
        searchable
        rowKey={(row) => row.employeePartyId}
        rowLabel={(row) => row.employeeName}
        onRowClick={(row) => setActiveId(row.employeePartyId)}
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
              <div className="font-medium">
                {row.employeeName}
                <p className="text-xs font-normal text-slate-400">
                  {row.employeeNumber ?? '—'}
                </p>
              </div>
            ),
          },
          {
            key: 'status',
            header: workspace('status'),
            cell: (row) => (
              <Badge variant="outline">
                {dirtyIds.includes(row.employeePartyId)
                  ? workspace('unsaved')
                  : Object.keys(row.amounts).length
                    ? workspace('recorded')
                    : workspace('noCarryIn')}
              </Badge>
            ),
          },
          {
            key: 'banks',
            header: workspace('banks'),
            cell: (row) => Object.keys(row.amounts).length,
          },
          {
            key: 'locks',
            header: workspace('controls'),
            cell: (row) =>
              Object.keys(row.locked).length ? (
                <Badge variant="outline">
                  <Lock size={11} aria-hidden />
                  {Object.keys(row.locked).length} {workspace('lockedBanks')}
                </Badge>
              ) : (
                '—'
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
          if (!saving) setActiveId(null)
        }}
        title={activeRow?.employeeName ?? workspace('banks')}
        description={`${workspace('banks')} · ${asOf}`}
        size="lg"
        footer={
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">{workspace('draftHint')}</p>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setActiveId(null)}
            >
              {workspace('done')}
            </Button>
            {canManage && (
              <Button disabled={saving || dirtyIds.length === 0} onClick={save}>
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
            {initial.blocked[activeRow.employeePartyId] && (
              <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                {text('blocked', 'Paid on')}{' '}
                {initial.blocked[activeRow.employeePartyId]!.payDate} (
                {initial.blocked[activeRow.employeePartyId]!.documentNumber ??
                  '—'}
                ) — {text('blockedHint', 'date the carry-in after it')}
              </p>
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
            {warnings.length > 0 && (
              <div
                role="status"
                className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
              >
                {warnings.map((warning, index) => (
                  <p key={index}>
                    {warning.employeeName ? `${warning.employeeName}: ` : ''}
                    {warning.message}
                  </p>
                ))}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {plans.map((plan) => {
                const lock = activeRow.locked[plan.id]
                return (
                  <div
                    key={plan.id}
                    className="space-y-1.5 rounded-xl border border-slate-200 p-4 dark:border-slate-800"
                  >
                    <Label
                      help={
                        plan.direction === 'owe'
                          ? text(
                              'oweHelp',
                              'A balance the employee owes the employer: enter a negative amount.',
                            )
                          : plan.unit === 'hours'
                            ? text(
                                'hoursHelp',
                                'The balance carried in, in hours.',
                              )
                            : text('moneyHelp', 'The money balance carried in.')
                      }
                    >
                      {plan.name}{' '}
                      <span className="text-xs font-normal text-slate-500">
                        · {plan.unit}
                      </span>
                    </Label>
                    {lock && (
                      <p className="text-xs text-slate-500">
                        <Lock size={11} className="mr-1 inline" aria-hidden />
                        {text('lockedBy', 'Committed pay run')}{' '}
                        {lock.documentNumber} · {lock.payDate}
                      </p>
                    )}
                    <MoneyInput
                      ariaLabel={`${activeRow.employeeName} — ${plan.name}`}
                      value={valueOf(activeRow.employeePartyId, plan.id)}
                      onChange={(value) =>
                        setValue(activeRow.employeePartyId, plan.id, value)
                      }
                      field={plan.name}
                      noun={
                        plan.unit === 'hours'
                          ? 'a number of hours'
                          : 'a money amount'
                      }
                      maxScale={4}
                      placeholder="0.00"
                      disabled={!canManage || lock !== undefined || saving}
                      className="text-right tabular-nums"
                    />
                    {activeRow.dates[plan.id] && (
                      <p className="text-xs text-slate-400">
                        {text('asOf', 'Carried in as at')}{' '}
                        {activeRow.dates[plan.id]}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </Drawer>
    </section>
  )
}

/** 1250.5500 → 1250.55, 40000.0000 → 40000. */
function trimZeros(value: string): string {
  if (!value.includes('.')) return value
  const [whole, fraction = ''] = value.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  if (trimmed === '') return whole!
  return `${whole}.${trimmed.length === 1 ? `${trimmed}0` : trimmed}`
}
