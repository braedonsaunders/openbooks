'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Alert, AlertDescription, Badge, Button, Input } from '@openbooks/ui'
import type { RemittanceEntitySlice, RemittanceGroup } from '@openbooks/engine/src/payroll/remittance.ts'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { useMoney } from '../../../../components/money-provider'

/**
 * Remittance cockpit: one card per destination (CRA vendor, union funds,
 * unassigned components) and payroll filing account, with the period's accrued
 * amounts per component and a one-click draft vendor bill. Already-raised
 * bills for the same period show inline so a double remittance is an explicit,
 * visible choice.
 */

/** Card identity — mirrors the engine's (destination, filing account) group. */
const groupKey = (partyId: string | null, filingAccountId: string | null) =>
  `${partyId ?? 'unassigned'}::${filingAccountId ?? ''}`

export function RemittancesView({
  groups,
  from,
  to,
  canCreate,
  populationRefusal,
}: {
  groups: RemittanceGroup[]
  from: string
  to: string
  canCreate: boolean
  populationRefusal?: string | null
}) {
  const t = useTranslations('payroll.remittances')
  const router = useRouter()
  const [busyParty, setBusyParty] = useState<string | null>(null)
  const [range, setRange] = useState({ from, to })

  async function createBill(partyId: string, filingAccountId: string | null, subsidiaryId: string | null) {
    setBusyParty(`${groupKey(partyId, filingAccountId)}::${subsidiaryId ?? ''}`)
    try {
      const res = await fetch('/api/payroll/remittances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create-bill',
          partyId,
          filingAccountId,
          subsidiaryId,
          from: range.from,
          to: range.to,
        }),
      })
      // The status is checked before the body is parsed: a non-JSON error body
      // (this route rethrows non-domain errors as an unhandled empty 500) must
      // surface the failure, never a SyntaxError from res.json().
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed to create the remittance bill'))
      const j = await res.json()
      toast.success(t('billCreated', { number: j.documentNumber }))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusyParty(null)
    }
  }

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-2"
        action="/payroll/remittances"
        method="get"
      >
        <label className="text-sm">
          <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">{t('from')}</span>
          <Input type="date" name="from" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-slate-500 dark:text-slate-400">{t('to')}</span>
          <Input type="date" name="to" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
        </label>
        <Button type="submit" variant="outline">{t('apply')}</Button>
      </form>

      {populationRefusal ? (
        <Alert variant="warning">
          <AlertDescription>{populationRefusal}</AlertDescription>
        </Alert>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {t('empty')}
        </div>
      ) : (
        groups.map((group) => (
          <RemittanceGroupCard
            key={groupKey(group.partyId, group.filingAccount.id)}
            group={group}
            canCreate={canCreate}
            busy={busyParty !== null}
            onCreate={(subsidiaryId) => void createBill(group.partyId!, group.filingAccount.id, subsidiaryId)}
          />
        ))
      )}
    </div>
  )
}

/**
 * One destination card. Every amount on it is stated in the group's own
 * currency — a EUR-only scope under a GBP org formats as euros, never
 * pounds — so the formatter is built from the group, not the org. Translated
 * scopes name the presentation currency they were translated into.
 */
function RemittanceGroupCard({
  group,
  canCreate,
  busy,
  onCreate,
}: {
  group: RemittanceGroup
  canCreate: boolean
  busy: boolean
  onCreate: (subsidiaryId: string | null) => void
}) {
  const t = useTranslations('payroll.remittances')
  const { money } = useMoney(group.currency)

  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {group.partyName ?? t('unassigned')}
            {/* A PD7A is filed per payroll program account, so each
                account remits on its own bill. */}
            {group.filingAccount.accountNumber && (
              <Badge variant="outline">
                {group.filingAccount.accountNumber}
                {group.filingAccount.name ? ` · ${group.filingAccount.name}` : ''}
              </Badge>
            )}
            {/* The stated currency of every amount on this card. An ISO code,
                like the account number beside it, is data rather than prose. */}
            {group.currency && (
              <Badge variant="outline">{group.currency}</Badge>
            )}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('context', { gross: money(group.grossPayroll), employees: group.employeeCount })}
          </p>
          {group.translated && (
            <p className="text-xs text-slate-400 dark:text-slate-500">
              {t('translated', { currency: group.currency })}
            </p>
          )}
          {/* A pack-declared destination schedule (Revenu Québec's) dates
              the bill from the destination's own timetable and names the
              rule, so an RQ card never shows — or implies — a CRA date.
              Destinations without a declared schedule show nothing: the
              legacy CRA-function date is stamped at bill creation. */}
          {group.schedule && (
            <>
              <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
                {t('dueOn', { dueDate: group.schedule.dueDate, authority: group.schedule.authority })}
              </p>
              <p className="text-xs text-slate-400 dark:text-slate-500">{group.schedule.rule}</p>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {group.existingBills.map((bill) => (
            <Link
              key={bill.documentId}
              href={`/ap/bills?doc=${bill.documentId}` as never}
              className="inline-flex items-center gap-1.5 text-xs"
            >
              <Badge variant="outline">{bill.documentNumber} · {bill.status}</Badge>
            </Link>
          ))}
          {group.partyId ? (
            canCreate && (
              group.slices.length > 1 ? (
                <span className="flex flex-wrap items-center gap-2">
                  {group.slices.map((slice) => (
                    <SliceBillButton
                      key={slice.subsidiaryId}
                      slice={slice}
                      busy={busy}
                      onCreate={() => onCreate(slice.subsidiaryId)}
                    />
                  ))}
                </span>
              ) : (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => onCreate(
                    group.slices.length === 1 ? group.slices[0]!.subsidiaryId : null,
                  )}
                >
                  {group.existingBills.length > 0 ? t('createAnother') : t('createBill')}
                </Button>
              )
            )
          ) : (
            <Link
              className="text-xs font-medium text-teal-700 underline dark:text-teal-300"
              href={'/admin/setup/payroll?tab=components' as never}
            >
              {t('assignVendor')}
            </Link>
          )}
        </div>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {group.components.map((component) => (
            <tr key={component.componentId} className="border-t border-slate-100 dark:border-slate-800">
              <td className="py-1.5">{component.name}</td>
              <td className="py-1.5 text-xs text-slate-400">
                {component.kind === 'deduction' ? t('withheld') : t('employer')}
              </td>
              <td className="py-1.5 text-xs text-slate-400">{component.accountLabel ?? t('noAccount')}</td>
              <td className="py-1.5 text-right tabular-nums">{money(component.amount)}</td>
            </tr>
          ))}
          <tr className="border-t border-slate-200 font-semibold dark:border-slate-700">
            <td className="py-1.5" colSpan={3}>{t('total')}</td>
            <td className="py-1.5 text-right tabular-nums">{money(group.total)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  )
}

/**
 * One bill button per legal entity. A multi-entity group's card shows the
 * consolidated total above, so each button names its own entity and native
 * share — formatted in the entity's currency, never the org's — or the
 * operator cannot tell the two drafts apart. Single-entity groups keep the
 * historical single button in the card body above.
 */
function SliceBillButton({
  slice,
  busy,
  onCreate,
}: {
  slice: RemittanceEntitySlice
  busy: boolean
  onCreate: () => void
}) {
  const t = useTranslations('payroll.remittances')
  const { money } = useMoney(slice.currency)
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={onCreate}
      title={`${slice.subsidiaryName ?? slice.subsidiaryId} · ${money(slice.total)}`}
    >
      {slice.existingBills.length > 0 ? t('createAnother') : t('createBill')}
      {' · '}
      {slice.subsidiaryName ?? slice.subsidiaryId}
    </Button>
  )
}
