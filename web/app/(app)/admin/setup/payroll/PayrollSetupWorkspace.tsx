'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Label, Select } from '@openbooks/ui'
import type { PayrollSettings } from '@openbooks/engine/src/payroll-run.ts'

// Generic, jurisdiction-free slots only. Statutory liabilities (CPP/EI/income
// tax/…) are declared by the installed country packs and rendered from
// props.packs — nothing statutory is hardcoded here.
const ACCOUNT_KEYS = ['wageExpenseAccountId', 'burdenExpenseAccountId', 'netPayAccountId'] as const

type AccountKey = (typeof ACCOUNT_KEYS)[number]

export interface PackSlots {
  country: string
  slots: { key: string; accountId: string | null }[]
}

/** Accounts & posting tab — generic accounts + pack-declared statutory slots. */
export function PayrollSetupWorkspace(props: {
  settings: PayrollSettings
  packs: PackSlots[]
  accounts: { id: string; label: string }[]
  vendors: { id: string; label: string }[]
}) {
  const t = useTranslations('payroll.settingsPage')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [accounts, setAccounts] = useState<Record<AccountKey, string>>(() =>
    Object.fromEntries(ACCOUNT_KEYS.map((key) => [key, props.settings[key] ?? ''])) as Record<AccountKey, string>,
  )
  const [slotAccounts, setSlotAccounts] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(props.packs.map((pack) => [
      pack.country,
      Object.fromEntries(pack.slots.map((slot) => [slot.key, slot.accountId ?? ''])),
    ])),
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
          slotAccounts: Object.fromEntries(Object.entries(slotAccounts).map(([country, slots]) => [
            country,
            Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, value || null])),
          ])),
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

  const accountPicker = (id: string, value: string, onChange: (next: string) => void) => (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {props.accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.label}
        </option>
      ))}
    </Select>
  )

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
              {accountPicker(`ps-${key}`, accounts[key], (next) =>
                setAccounts((current) => ({ ...current, [key]: next })),
              )}
            </div>
          ))}
        </div>
      </section>

      {props.packs.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          {t('packAccounts.none')}{' '}
          <Link className="font-medium text-teal-700 underline dark:text-teal-300" href={'/admin/setup/payroll?tab=packs' as never}>
            {t('packAccounts.installLink')}
          </Link>
        </section>
      ) : (
        props.packs.map((pack) => (
          <section
            key={pack.country}
            className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
          >
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t(`packAccounts.${pack.country}.title`)}
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t(`packAccounts.${pack.country}.description`)}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {pack.slots.map((slot) => (
                <div key={slot.key}>
                  <Label htmlFor={`ps-slot-${pack.country}-${slot.key}`}>
                    {t(`packAccounts.${pack.country}.slots.${slot.key}`)}
                  </Label>
                  {accountPicker(
                    `ps-slot-${pack.country}-${slot.key}`,
                    slotAccounts[pack.country]?.[slot.key] ?? '',
                    (next) => setSlotAccounts((current) => ({
                      ...current,
                      [pack.country]: { ...current[pack.country], [slot.key]: next },
                    })),
                  )}
                </div>
              ))}
              {pack.country === 'CA' ? (
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
              ) : null}
            </div>
          </section>
        ))
      )}

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
