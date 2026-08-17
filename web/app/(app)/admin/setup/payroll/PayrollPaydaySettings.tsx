'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowUpRight, CheckCircle2, CircleAlert } from 'lucide-react'
import { Button, Input, Label } from '@openbooks/ui'
import type { StubPasswordPolicy } from './PayrollSetupWorkspace'

/**
 * Payday tab — how money and stubs actually leave on pay day: the pay-rail
 * fallback (EFT → cheque), the payroll-capable EFT originator profiles
 * (managed in Payment operations — surfaced here read-only, one source of
 * truth), and emailed-stub delivery. Writes go through the same
 * /api/payroll/settings PUT the Accounts workspace uses; the API merges keys,
 * so this tab saves only what it owns.
 */
export function PayrollPaydaySettings(props: {
  paymentMethods: { eftFallbackToCheque: boolean }
  stubPassword: StubPasswordPolicy
  encryptionAvailable: boolean
  bankProfiles: { id: string; name: string; format: string; configured: boolean }[]
}) {
  const t = useTranslations('payroll.settingsPage')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [eftFallbackToCheque, setEftFallbackToCheque] = useState(props.paymentMethods.eftFallbackToCheque)
  const [stubPasswordEnabled, setStubPasswordEnabled] = useState(props.stubPassword.enabled)
  const [stubPasswordExpression, setStubPasswordExpression] = useState(props.stubPassword.expression)

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eftFallbackToCheque,
          stubPassword: { enabled: stubPasswordEnabled, expression: stubPasswordExpression },
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

      {/* Direct-deposit files draw from a payroll-capable originator profile.
          Profiles LIVE in Payment operations (one editable home per setting);
          this panel only reports their state. */}
      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('payday.eftTitle')}</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('payday.eftDescription')}</p>
        </div>
        {props.bankProfiles.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('payday.eftNone')}</p>
        ) : (
          <ul className="space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
            {props.bankProfiles.map((profile) => (
              <li key={profile.id} className="flex items-center gap-2">
                {profile.configured ? (
                  <CheckCircle2 size={15} className="shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
                ) : (
                  <CircleAlert size={15} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                )}
                <span className="min-w-0 truncate">{profile.name}</span>
                <span className="text-xs uppercase text-slate-400">{profile.format}</span>
                {!profile.configured && (
                  <span className="text-xs text-amber-600 dark:text-amber-400">{t('payday.eftNeedsConfig')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <Link
          href={'/admin/setup/payment-operations' as never}
          className="inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
        >
          {t('payday.eftManage')} <ArrowUpRight size={13} aria-hidden />
        </Link>
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
            <Label htmlFor="ps-stub-password" help={t('stubPassword.expressionHelp')}>
              {t('stubPassword.expression')}
            </Label>
            <Input
              id="ps-stub-password"
              value={stubPasswordExpression}
              onChange={(e) => setStubPasswordExpression(e.target.value)}
              placeholder="{surname:3|upper}{dob:MMDDYYYY}"
              autoComplete="off"
            />
          </div>
        ) : null}
      </section>

      <div className="flex justify-end">
        <Button onClick={save} disabled={busy}>
          {t('save')}
        </Button>
      </div>
    </div>
  )
}
