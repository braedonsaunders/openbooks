'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Label, Select } from '@openbooks/ui'
import type { PayrollSettings } from '@openbooks/engine/src/payroll-run.ts'

const ACCOUNT_KEYS = [
  'wageExpenseAccountId',
  'burdenExpenseAccountId',
  'netPayAccountId',
  'cppPayableAccountId',
  'eiPayableAccountId',
  'taxPayableAccountId',
  'vacationPayableAccountId',
] as const

type AccountKey = (typeof ACCOUNT_KEYS)[number]

/** Accounts & posting tab — the orgs.settings.payroll form (accounts, wages destination, CRA vendor). */
export function PayrollSetupWorkspace(props: {
  settings: PayrollSettings
  accounts: { id: string; label: string }[]
  vendors: { id: string; label: string }[]
}) {
  const t = useTranslations('payroll.settingsPage')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [accounts, setAccounts] = useState<Record<AccountKey, string>>(() =>
    Object.fromEntries(ACCOUNT_KEYS.map((key) => [key, props.settings[key] ?? ''])) as Record<AccountKey, string>,
  )
  const [wagesTo, setWagesTo] = useState<'expense' | 'labor_clearing'>(props.settings.wagesTo)
  const [craRemittancePartyId, setCraRemittancePartyId] = useState(props.settings.craRemittancePartyId ?? '')

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...Object.fromEntries(ACCOUNT_KEYS.map((key) => [key, accounts[key] || null])),
          wagesTo,
          craRemittancePartyId: craRemittancePartyId || null,
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      toast.success(t('saved'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('accounts.title')}</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('accounts.description')}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {ACCOUNT_KEYS.map((key) => (
            <div key={key}>
              <Label htmlFor={`ps-${key}`}>{t(`fields.${key}`)}</Label>
              <Select
                id={`ps-${key}`}
                value={accounts[key]}
                onChange={(e) => setAccounts((current) => ({ ...current, [key]: e.target.value }))}
              >
                <option value="">—</option>
                {props.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('posting.title')}</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('posting.description')}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ps-wages-to">{t('fields.wagesTo')}</Label>
            <Select
              id="ps-wages-to"
              value={wagesTo}
              onChange={(e) => setWagesTo(e.target.value === 'labor_clearing' ? 'labor_clearing' : 'expense')}
            >
              <option value="expense">{t('wagesTo.expense')}</option>
              <option value="labor_clearing">{t('wagesTo.laborClearing')}</option>
            </Select>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('wagesTo.help')}</p>
          </div>
          <div>
            <Label htmlFor="ps-cra">{t('fields.craRemittancePartyId')}</Label>
            <Select id="ps-cra" value={craRemittancePartyId} onChange={(e) => setCraRemittancePartyId(e.target.value)}>
              <option value="">—</option>
              {props.vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <Button onClick={save} disabled={busy}>
          {t('save')}
        </Button>
      </div>
    </div>
  )
}
