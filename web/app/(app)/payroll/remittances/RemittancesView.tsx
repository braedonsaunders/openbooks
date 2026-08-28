'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input } from '@openbooks/ui'
import type { RemittanceGroup } from '@openbooks/engine/src/payroll-remittance.ts'
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
}: {
  groups: RemittanceGroup[]
  from: string
  to: string
  canCreate: boolean
}) {
  const t = useTranslations('payroll.remittances')
  const router = useRouter()
  const { money } = useMoney()
  const [busyParty, setBusyParty] = useState<string | null>(null)
  const [range, setRange] = useState({ from, to })

  async function createBill(partyId: string, filingAccountId: string | null) {
    setBusyParty(groupKey(partyId, filingAccountId))
    try {
      const res = await fetch('/api/payroll/remittances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create-bill',
          partyId,
          filingAccountId,
          from: range.from,
          to: range.to,
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
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

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {t('empty')}
        </div>
      ) : (
        groups.map((group) => (
          <section
            key={groupKey(group.partyId, group.filingAccount.id)}
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
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t('context', { gross: money(group.grossPayroll), employees: group.employeeCount })}
                </p>
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
                    <Button
                      size="sm"
                      disabled={busyParty !== null}
                      onClick={() => void createBill(group.partyId!, group.filingAccount.id)}
                    >
                      {group.existingBills.length > 0 ? t('createAnother') : t('createBill')}
                    </Button>
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
        ))
      )}
    </div>
  )
}
