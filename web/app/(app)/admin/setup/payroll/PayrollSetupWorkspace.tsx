'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Sparkles } from 'lucide-react'
import { Badge, Button, Label, Select } from '@openbooks/ui'
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

export function PayrollSetupWorkspace(props: {
  settings: PayrollSettings
  accounts: { id: string; label: string }[]
  vendors: { id: string; label: string }[]
  systemComponentCount: number
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

  async function seed() {
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'seed-components' }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      toast.success(t('seeded'))
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

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('seed.title')}</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('seed.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          {props.systemComponentCount > 0 && (
            <Badge variant="success">{t('seed.count', { count: props.systemComponentCount })}</Badge>
          )}
          <Button variant="outline" onClick={seed} disabled={busy}>
            <Sparkles size={14} aria-hidden /> {t('seed.action')}
          </Button>
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
