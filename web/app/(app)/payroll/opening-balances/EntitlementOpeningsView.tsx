'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle, Download, Info, Lock, Upload } from 'lucide-react'
import { Badge, Button, FieldHelp, Input, Label, cn } from '@openbooks/ui'
import type { EntitlementOpeningsResult } from '@openbooks/engine/src/payroll-entitlements.ts'

interface SaveError {
  employeePartyId: string
  employeeName?: string
  message: string
}

/**
 * Opening balances for entitlement PLANS — the vacation and banked-time banks an
 * employee arrives holding at a mid-year adoption.
 *
 * A SIBLING SECTION rather than more columns on the year grid above, and the
 * reason is the key, not the layout. A statutory carry-in is a fact about one
 * employee in one TAX YEAR; a bank has one lifetime balance (the ledger's
 * uniqueness is (org, plan, employee), with no year in it). Putting these in the
 * year-scoped grid would show the same balance under every year in the picker and
 * invite an operator to enter it again for 2027 — doubling a real liability with
 * no error anywhere. The date these carry is the ADOPTION date, which is why this
 * section owns one, and it is a different question from "which tax year".
 *
 * Everything else is deliberately identical to the grid above: one screen for the
 * whole workforce, one Save, the same lock badge on anything a committed run has
 * consumed, and the same refusal from the API behind it.
 */
export function EntitlementOpeningsView({
  initial,
  canManage,
}: {
  initial: EntitlementOpeningsResult
  canManage: boolean
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

  const plans = initial.plans
  const legacyCount = useMemo(
    () => initial.rows.filter((row) => row.legacyVacationBalance !== null).length,
    [initial.rows],
  )
  const vacationPlan = useMemo(
    () => plans.find((plan) => plan.systemKey === 'vacation') ?? null,
    [plans],
  )

  const valueOf = (employeePartyId: string, planId: string): string => {
    const edited = draft[employeePartyId]?.[planId]
    if (edited !== undefined) return edited
    const stored = initial.rows.find((r) => r.employeePartyId === employeePartyId)?.amounts[planId]
    if (stored === undefined) return ''
    return Number(stored) === 0 ? '' : trimZeros(stored)
  }

  const setValue = (employeePartyId: string, planId: string, value: string) => {
    setDraft((current) => ({
      ...current,
      [employeePartyId]: { ...(current[employeePartyId] ?? {}), [planId]: value },
    }))
  }

  const dirtyIds = Object.keys(draft)

  const save = async () => {
    if (dirtyIds.length === 0) return
    setSaving(true)
    setErrors([])
    setWarnings([])
    try {
      const payload = dirtyIds.map((employeePartyId) => ({
        employeePartyId,
        amounts: draft[employeePartyId] ?? {},
      }))
      const response = await fetch('/api/payroll/opening-balances/entitlements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ movementDate: asOf, rows: payload }),
      })
      const body = (await response.json()) as {
        error?: string
        errors?: SaveError[]
        warnings?: SaveError[]
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
      setWarnings(body.warnings ?? [])
      toast.success(
        text('saved', 'Bank carry-ins saved.') +
          ` (${body.created ?? 0} new, ${body.updated ?? 0} updated, ${body.deleted ?? 0} cleared)`,
      )
      router.refresh()
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
          {text('noPlans', 'No entitlement plans are set up, so there is no bank to carry a balance into.')}{' '}
          <Link href={'/admin/setup/entitlement-plans' as never} className="underline">
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
          <Label htmlFor="entitlement-openings-asof" help={text(
            'asOfHelp',
            'The adoption date the carry-in is dated. A pay run only counts movements dated on or before its pay date, so this must fall before your first pay run here. It is not a tax year: a bank has one lifetime balance.',
          )}>
            {text('asOf', 'Carried in as at')}
          </Label>
          <Input
            id="entitlement-openings-asof"
            type="date"
            value={asOf}
            disabled={!canManage}
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
            {text('entered', 'Carried in')}: {initial.entered} / {initial.rows.length}
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

      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="w-full min-w-max text-sm">
          <thead className="bg-slate-50 text-left dark:bg-slate-900">
            <tr>
              <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 font-medium text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                {text('employee', 'Employee')}
              </th>
              {plans.map((plan) => (
                <th
                  key={plan.id}
                  className="px-3 py-2 text-right font-medium whitespace-nowrap text-slate-600 dark:text-slate-300"
                >
                  <span className="inline-flex items-center gap-1">
                    {plan.name}
                    <FieldHelp
                      help={
                        plan.direction === 'owe'
                          ? text(
                              'oweHelp',
                              'A balance the EMPLOYEE owes the employer, so it is negative — enter −1200 for an outstanding 1,200. It is recouped from future pay until it reaches exactly zero.',
                            )
                          : plan.unit === 'hours'
                            ? text('hoursHelp', 'The balance carried in, in hours.')
                            : text(
                                'moneyHelp',
                                'The balance carried in, in dollars. Banks are stored as the money they were earned at, and displayed as hours at the employee’s current wage.',
                              )
                      }
                    />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {initial.rows.length === 0 && (
              <tr>
                <td
                  colSpan={plans.length + 1}
                  className="px-3 py-8 text-center text-slate-400 dark:text-slate-500"
                >
                  {text('empty', 'No employees have an active payroll profile yet.')}
                </td>
              </tr>
            )}
            {initial.rows.map((row) => {
              const blocked = initial.blocked[row.employeePartyId]
              return (
                <tr key={row.employeePartyId}>
                  <td className="sticky left-0 z-10 bg-white px-3 py-1.5 whitespace-nowrap dark:bg-slate-950">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800 dark:text-slate-100">
                        {row.employeeName}
                      </span>
                      {row.employeeNumber && (
                        <span className="text-xs text-slate-400">{row.employeeNumber}</span>
                      )}
                      {row.legacyVacationBalance !== null && (
                        <span className="text-xs text-amber-600 dark:text-amber-400">
                          {text('legacyShort', 'legacy')} {trimZeros(row.legacyVacationBalance)}
                        </span>
                      )}
                    </div>
                    {blocked && (
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {text('blocked', 'Paid on')} {blocked.payDate}
                        {blocked.documentNumber ? ` (${blocked.documentNumber})` : ''} —{' '}
                        {text('blockedHint', 'date the carry-in after it')}
                      </p>
                    )}
                  </td>
                  {plans.map((plan) => {
                    const lock = row.locked[plan.id]
                    return (
                      <td key={plan.id} className="px-2 py-1.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {lock && (
                            <Badge
                              variant="default"
                              title={`${text('lockedBy', 'Committed pay run')} ${lock.documentNumber ?? ''} · ${lock.payDate}`}
                            >
                              <Lock size={11} aria-hidden />
                            </Badge>
                          )}
                          <Input
                            inputMode="decimal"
                            disabled={!canManage || lock !== undefined}
                            aria-label={`${row.employeeName} — ${plan.name}`}
                            className={cn('w-32 text-right tabular-nums')}
                            value={valueOf(row.employeePartyId, plan.id)}
                            placeholder="0.00"
                            onChange={(event) =>
                              setValue(row.employeePartyId, plan.id, event.target.value)
                            }
                          />
                        </div>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
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
