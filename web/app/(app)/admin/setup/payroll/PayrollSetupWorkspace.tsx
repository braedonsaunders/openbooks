'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Input, Label, Select } from '@openbooks/ui'
import type { CaPayrollConfig, PayrollSettings, UsPayrollConfig } from '@openbooks/engine/src/payroll-run.ts'
import { US_STATES } from '@openbooks/engine/src/payroll/us/rates.ts'

// Generic, jurisdiction-free slots only. Statutory liabilities (CPP/EI/income
// tax/…) are declared by the installed country packs and rendered from
// props.packs — nothing statutory is hardcoded here.
const ACCOUNT_KEYS = ['wageExpenseAccountId', 'burdenExpenseAccountId', 'netPayAccountId'] as const

type AccountKey = (typeof ACCOUNT_KEYS)[number]

export interface PackSlots {
  country: string
  slots: { key: string; accountId: string | null }[]
}

interface SuiRow {
  state: string
  rate: string
  wageBase: string
}

/** orgs.settings.payroll.stubPassword — the emailed-stub encryption policy. */
export interface StubPasswordPolicy {
  enabled: boolean
  expression: string
}

/** Accounts & posting tab — generic accounts + pack-declared statutory slots. */
export function PayrollSetupWorkspace(props: {
  settings: PayrollSettings
  packs: PackSlots[]
  us: UsPayrollConfig
  ca: CaPayrollConfig
  stubPassword: StubPasswordPolicy
  /** orgs.settings.payroll.eftFallbackToCheque — the cheque safety net. */
  paymentMethods: { eftFallbackToCheque: boolean }
  /** orgs.settings.payroll.statutoryHolidayPay — calculate stat holiday pay. */
  statutoryHolidayPay: boolean
  /** False when the server has no qpdf binary — encryption cannot be enabled. */
  encryptionAvailable: boolean
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
  const [rqRemittancePartyId, setRqRemittancePartyId] = useState(props.settings.rqRemittancePartyId ?? '')
  const [statutoryHolidayPay, setStatutoryHolidayPay] = useState(props.statutoryHolidayPay)
  const usInstalled = props.packs.some((pack) => pack.country === 'US')
  const caInstalled = props.packs.some((pack) => pack.country === 'CA')
  const [ehtEnabled, setEhtEnabled] = useState(props.ca.eht.enabled)
  const [ehtRate, setEhtRate] = useState(props.ca.eht.rate ?? '')
  const [ehtExemption, setEhtExemption] = useState(props.ca.eht.annualExemption ?? '')
  const [futaRate, setFutaRate] = useState(props.us.futaRate ?? '')
  const [eftFallbackToCheque, setEftFallbackToCheque] = useState(props.paymentMethods.eftFallbackToCheque)
  const [stubPasswordEnabled, setStubPasswordEnabled] = useState(props.stubPassword.enabled)
  const [stubPasswordExpression, setStubPasswordExpression] = useState(props.stubPassword.expression)
  const [suiRows, setSuiRows] = useState<SuiRow[]>(() =>
    Object.entries(props.us.sui).map(([state, entry]) => ({
      state, rate: entry.rate, wageBase: entry.wageBase,
    })),
  )

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
          rqRemittancePartyId: rqRemittancePartyId || null,
          eftFallbackToCheque,
          statutoryHolidayPay,
          stubPassword: { enabled: stubPasswordEnabled, expression: stubPasswordExpression },
          slotAccounts: Object.fromEntries(Object.entries(slotAccounts).map(([country, slots]) => [
            country,
            Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, value || null])),
          ])),
          ...(caInstalled
            ? {
                ca: {
                  eht: {
                    enabled: ehtEnabled,
                    rate: ehtRate || null,
                    annualExemption: ehtExemption || null,
                  },
                },
              }
            : {}),
          ...(usInstalled
            ? {
                us: {
                  futaRate: futaRate || null,
                  sui: Object.fromEntries(suiRows
                    .filter((row) => row.state && row.rate && row.wageBase)
                    .map((row) => [row.state, { rate: row.rate, wageBase: row.wageBase }])),
                },
              }
            : {}),
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

      {/* How wages leave the bank. An employee with no approved bank details
          is paid by cheque, not treated as an error; this is the one switch
          that decides what happens when somebody the employer MEANT to pay by
          EFT has none. */}
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('paymentMethods.title')}</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('paymentMethods.description')}</p>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={eftFallbackToCheque}
            onChange={(e) => setEftFallbackToCheque(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
          />
          <span>
            {t('paymentMethods.fallback')}
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              {eftFallbackToCheque
                ? t('paymentMethods.fallbackOn')
                : t('paymentMethods.fallbackOff')}
            </span>
          </span>
        </label>
      </section>

      {/* Statutory holiday pay (calculateStub phase 2). Changes gross pay, so
          it is an explicit org decision; jurisdictions with no declared
          formula refuse by name when a holiday falls in the period. */}
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('statHolidayPay.title')}</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('statHolidayPay.description')}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={statutoryHolidayPay}
            onChange={(e) => setStatutoryHolidayPay(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
          />
          {t('statHolidayPay.enabled')}
        </label>
      </section>

      {/* Emailed stubs carry wage data. The password rule is the employer's
          own — it is published to staff out of band, never by us. */}
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('stubPassword.title')}</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('stubPassword.description')}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={stubPasswordEnabled}
            disabled={!props.encryptionAvailable}
            onChange={(e) => setStubPasswordEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
          />
          {t('stubPassword.enabled')}
        </label>
        {props.encryptionAvailable ? null : (
          <p className="text-xs text-amber-700 dark:text-amber-400">{t('stubPassword.unavailable')}</p>
        )}
        {stubPasswordEnabled ? (
          <div>
            <Label htmlFor="ps-stub-password">{t('stubPassword.expression')}</Label>
            <Input
              id="ps-stub-password"
              value={stubPasswordExpression}
              onChange={(e) => setStubPasswordExpression(e.target.value)}
              placeholder="{surname:3|upper}{dob:MMDDYYYY}"
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('stubPassword.expressionHelp')}</p>
          </div>
        ) : null}
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
                <>
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
                  {/* Revenu Québec: a QC employee's QPP/QPP2/QPIP are remitted
                      on TPZ-1015.R to RQ, never to the CRA — the pack declares
                      the routing; this is only where the vendor is chosen. */}
                  <div>
                    <Label htmlFor="ps-rq">{t('fields.rqRemittancePartyId')}</Label>
                    <Select id="ps-rq" value={rqRemittancePartyId} onChange={(e) => setRqRemittancePartyId(e.target.value)}>
                      <option value="">—</option>
                      {props.vendors.map((vendor) => (
                        <option key={vendor.id} value={vendor.id}>
                          {vendor.label}
                        </option>
                      ))}
                    </Select>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('fields.rqRemittancePartyIdHelp')}</p>
                  </div>
                </>
              ) : null}
            </div>
            {pack.country === 'CA' ? (
              <div className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                <div>
                  <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('caConfig.title')}</h4>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{t('caConfig.description')}</p>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={ehtEnabled}
                    onChange={(e) => setEhtEnabled(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
                  />
                  {t('caConfig.ehtEnabled')}
                </label>
                {ehtEnabled ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="ps-eht-rate">{t('caConfig.ehtRate')}</Label>
                      <Input
                        id="ps-eht-rate"
                        inputMode="decimal"
                        value={ehtRate}
                        onChange={(e) => setEhtRate(e.target.value)}
                        placeholder="1.95"
                      />
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('caConfig.ehtRateHelp')}</p>
                    </div>
                    <div>
                      <Label htmlFor="ps-eht-exemption">{t('caConfig.ehtExemption')}</Label>
                      <Input
                        id="ps-eht-exemption"
                        inputMode="decimal"
                        value={ehtExemption}
                        onChange={(e) => setEhtExemption(e.target.value)}
                        placeholder="1000000"
                      />
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('caConfig.ehtExemptionHelp')}</p>
                    </div>
                  </div>
                ) : null}
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('caConfig.wcbNote')}</p>
              </div>
            ) : null}
            {pack.country === 'US' ? (
              <div className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                <div>
                  <h4 className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('usConfig.title')}</h4>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{t('usConfig.description')}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="ps-futa-rate">{t('usConfig.futaRate')}</Label>
                    <Input
                      id="ps-futa-rate"
                      inputMode="decimal"
                      value={futaRate}
                      onChange={(e) => setFutaRate(e.target.value)}
                      placeholder="0.006"
                    />
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('usConfig.futaRateHelp')}</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{t('usConfig.suiTitle')}</Label>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('usConfig.suiHelp')}</p>
                  {suiRows.map((row, index) => (
                    <div key={index} className="flex flex-wrap items-end gap-2">
                      <div>
                        <Label htmlFor={`ps-sui-state-${index}`}>{t('usConfig.suiState')}</Label>
                        <Select
                          id={`ps-sui-state-${index}`}
                          value={row.state}
                          onChange={(e) => setSuiRows((rows) =>
                            rows.map((r, i) => (i === index ? { ...r, state: e.target.value } : r)))}
                        >
                          <option value="">—</option>
                          {US_STATES.map((state) => (
                            <option key={state} value={state}>{state}</option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor={`ps-sui-rate-${index}`}>{t('usConfig.suiRate')}</Label>
                        <Input
                          id={`ps-sui-rate-${index}`}
                          inputMode="decimal"
                          className="w-28"
                          value={row.rate}
                          onChange={(e) => setSuiRows((rows) =>
                            rows.map((r, i) => (i === index ? { ...r, rate: e.target.value } : r)))}
                          placeholder="0.027"
                        />
                      </div>
                      <div>
                        <Label htmlFor={`ps-sui-base-${index}`}>{t('usConfig.suiWageBase')}</Label>
                        <Input
                          id={`ps-sui-base-${index}`}
                          inputMode="decimal"
                          className="w-32"
                          value={row.wageBase}
                          onChange={(e) => setSuiRows((rows) =>
                            rows.map((r, i) => (i === index ? { ...r, wageBase: e.target.value } : r)))}
                          placeholder="9000"
                        />
                      </div>
                      <Button
                        variant="ghost"
                        onClick={() => setSuiRows((rows) => rows.filter((_, i) => i !== index))}
                      >
                        {t('usConfig.removeState')}
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    onClick={() => setSuiRows((rows) => [...rows, { state: '', rate: '', wageBase: '' }])}
                  >
                    {t('usConfig.addState')}
                  </Button>
                </div>
              </div>
            ) : null}
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
