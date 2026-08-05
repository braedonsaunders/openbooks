'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ProfileEditor, type ProfileRow, type ScheduleOption } from './EmployeesPanel'

/**
 * The employee drawer's Payroll tab — the ONE place a payroll profile is
 * edited, living on the native employee entity (no second payroll roster).
 * Loads the profile (or a blank default) + schedules and renders the shared
 * editor inline.
 */
export function PayrollProfileTab({ partyId, partyName }: { partyId: string; partyName: string }) {
  const t = useTranslations('payroll.profiles')
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error'
    profile: ProfileRow | null
    schedules: ScheduleOption[]
  }>({ status: 'loading', profile: null, schedules: [] })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/payroll/profiles?employee=${partyId}`)
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? 'failed')
        if (!cancelled) setState({ status: 'ready', profile: j.profile, schedules: j.schedules ?? [] })
      } catch (e) {
        if (!cancelled) {
          toast.error((e as Error).message)
          setState((s) => ({ ...s, status: 'error' }))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [partyId, version])

  if (state.status === 'loading') {
    return <p className="py-6 text-center text-sm text-slate-400">{t('loading')}</p>
  }
  if (state.status === 'error') {
    return <p className="py-6 text-center text-sm text-slate-400">{t('loadFailed')}</p>
  }
  if (state.schedules.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
        {t('noSchedules')}{' '}
        <Link className="font-medium text-teal-700 underline dark:text-teal-300" href={'/admin/setup/payroll?tab=schedules' as never}>
          {t('openSchedules')}
        </Link>
      </p>
    )
  }

  const profile: ProfileRow = state.profile ?? {
    id: '',
    employee_party_id: partyId,
    employee_name: partyName,
    pay_schedule_id: state.schedules[0]?.id ?? '',
    schedule_name: null,
    country: 'CA',
    province: 'ON',
    pay_basis: 'hourly',
    federal_claim_code: 1,
    federal_claim_amount: null,
    provincial_claim_code: 1,
    provincial_claim_amount: null,
    additional_tax_per_period: null,
    cpp_exempt: false,
    ei_exempt: false,
    tax_exempt: false,
    filing_status: null,
    multiple_jobs: false,
    dependent_credits: null,
    other_income_annual: null,
    deductions_annual: null,
    w4_pre_2020: false,
    w4_allowances: null,
    fica_exempt: false,
    futa_exempt: false,
    vacation_percent: null,
    vacation_method: 'accrue',
    is_active: true,
  }

  return (
    <ProfileEditor
      inline
      profile={profile}
      schedules={state.schedules}
      onClose={() => {}}
      onSaved={() => setVersion((v) => v + 1)}
    />
  )
}
