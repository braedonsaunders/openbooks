'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Sparkles, Wand2 } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { PayrollOnboardingWizard, type VendorKeysByCountry } from './PayrollOnboardingWizard'

/**
 * The "Set up payroll" call-to-action and the wizard mount point. `banner`
 * is the first-run hero shown while org-level readiness still has blockers;
 * `button` is the always-available relaunch (adding another country pack,
 * revisiting a step) in the settings page header.
 */
export function PayrollSetupLauncher(props: {
  variant: 'banner' | 'button'
  /** Failing check count from payrollSetupState — the banner's subtitle. */
  missing: number
  vendorKeysByCountry: VendorKeysByCountry
  frequencies: { value: string; labelKey: string }[]
  canManageEntities: boolean
  schedules: { id: string; name: string }[]
  bankProfiles: { id: string; name: string; format: string; configured: boolean }[]
}) {
  const t = useTranslations('payroll.setupWizard')
  const [open, setOpen] = useState(false)

  const wizard = open ? (
    <PayrollOnboardingWizard
      onClose={() => setOpen(false)}
      vendorKeysByCountry={props.vendorKeysByCountry}
      frequencies={props.frequencies}
      canManageEntities={props.canManageEntities}
      schedules={props.schedules}
      bankProfiles={props.bankProfiles}
    />
  ) : null

  if (props.variant === 'button') {
    return (
      <>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Wand2 size={14} aria-hidden /> {t('cta.relaunch')}
        </Button>
        {wizard}
      </>
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-teal-200 bg-gradient-to-r from-teal-50 to-cyan-50 px-4 py-3.5 dark:border-teal-900 dark:from-teal-950/40 dark:to-cyan-950/30">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-500 to-cyan-600 text-white shadow-sm">
          <Sparkles size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cta.title')}</p>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {t('cta.description')}{' '}
            <span className="font-medium text-amber-700 dark:text-amber-400">
              {t('cta.missing', { count: props.missing })}
            </span>
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Sparkles size={14} aria-hidden /> {t('cta.start')}
        </Button>
      </div>
      {wizard}
    </>
  )
}
